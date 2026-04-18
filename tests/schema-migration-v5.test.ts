import neo4j, { type Driver } from "neo4j-driver";
import {
  GenericContainer,
  type StartedTestContainer,
  Wait,
} from "testcontainers";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createLogger } from "../src/logger.js";
import { SCHEMA_VERSION, initSchema } from "../src/schema.js";

const NEO4J_PASSWORD = "testpassword";

let container: StartedTestContainer;
let driver: Driver;

beforeAll(async () => {
  container = await new GenericContainer("neo4j:5-community")
    .withEnvironment({ NEO4J_AUTH: `neo4j/${NEO4J_PASSWORD}` })
    .withExposedPorts(7687)
    .withWaitStrategy(Wait.forLogMessage("Bolt enabled on"))
    .start();

  const boltPort = container.getMappedPort(7687);
  driver = neo4j.driver(
    `bolt://localhost:${boltPort}`,
    neo4j.auth.basic("neo4j", NEO4J_PASSWORD),
  );
}, 120_000);

afterAll(async () => {
  await driver?.close();
  await container?.stop();
});

async function reset(): Promise<void> {
  const session = driver.session();
  try {
    await session.run("MATCH (n) DETACH DELETE n");
  } finally {
    await session.close();
  }
}

async function seedV4(): Promise<void> {
  await reset();
  // Create base v4 constraints/indexes by running initSchema once on empty DB
  // (it'll bump straight to current SCHEMA_VERSION). We then roll back the
  // SchemaInfo version to 4 to force migrate_v5 to re-run.
  await initSchema(driver);
  const session = driver.session();
  try {
    await session.run("MATCH (s:SchemaInfo) SET s.version = 4");
  } finally {
    await session.close();
  }
}

describe("migrate_v5", () => {
  it("renames non-conforming Resource namespaces and merges colliding NamespaceConfigs", async () => {
    await seedV4();
    const session = driver.session();
    try {
      // Conforming resource — must be untouched
      await session.run(
        `CREATE (r:Resource {
          id: 'r1', user_id: 'u1', namespace: 'foo',
          entry_type: 'note', title: 't', content: 'c',
          created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z'
        })`,
      );
      // Non-conforming → 'my-ns'
      await session.run(
        `CREATE (r:Resource {
          id: 'r2', user_id: 'u1', namespace: 'My_NS',
          entry_type: 'note', title: 't', content: 'c',
          created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z'
        })`,
      );
      // Empty after normalize → 'default'
      await session.run(
        `CREATE (r:Resource {
          id: 'r3', user_id: 'u1', namespace: '___',
          entry_type: 'note', title: 't', content: 'c',
          created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z'
        })`,
      );

      // Two configs that collide on owner u1 normalized 'my-ns'
      await session.run(
        `CREATE (cfg:NamespaceConfig {
          owner_id: 'u1', namespace: 'My_NS',
          auto_share: true, auto_share_permission: 'read',
          auto_share_user_ids: ['A'], updated_at: '2026-01-01T00:00:00Z'
        })`,
      );
      await session.run(
        `CREATE (cfg:NamespaceConfig {
          owner_id: 'u1', namespace: 'my--ns',
          auto_share: false, auto_share_permission: 'write',
          auto_share_user_ids: ['A','B'], updated_at: '2026-01-02T00:00:00Z'
        })`,
      );
    } finally {
      await session.close();
    }

    const lines: string[] = [];
    const logger = createLogger("info", (l) => lines.push(l));
    await initSchema(driver, logger);

    // Verify renames
    const verify = driver.session();
    try {
      const r1 = await verify.run(
        "MATCH (r:Resource {id:'r1'}) RETURN r.namespace AS ns",
      );
      expect(r1.records[0]?.get("ns")).toBe("foo");

      const r2 = await verify.run(
        "MATCH (r:Resource {id:'r2'}) RETURN r.namespace AS ns",
      );
      expect(r2.records[0]?.get("ns")).toBe("my-ns");

      const r3 = await verify.run(
        "MATCH (r:Resource {id:'r3'}) RETURN r.namespace AS ns",
      );
      expect(r3.records[0]?.get("ns")).toBe("default");

      // Single merged NamespaceConfig
      const cfgs = await verify.run(
        `MATCH (cfg:NamespaceConfig {owner_id:'u1'})
         RETURN cfg.namespace AS ns, cfg.auto_share AS auto_share,
                cfg.auto_share_permission AS perm,
                cfg.auto_share_user_ids AS uids`,
      );
      expect(cfgs.records.length).toBe(1);
      const rec = cfgs.records[0];
      expect(rec?.get("ns")).toBe("my-ns");
      expect(rec?.get("auto_share")).toBe(true);
      expect(rec?.get("perm")).toBe("write");
      expect((rec?.get("uids") as string[]).sort()).toEqual(["A", "B"]);

      // Schema version bumped
      const ver = await verify.run(
        "MATCH (s:SchemaInfo) RETURN s.version AS version",
      );
      expect(neo4j.integer.toNumber(ver.records[0]?.get("version"))).toBe(
        SCHEMA_VERSION,
      );
    } finally {
      await verify.close();
    }

    // Report log line
    const report = lines.find((l) => l.includes("migration_v5_report"));
    expect(report).toBeTruthy();
    const parsed = JSON.parse(report ?? "{}");
    expect(parsed.event).toBe("migration_v5_report");
    expect(parsed.totals.resources_rewritten).toBe(2);
    expect(parsed.totals.configs_merged).toBe(1);
    expect(parsed.totals.groups_with_collisions).toBe(1);
  }, 60_000);

  it("is idempotent — second run is a no-op with empty totals", async () => {
    const lines: string[] = [];
    const logger = createLogger("info", (l) => lines.push(l));
    await initSchema(driver, logger);
    // Should not have emitted a v5 report (version is already 5; migrate_v5
    // does not re-run when gated).
    expect(lines.find((l) => l.includes("migration_v5_report"))).toBeFalsy();
  });
});

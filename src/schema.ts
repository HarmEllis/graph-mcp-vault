import neo4j, { type Driver } from "neo4j-driver";
import { type Logger, noopLogger } from "./logger.js";
import {
  NAMESPACE_REGEX,
  normalizeNamespaceForMigration,
} from "./namespace.js";

// ── Current schema version ────────────────────────────────────────────────────

export const SCHEMA_VERSION = 7;

// ── Base schema statements (idempotent, version-independent) ──────────────────

const BASE_SCHEMA_STATEMENTS = [
  "CREATE CONSTRAINT user_id_unique IF NOT EXISTS FOR (u:User) REQUIRE u.id IS UNIQUE",
  "CREATE CONSTRAINT resource_id_unique IF NOT EXISTS FOR (r:Resource) REQUIRE r.id IS UNIQUE",
  "CREATE INDEX resource_scope IF NOT EXISTS FOR (r:Resource) ON (r.user_id, r.namespace)",
] as const;

// ── Schema version helpers ────────────────────────────────────────────────────

async function getSchemaVersion(driver: Driver): Promise<number> {
  const session = driver.session();
  try {
    const result = await session.run(
      "MATCH (s:SchemaInfo) RETURN s.version AS version",
    );
    if (result.records.length === 0) return 0;
    const record = result.records[0];
    if (!record) return 0;
    const version = record.get("version");
    if (version === null || version === undefined) return 0;
    return neo4j.integer.toNumber(version);
  } finally {
    await session.close();
  }
}

async function setSchemaVersion(
  driver: Driver,
  version: number,
): Promise<void> {
  const session = driver.session();
  try {
    await session.run("MERGE (s:SchemaInfo) SET s.version = $version", {
      version: neo4j.int(version),
    });
  } finally {
    await session.close();
  }
}

// ── Migration v2 ──────────────────────────────────────────────────────────────
//
// Changes introduced in v2:
//   1. Rename property `type` → `entry_type` on all existing Resource nodes.
//   2. Drop the old `resource_type` index (was on `r.type`) and create
//      `resource_entry_type` index on `r.entry_type`.
//   3. Drop the old `resource_text` fulltext index and rebuild it to also
//      include `summary`, `topic`, and `tags`.
//
// All steps are safe to run on an empty database (no-ops when there are no
// Resource nodes, and DROP IF EXISTS is used for indexes).

async function migrate_v2(driver: Driver): Promise<void> {
  const session = driver.session();
  try {
    // 1. Rename property: type → entry_type
    await session.run(
      `MATCH (r:Resource) WHERE r.type IS NOT NULL
       SET r.entry_type = r.type
       REMOVE r.type`,
    );

    // 2. Replace the property index
    await session.run("DROP INDEX resource_type IF EXISTS");
    await session.run(
      "CREATE INDEX resource_entry_type IF NOT EXISTS FOR (r:Resource) ON (r.entry_type)",
    );

    // 3. Rebuild the fulltext index with extended field coverage
    await session.run("DROP INDEX resource_text IF EXISTS");
    await session.run(
      "CREATE FULLTEXT INDEX resource_text IF NOT EXISTS FOR (n:Resource) ON EACH [n.title, n.content, n.summary, n.topic, n.tags]",
    );
  } finally {
    await session.close();
  }
}

// ── Migration v3 ──────────────────────────────────────────────────────────────
//
// Changes introduced in v3:
//   1. Create an index on ENTRY_RELATION.relation_type for typed relation lookups.

async function migrate_v3(driver: Driver): Promise<void> {
  const session = driver.session();
  try {
    await session.run(
      "CREATE INDEX entry_relation_type IF NOT EXISTS FOR ()-[r:ENTRY_RELATION]-() ON (r.relation_type)",
    );
  } finally {
    await session.close();
  }
}

// ── Migration v4 ──────────────────────────────────────────────────────────────
//
// Changes introduced in v4:
//   1. Create unique constraint for NamespaceConfig(owner_id, namespace)
//   2. Rely on the backing unique index created by the constraint.

async function migrate_v4(driver: Driver): Promise<void> {
  const session = driver.session();
  try {
    await session.run(
      "CREATE CONSTRAINT namespace_config_unique IF NOT EXISTS FOR (n:NamespaceConfig) REQUIRE (n.owner_id, n.namespace) IS UNIQUE",
    );
  } finally {
    await session.close();
  }
}

// ── Migration v5 ──────────────────────────────────────────────────────────────
//
// Changes introduced in v5:
//   1. Strict namespace format `^[a-z]+(-[a-z]+)*$` enforced in app code.
//   2. Auto-migrate any non-conforming `Resource.namespace` to its normalized
//      form.
//   3. Auto-migrate `NamespaceConfig.namespace` similarly, merging per-owner
//      collisions permissively (auto_share OR; permission write > read;
//      auto_share_user_ids union).
//   4. Single structured `migration_v5_report` log line at the end.
//   5. Phase-3 validation aborts the version bump on residue (idempotent
//      re-run).

interface ResourceRename {
  from: string;
  to: string;
  count: number;
}

interface ConfigRename {
  owner_id: string;
  from: string;
  to: string;
}

interface ConfigMerge {
  owner_id: string;
  normalized: string;
  sources: string[];
  merged_auto_share: boolean;
}

interface LegacyConfig {
  owner_id: string;
  namespace: string;
  auto_share: boolean;
  auto_share_permission: "read" | "write";
  auto_share_user_ids: string[];
  updated_at?: string;
}

async function migrate_v5(driver: Driver, logger: Logger): Promise<void> {
  const startedAt = Date.now();

  // ── Phase 0: Discover ───────────────────────────────────────────────────
  const discoverSession = driver.session();
  let resourceNamespaces: string[];
  let legacyConfigs: LegacyConfig[];
  try {
    const resourceResult = await discoverSession.run(
      `MATCH (r:Resource) WHERE r.namespace IS NOT NULL
       RETURN DISTINCT r.namespace AS ns`,
    );
    resourceNamespaces = resourceResult.records
      .map((r) => r.get("ns") as string)
      .filter((ns) => typeof ns === "string");

    const configResult = await discoverSession.run(
      `MATCH (cfg:NamespaceConfig)
       RETURN cfg.owner_id AS owner_id,
              cfg.namespace AS namespace,
              cfg.auto_share AS auto_share,
              cfg.auto_share_permission AS auto_share_permission,
              cfg.auto_share_user_ids AS auto_share_user_ids,
              cfg.updated_at AS updated_at`,
    );
    legacyConfigs = configResult.records.map((r) => {
      const perm = r.get("auto_share_permission") as string | null;
      const userIds = r.get("auto_share_user_ids") as string[] | null;
      return {
        owner_id: r.get("owner_id") as string,
        namespace: r.get("namespace") as string,
        auto_share: (r.get("auto_share") as boolean | null) ?? false,
        auto_share_permission: perm === "write" ? "write" : "read",
        auto_share_user_ids: Array.isArray(userIds) ? userIds : [],
        ...(typeof r.get("updated_at") === "string"
          ? { updated_at: r.get("updated_at") as string }
          : {}),
      };
    });
  } finally {
    await discoverSession.close();
  }

  // ── Phase 1: Resource namespace rewrites ────────────────────────────────
  const resourcePairs = resourceNamespaces
    .filter((ns) => !NAMESPACE_REGEX.test(ns))
    .map((from) => ({ from, to: normalizeNamespaceForMigration(from) }))
    .sort((a, b) => a.from.localeCompare(b.from));

  const resourceRenames: ResourceRename[] = [];
  if (resourcePairs.length > 0) {
    const rewriteSession = driver.session();
    try {
      for (const pair of resourcePairs) {
        const result = await rewriteSession.run(
          `MATCH (r:Resource {namespace: $from})
           SET r.namespace = $to
           RETURN count(r) AS n`,
          pair,
        );
        const record = result.records[0];
        const count = record ? neo4j.integer.toNumber(record.get("n")) : 0;
        resourceRenames.push({ from: pair.from, to: pair.to, count });
      }
    } finally {
      await rewriteSession.close();
    }
  }

  // ── Phase 2: NamespaceConfig reconciliation ─────────────────────────────
  // Group by (owner_id, normalized_ns); operate when normalization changes
  // anything OR when multiple legacy rows already exist for the normalized key.
  const groups = new Map<string, LegacyConfig[]>();
  for (const cfg of legacyConfigs) {
    const normalized = NAMESPACE_REGEX.test(cfg.namespace)
      ? cfg.namespace
      : normalizeNamespaceForMigration(cfg.namespace);
    const key = `${cfg.owner_id}\u0000${normalized}`;
    const list = groups.get(key) ?? [];
    list.push(cfg);
    groups.set(key, list);
  }

  const configRenames: ConfigRename[] = [];
  const configMerges: ConfigMerge[] = [];
  let configsRenamed = 0;
  let configsMerged = 0;
  let groupsWithCollisions = 0;

  for (const [key, members] of [...groups.entries()].sort()) {
    const sep = key.indexOf("\u0000");
    const ownerId = key.slice(0, sep);
    const normalized = key.slice(sep + 1);

    const allConforming = members.every((m) => m.namespace === normalized);
    if (allConforming && members.length === 1) continue;

    // Merge
    const mergedAutoShare = members.some((m) => m.auto_share);
    const mergedPermission = members.some(
      (m) => m.auto_share_permission === "write",
    )
      ? "write"
      : "read";
    const mergedUserIds = [
      ...new Set(members.flatMap((m) => m.auto_share_user_ids)),
    ].sort();
    const mergedUpdatedAt =
      members
        .map((m) => m.updated_at)
        .filter((s): s is string => typeof s === "string")
        .sort()
        .pop() ?? new Date().toISOString();

    const session = driver.session();
    try {
      await session.executeWrite(async (tx) => {
        // Delete all legacy configs in the group (and any incident relations).
        await tx.run(
          `UNWIND $sources AS src
           MATCH (cfg:NamespaceConfig {owner_id: $ownerId, namespace: src})
           DETACH DELETE cfg`,
          { ownerId, sources: members.map((m) => m.namespace) },
        );
        await tx.run(
          `CREATE (cfg:NamespaceConfig {
             owner_id: $ownerId,
             namespace: $namespace,
             auto_share: $autoShare,
             auto_share_permission: $autoSharePermission,
             auto_share_user_ids: $autoShareUserIds,
             updated_at: $updatedAt
           })`,
          {
            ownerId,
            namespace: normalized,
            autoShare: mergedAutoShare,
            autoSharePermission: mergedPermission,
            autoShareUserIds: mergedUserIds,
            updatedAt: mergedUpdatedAt,
          },
        );
      });
    } finally {
      await session.close();
    }

    if (members.length > 1) {
      groupsWithCollisions++;
      configsMerged++;
      configMerges.push({
        owner_id: ownerId,
        normalized,
        sources: members.map((m) => m.namespace).sort(),
        merged_auto_share: mergedAutoShare,
      });
    } else {
      const only = members[0];
      if (only && only.namespace !== normalized) {
        configsRenamed++;
        configRenames.push({
          owner_id: ownerId,
          from: only.namespace,
          to: normalized,
        });
      }
    }
  }

  // ── Phase 3: Validate ───────────────────────────────────────────────────
  const validateSession = driver.session();
  try {
    const badResources = await validateSession.run(
      `MATCH (r:Resource)
       WHERE NOT r.namespace =~ '^[a-z]+(-[a-z]+)*$'
       RETURN count(r) AS n`,
    );
    const badConfigs = await validateSession.run(
      `MATCH (cfg:NamespaceConfig)
       WHERE NOT cfg.namespace =~ '^[a-z]+(-[a-z]+)*$'
       RETURN count(cfg) AS n`,
    );
    const badR = neo4j.integer.toNumber(badResources.records[0]?.get("n") ?? 0);
    const badN = neo4j.integer.toNumber(badConfigs.records[0]?.get("n") ?? 0);
    if (badR > 0 || badN > 0) {
      logger.error("migration_v5_failed", {
        bad_resources: badR,
        bad_configs: badN,
      });
      throw new Error(
        `migration_v5 validation failed: bad_resources=${badR}, bad_configs=${badN}`,
      );
    }
  } finally {
    await validateSession.close();
  }

  // ── Phase 4: Structured report ──────────────────────────────────────────
  const resourcesRewritten = resourceRenames.reduce(
    (sum, r) => sum + r.count,
    0,
  );
  logger.info("migration_v5_report", {
    schema_version_from: 4,
    schema_version_to: 5,
    duration_ms: Date.now() - startedAt,
    resource_renames: resourceRenames,
    config_renames: configRenames,
    config_merges: configMerges,
    totals: {
      resources_rewritten: resourcesRewritten,
      configs_renamed: configsRenamed,
      configs_merged: configsMerged,
      groups_with_collisions: groupsWithCollisions,
    },
  });
}

// ── Migration v6 ──────────────────────────────────────────────────────────────
//
// Changes introduced in v6:
//   1. Add unique constraint on ResourceVersion.id.

async function migrate_v6(driver: Driver): Promise<void> {
  const session = driver.session();
  try {
    await session.run(
      "CREATE CONSTRAINT resource_version_id_unique IF NOT EXISTS FOR (v:ResourceVersion) REQUIRE v.id IS UNIQUE",
    );
  } finally {
    await session.close();
  }
}

// ── Migration v7 ──────────────────────────────────────────────────────────────
//
// Changes introduced in v7:
//   1. Deduplicate any (resource_id, version) pairs that arose from the race
//      window before the uniqueness constraint existed (keep latest created_at).
//   2. Add composite uniqueness constraint on (resource_id, version) to prevent
//      duplicate version numbers under concurrent writes.

async function migrate_v7(driver: Driver): Promise<void> {
  // Phase 1: dedup — keep the latest snapshot per (resource_id, version) pair
  const discoverSession = driver.session();
  let toDeleteIds: string[] = [];
  try {
    const dupsResult = await discoverSession.run(`
      MATCH (v:ResourceVersion)
      WITH v.resource_id AS rid, v.version AS ver, collect(v) AS group
      WHERE size(group) > 1
      RETURN rid, ver, group
    `);
    for (const record of dupsResult.records) {
      const group = record.get("group") as Array<{
        properties: { created_at: string; id: string };
      }>;
      const sorted = [...group].sort((a, b) => {
        const byDate = b.properties.created_at.localeCompare(
          a.properties.created_at,
        );
        return byDate !== 0 ? byDate : b.properties.id.localeCompare(a.properties.id);
      });
      for (const v of sorted.slice(1)) {
        toDeleteIds.push(v.properties.id);
      }
    }
  } finally {
    await discoverSession.close();
  }
  if (toDeleteIds.length > 0) {
    const deleteSession = driver.session();
    try {
      await deleteSession.run(
        `UNWIND $ids AS id MATCH (v:ResourceVersion {id: id}) DETACH DELETE v`,
        { ids: toDeleteIds },
      );
    } finally {
      await deleteSession.close();
    }
  }

  // Phase 2: add uniqueness constraint
  const constraintSession = driver.session();
  try {
    await constraintSession.run(
      "CREATE CONSTRAINT resource_version_unique IF NOT EXISTS FOR (v:ResourceVersion) REQUIRE (v.resource_id, v.version) IS UNIQUE",
    );
  } finally {
    await constraintSession.close();
  }
}

// ── initSchema ────────────────────────────────────────────────────────────────

/**
 * Applies all required Neo4j constraints, indexes, and pending migrations.
 *
 * Safe to call multiple times (idempotent). Call once during application
 * startup before accepting traffic.
 *
 * Migration policy: each migration version runs exactly once and is gated
 * on the stored `schema_version` value. Already-migrated instances skip all
 * migration work on subsequent starts.
 */
export async function initSchema(
  driver: Driver,
  logger: Logger = noopLogger,
): Promise<void> {
  // Apply base schema (constraints and structural indexes)
  const baseSession = driver.session();
  try {
    for (const statement of BASE_SCHEMA_STATEMENTS) {
      await baseSession.run(statement);
    }
  } finally {
    await baseSession.close();
  }

  // Run version-gated migrations
  let version = await getSchemaVersion(driver);

  if (version < 2) {
    await migrate_v2(driver);
    await setSchemaVersion(driver, 2);
    version = 2;
  }

  if (version < 3) {
    await migrate_v3(driver);
    await setSchemaVersion(driver, 3);
    version = 3;
  }

  if (version < 4) {
    await migrate_v4(driver);
    await setSchemaVersion(driver, 4);
    version = 4;
  }

  if (version < 5) {
    await migrate_v5(driver, logger);
    await setSchemaVersion(driver, 5);
    version = 5;
  }

  if (version < 6) {
    await migrate_v6(driver);
    await setSchemaVersion(driver, 6);
    version = 6;
  }

  if (version < 7) {
    await migrate_v7(driver);
    await setSchemaVersion(driver, 7);
    version = 7;
  }

  if (version !== SCHEMA_VERSION) {
    throw new Error(
      `Schema version mismatch: expected ${SCHEMA_VERSION}, got ${version}`,
    );
  }
}

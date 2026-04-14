import neo4j, { type Driver } from 'neo4j-driver';

// ── Current schema version ────────────────────────────────────────────────────

const SCHEMA_VERSION = 2;

// ── Base schema statements (idempotent, version-independent) ──────────────────

const BASE_SCHEMA_STATEMENTS = [
  'CREATE CONSTRAINT user_id_unique IF NOT EXISTS FOR (u:User) REQUIRE u.id IS UNIQUE',
  'CREATE CONSTRAINT resource_id_unique IF NOT EXISTS FOR (r:Resource) REQUIRE r.id IS UNIQUE',
  'CREATE INDEX resource_scope IF NOT EXISTS FOR (r:Resource) ON (r.user_id, r.namespace)',
] as const;

// ── Schema version helpers ────────────────────────────────────────────────────

async function getSchemaVersion(driver: Driver): Promise<number> {
  const session = driver.session();
  try {
    const result = await session.run('MATCH (s:SchemaInfo) RETURN s.version AS version');
    if (result.records.length === 0) return 0;
    const record = result.records[0];
    if (!record) return 0;
    const version = record.get('version');
    if (version === null || version === undefined) return 0;
    return neo4j.integer.toNumber(version);
  } finally {
    await session.close();
  }
}

async function setSchemaVersion(driver: Driver, version: number): Promise<void> {
  const session = driver.session();
  try {
    await session.run('MERGE (s:SchemaInfo) SET s.version = $version', {
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
    await session.run('DROP INDEX resource_type IF EXISTS');
    await session.run(
      'CREATE INDEX resource_entry_type IF NOT EXISTS FOR (r:Resource) ON (r.entry_type)',
    );

    // 3. Rebuild the fulltext index with extended field coverage
    await session.run('DROP INDEX resource_text IF EXISTS');
    await session.run(
      'CREATE FULLTEXT INDEX resource_text IF NOT EXISTS FOR (n:Resource) ON EACH [n.title, n.content, n.summary, n.topic, n.tags]',
    );
  } finally {
    await session.close();
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
export async function initSchema(driver: Driver): Promise<void> {
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
  const version = await getSchemaVersion(driver);

  if (version < 2) {
    await migrate_v2(driver);
    await setSchemaVersion(driver, SCHEMA_VERSION);
  }
}

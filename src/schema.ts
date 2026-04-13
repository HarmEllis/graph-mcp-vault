import type { Driver } from 'neo4j-driver';

// ── Schema statements (idempotent) ────────────────────────────────────────────

const SCHEMA_STATEMENTS = [
  'CREATE CONSTRAINT user_id_unique IF NOT EXISTS FOR (u:User) REQUIRE u.id IS UNIQUE',
  'CREATE CONSTRAINT resource_id_unique IF NOT EXISTS FOR (r:Resource) REQUIRE r.id IS UNIQUE',
  'CREATE INDEX resource_scope IF NOT EXISTS FOR (r:Resource) ON (r.user_id, r.namespace)',
  'CREATE INDEX resource_type IF NOT EXISTS FOR (r:Resource) ON (r.type)',
  'CREATE FULLTEXT INDEX resource_text IF NOT EXISTS FOR (n:Resource) ON EACH [n.title, n.content]',
] as const;

/**
 * Applies all required Neo4j constraints and indexes.
 *
 * Every statement uses `IF NOT EXISTS`, so this function is safe to call
 * multiple times (idempotent). Call it once during application startup before
 * accepting traffic.
 */
export async function initSchema(driver: Driver): Promise<void> {
  const session = driver.session();
  try {
    for (const statement of SCHEMA_STATEMENTS) {
      await session.run(statement);
    }
  } finally {
    await session.close();
  }
}

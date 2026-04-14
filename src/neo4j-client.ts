import { randomUUID } from 'node:crypto';
import neo4j, { type Driver } from 'neo4j-driver';

// ── Domain types ──────────────────────────────────────────────────────────────

export interface Resource {
  id: string;
  user_id: string;
  namespace: string;
  type: string;
  title: string;
  content: string;
  created_at: string;
  updated_at: string;
}

export interface ResourceWithOwnership extends Resource {
  ownership: 'owner' | 'shared';
}

export interface SharingEntry {
  user_id: string;
  role: 'viewer' | 'editor';
  granted_at: string;
}

export interface NamespaceSummary {
  namespace: string;
  owned_count: number;
  shared_count: number;
}

// ── Lucene helpers ────────────────────────────────────────────────────────────

/**
 * Escapes Lucene special characters in a user-supplied query string so they
 * are treated as literals rather than query operators.
 *
 * Special characters per the Lucene query syntax reference:
 *   + - && || ! ( ) { } [ ] ^ " ~ * ? : \ /
 */
function escapeLuceneQuery(query: string): string {
  return query.replace(/[+\-&|!(){}[\]^"~*?:\\/]/g, (char) => `\\${char}`);
}

// ── Neo4jClient ───────────────────────────────────────────────────────────────

/**
 * Thin async wrapper around the Neo4j driver.
 *
 * All query logic lives here; tool handlers must never open sessions directly.
 * Properties stored as plain strings (ISO dates, UUIDs) to avoid neo4j.Integer
 * and DateTime conversion concerns in callers.
 */
export class Neo4jClient {
  constructor(private readonly driver: Driver) {}

  // ── Resources ───────────────────────────────────────────────────────────────

  /**
   * Creates a new Resource node and an OWNS relationship from the User.
   * MERGEs the User node so missing users are created on the fly.
   */
  async createResource(params: {
    userId: string;
    namespace: string;
    type: string;
    title: string;
    content: string;
  }): Promise<{ id: string; created_at: string }> {
    const id = randomUUID();
    const now = new Date().toISOString();
    const session = this.driver.session();
    try {
      await session.run(
        `
        MERGE (u:User {id: $userId})
        CREATE (r:Resource {
          id:         $id,
          user_id:    $userId,
          namespace:  $namespace,
          type:       $type,
          title:      $title,
          content:    $content,
          created_at: $now,
          updated_at: $now
        })
        CREATE (u)-[:OWNS]->(r)
        `,
        {
          userId: params.userId,
          id,
          namespace: params.namespace,
          type: params.type,
          title: params.title,
          content: params.content,
          now,
        },
      );
      return { id, created_at: now };
    } finally {
      await session.close();
    }
  }

  /** Returns the Resource with the given id, or null if it does not exist. */
  async getResource(resourceId: string): Promise<Resource | null> {
    const session = this.driver.session();
    try {
      const result = await session.run('MATCH (r:Resource {id: $id}) RETURN r', { id: resourceId });
      if (result.records.length === 0) return null;
      const record = result.records[0];
      if (!record) return null;
      return record.get('r').properties as Resource;
    } finally {
      await session.close();
    }
  }

  /**
   * Returns all resources the user can read (owned + shared via HAS_ACCESS),
   * optionally filtered by namespace and/or type, with pagination.
   */
  async listResources(params: {
    userId: string;
    namespace?: string;
    type?: string;
    limit?: number;
    skip?: number;
  }): Promise<ResourceWithOwnership[]> {
    const limit = params.limit ?? 50;
    const skip = params.skip ?? 0;
    const session = this.driver.session();
    try {
      const result = await session.run(
        `
        MATCH (u:User {id: $userId})-[:OWNS|HAS_ACCESS]->(r:Resource)
        WHERE ($namespace IS NULL OR r.namespace = $namespace)
          AND ($type IS NULL OR r.type = $type)
        RETURN r,
          CASE WHEN (u)-[:OWNS]->(r) THEN 'owner' ELSE 'shared' END AS ownership
        ORDER BY r.updated_at DESC
        SKIP $skip LIMIT $limit
        `,
        {
          userId: params.userId,
          namespace: params.namespace ?? null,
          type: params.type ?? null,
          skip: neo4j.int(skip),
          limit: neo4j.int(limit),
        },
      );
      return result.records.map((record) => ({
        ...(record.get('r').properties as Resource),
        ownership: record.get('ownership') as 'owner' | 'shared',
      }));
    } finally {
      await session.close();
    }
  }

  /**
   * Updates mutable fields (title and/or content) of an existing Resource.
   * Always sets updated_at to the current time.
   */
  async updateResource(
    resourceId: string,
    params: { title?: string; content?: string },
  ): Promise<void> {
    const now = new Date().toISOString();
    const session = this.driver.session();
    try {
      await session.run(
        `
        MATCH (r:Resource {id: $id})
        SET r.updated_at = $now
          ${params.title !== undefined ? ', r.title = $title' : ''}
          ${params.content !== undefined ? ', r.content = $content' : ''}
        `,
        {
          id: resourceId,
          now,
          ...(params.title !== undefined ? { title: params.title } : {}),
          ...(params.content !== undefined ? { content: params.content } : {}),
        },
      );
    } finally {
      await session.close();
    }
  }

  /** DETACH DELETEs the Resource node, removing all relationships. */
  async deleteResource(resourceId: string): Promise<void> {
    const session = this.driver.session();
    try {
      await session.run('MATCH (r:Resource {id: $id}) DETACH DELETE r', { id: resourceId });
    } finally {
      await session.close();
    }
  }

  // ── Search ───────────────────────────────────────────────────────────────────

  /**
   * Full-text search over resource title and content.
   *
   * Uses the `resource_text` fulltext index. Results are ordered by relevance
   * score descending, then by `updated_at` descending for stability.
   * Only returns resources the caller can read (owned + shared via HAS_ACCESS).
   *
   * User-supplied query strings are Lucene-escaped before being passed to the
   * index so that special characters (`(`, `*`, `:`, etc.) are treated as
   * literals rather than operators, preventing parse errors.
   */
  async searchResources(params: {
    userId: string;
    query: string;
    namespace?: string;
    type?: string;
    limit?: number;
    skip?: number;
  }): Promise<ResourceWithOwnership[]> {
    const limit = params.limit ?? 20;
    const skip = params.skip ?? 0;
    const session = this.driver.session();
    try {
      const result = await session.run(
        `
        CALL db.index.fulltext.queryNodes('resource_text', $query) YIELD node AS r, score
        MATCH (u:User {id: $userId})-[:OWNS|HAS_ACCESS]->(r)
        WHERE ($namespace IS NULL OR r.namespace = $namespace)
          AND ($type IS NULL OR r.type = $type)
        RETURN r,
          CASE WHEN (u)-[:OWNS]->(r) THEN 'owner' ELSE 'shared' END AS ownership,
          score
        ORDER BY score DESC, r.updated_at DESC
        SKIP $skip LIMIT $limit
        `,
        {
          userId: params.userId,
          query: escapeLuceneQuery(params.query),
          namespace: params.namespace ?? null,
          type: params.type ?? null,
          skip: neo4j.int(skip),
          limit: neo4j.int(limit),
        },
      );
      return result.records.map((record) => ({
        ...(record.get('r').properties as Resource),
        ownership: record.get('ownership') as 'owner' | 'shared',
      }));
    } finally {
      await session.close();
    }
  }

  // ── Roles ────────────────────────────────────────────────────────────────────

  /**
   * Returns the effective role of `userId` on `resourceId`:
   * - `'owner'` if the user has an OWNS relationship to the resource
   * - `'editor'` or `'viewer'` if the user has a matching HAS_ACCESS relationship
   * - `null` if the user has no relationship to the resource
   */
  async getEffectiveRole(
    userId: string,
    resourceId: string,
  ): Promise<'owner' | 'editor' | 'viewer' | null> {
    const session = this.driver.session();
    try {
      const result = await session.run(
        `
        MATCH (r:Resource {id: $resourceId})
        OPTIONAL MATCH (u:User {id: $userId})-[:OWNS]->(r)
        OPTIONAL MATCH (u2:User {id: $userId})-[acc:HAS_ACCESS]->(r)
        RETURN
          CASE
            WHEN u  IS NOT NULL THEN 'owner'
            WHEN acc IS NOT NULL THEN acc.role
            ELSE null
          END AS role
        `,
        { userId, resourceId },
      );
      if (result.records.length === 0) return null;
      const record = result.records[0];
      if (!record) return null;
      const role = record.get('role') as string | null;
      if (role === 'owner' || role === 'editor' || role === 'viewer') return role;
      return null;
    } finally {
      await session.close();
    }
  }

  // ── Sharing ──────────────────────────────────────────────────────────────────

  /**
   * Grants `targetUserId` the given `role` on `resourceId`.
   * MERGEs the target User node (creates it if absent).
   * The HAS_ACCESS relationship is also MERGEd, so calling this again with a
   * different role simply updates the existing relationship (idempotent).
   */
  async shareResource(
    resourceId: string,
    targetUserId: string,
    role: 'viewer' | 'editor',
  ): Promise<void> {
    const now = new Date().toISOString();
    const session = this.driver.session();
    try {
      await session.run(
        `
        MATCH (r:Resource {id: $resourceId})
        MERGE (u:User {id: $targetUserId})
        MERGE (u)-[acc:HAS_ACCESS]->(r)
        SET acc.role = $role, acc.granted_at = $now
        `,
        { resourceId, targetUserId, role, now },
      );
    } finally {
      await session.close();
    }
  }

  /**
   * Removes the HAS_ACCESS relationship between `targetUserId` and the resource.
   * No-op if the relationship does not exist.
   */
  async revokeAccess(resourceId: string, targetUserId: string): Promise<void> {
    const session = this.driver.session();
    try {
      await session.run(
        `
        MATCH (u:User {id: $targetUserId})-[acc:HAS_ACCESS]->(r:Resource {id: $resourceId})
        DELETE acc
        `,
        { targetUserId, resourceId },
      );
    } finally {
      await session.close();
    }
  }

  /**
   * Returns namespace-level aggregated counts for all resources the user can access.
   *
   * Two-pass aggregation:
   *   1. Count resources the user owns per namespace (OWNS relationships).
   *   2. Count resources the user can access but does not own per namespace
   *      (HAS_ACCESS WHERE NOT OWNS), to prevent owner/self-share double counting.
   *
   * Note: the two passes are non-atomic under concurrent writes — a resource
   * created between the two queries may appear in one count but not the other.
   *
   * Results are returned in deterministic alphabetical order by namespace.
   */
  async listNamespaces(params: { userId: string }): Promise<NamespaceSummary[]> {
    const session = this.driver.session();
    try {
      const ownedResult = await session.run(
        `
        MATCH (u:User {id: $userId})-[:OWNS]->(r:Resource)
        RETURN r.namespace AS namespace, count(r) AS owned_count
        `,
        { userId: params.userId },
      );

      const sharedResult = await session.run(
        `
        MATCH (u:User {id: $userId})-[:HAS_ACCESS]->(r:Resource)
        WHERE NOT (u)-[:OWNS]->(r)
        RETURN r.namespace AS namespace, count(r) AS shared_count
        `,
        { userId: params.userId },
      );

      const map = new Map<string, NamespaceSummary>();

      for (const record of ownedResult.records) {
        const namespace = record.get('namespace') as string;
        const owned_count = neo4j.integer.toNumber(record.get('owned_count'));
        map.set(namespace, { namespace, owned_count, shared_count: 0 });
      }

      for (const record of sharedResult.records) {
        const namespace = record.get('namespace') as string;
        const shared_count = neo4j.integer.toNumber(record.get('shared_count'));
        const existing = map.get(namespace);
        if (existing) {
          existing.shared_count = shared_count;
        } else {
          map.set(namespace, { namespace, owned_count: 0, shared_count });
        }
      }

      return [...map.values()].sort((a, b) => a.namespace.localeCompare(b.namespace));
    } finally {
      await session.close();
    }
  }

  /**
   * Returns all HAS_ACCESS grants on the resource (does not include the owner).
   */
  async listSharing(resourceId: string): Promise<SharingEntry[]> {
    const session = this.driver.session();
    try {
      const result = await session.run(
        `
        MATCH (u:User)-[acc:HAS_ACCESS]->(r:Resource {id: $resourceId})
        RETURN u.id AS user_id, acc.role AS role, acc.granted_at AS granted_at
        `,
        { resourceId },
      );
      return result.records.map((record) => ({
        user_id: record.get('user_id') as string,
        role: record.get('role') as 'viewer' | 'editor',
        granted_at: record.get('granted_at') as string,
      }));
    } finally {
      await session.close();
    }
  }
}

import { randomUUID } from 'node:crypto';
import neo4j, { type Driver } from 'neo4j-driver';

// ── Domain types ──────────────────────────────────────────────────────────────

export interface Resource {
  id: string;
  user_id: string;
  namespace: string;
  entry_type: string;
  title: string;
  content: string;
  created_at: string;
  updated_at: string;
  topic?: string;
  tags?: string[];
  summary?: string;
  source?: string;
  last_verified_at?: string;
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

export type MatchMode = 'exact' | 'fulltext' | 'fuzzy';
export type EntryRelationDirection = 'outbound' | 'inbound' | 'both';

export interface EntryRelation {
  direction: 'outbound' | 'inbound';
  relation_type: string;
  label?: string;
  entry: {
    id: string;
    title: string;
  };
}

export const ENTRY_RELATION_TYPE_REGEX = /^[A-Z][A-Z0-9_]{1,63}$/;
export type Neo4jClientErrorCode = 'INVALID_PARAMS' | 'RESOURCE_NOT_FOUND' | 'PERMISSION_DENIED';

export class Neo4jClientError extends Error {
  constructor(
    public readonly code: Neo4jClientErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'Neo4jClientError';
  }
}

// ── Lucene helpers ────────────────────────────────────────────────────────────

/**
 * Escapes Lucene special characters in a user-supplied string so they
 * are treated as literals rather than query operators.
 *
 * Special characters per the Lucene query syntax reference:
 *   + - && || ! ( ) { } [ ] ^ " ~ * ? : \ /
 */
function escapeLuceneQuery(query: string): string {
  return query.replace(/[+\-&|!(){}[\]^"~*?:\\/]/g, (char) => `\\${char}`);
}

/**
 * Builds a Lucene phrase query by escaping the raw query and wrapping it
 * in double quotes, producing an exact phrase match.
 */
function buildExactQuery(query: string): string {
  return `"${escapeLuceneQuery(query)}"`;
}

/**
 * Builds a fuzzy Lucene query from a user-supplied string:
 *  1. Tokenise on whitespace.
 *  2. Remove bare Lucene boolean operators (AND, OR, NOT).
 *  3. Escape special characters per token.
 *  4. Apply edit-distance suffix:
 *       < 3 chars  → no suffix (too short for meaningful fuzzy)
 *       3–5 chars  → ~1  (1 edit)
 *       > 5 chars  → ~2  (2 edits)
 *
 * Returns null when all tokens are filtered out (caller should short-circuit
 * and return an empty result set without hitting the index).
 */
function buildFuzzyQuery(query: string): string | null {
  const BOOLEAN_OPS = new Set(['AND', 'OR', 'NOT']);

  const rawTokens = query.split(/\s+/).filter((t) => t.length > 0);
  const filtered = rawTokens.filter((t) => !BOOLEAN_OPS.has(t));

  if (filtered.length === 0) return null;

  return filtered
    .map((rawToken) => {
      const escaped = escapeLuceneQuery(rawToken);
      const len = rawToken.length;
      if (len < 3) return escaped;
      if (len <= 5) return `${escaped}~1`;
      return `${escaped}~2`;
    })
    .join(' ');
}

/**
 * Dispatches to the appropriate Lucene query builder based on `mode`.
 * Returns null only in fuzzy mode when all tokens are filtered out.
 */
function buildLuceneQuery(query: string, mode: MatchMode): string | null {
  switch (mode) {
    case 'exact':
      return buildExactQuery(query);
    case 'fulltext':
      return escapeLuceneQuery(query);
    case 'fuzzy':
      return buildFuzzyQuery(query);
  }
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

  private static hasReadPermission(role: 'owner' | 'editor' | 'viewer' | null): boolean {
    return role === 'owner' || role === 'editor' || role === 'viewer';
  }

  // ── Resources ───────────────────────────────────────────────────────────────

  /**
   * Creates a new Resource node and an OWNS relationship from the User.
   * MERGEs the User node so missing users are created on the fly.
   */
  async createResource(params: {
    userId: string;
    namespace: string;
    entry_type: string;
    title: string;
    content: string;
    topic?: string;
    tags?: string[];
    summary?: string;
    source?: string;
    last_verified_at?: string;
  }): Promise<{ id: string; created_at: string }> {
    const id = randomUUID();
    const now = new Date().toISOString();

    const optionalProps: Record<string, unknown> = {};
    if (params.topic !== undefined) optionalProps['topic'] = params.topic;
    if (params.tags !== undefined) optionalProps['tags'] = params.tags;
    if (params.summary !== undefined) optionalProps['summary'] = params.summary;
    if (params.source !== undefined) optionalProps['source'] = params.source;
    if (params.last_verified_at !== undefined) optionalProps['last_verified_at'] = params.last_verified_at;

    const session = this.driver.session();
    try {
      await session.run(
        `
        MERGE (u:User {id: $userId})
        CREATE (r:Resource {
          id:         $id,
          user_id:    $userId,
          namespace:  $namespace,
          entry_type: $entry_type,
          title:      $title,
          content:    $content,
          created_at: $now,
          updated_at: $now
        })
        SET r += $optionalProps
        CREATE (u)-[:OWNS]->(r)
        `,
        {
          userId: params.userId,
          id,
          namespace: params.namespace,
          entry_type: params.entry_type,
          title: params.title,
          content: params.content,
          now,
          optionalProps,
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
   * optionally filtered by namespace and/or entry_type, with pagination.
   */
  async listResources(params: {
    userId: string;
    namespace?: string;
    entry_type?: string;
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
          AND ($entry_type IS NULL OR r.entry_type = $entry_type)
        RETURN r,
          CASE WHEN (u)-[:OWNS]->(r) THEN 'owner' ELSE 'shared' END AS ownership
        ORDER BY r.updated_at DESC
        SKIP $skip LIMIT $limit
        `,
        {
          userId: params.userId,
          namespace: params.namespace ?? null,
          entry_type: params.entry_type ?? null,
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
   * Updates mutable fields of an existing Resource.
   * Always sets updated_at to the current time.
   */
  async updateResource(
    resourceId: string,
    params: {
      title?: string;
      content?: string;
      topic?: string;
      tags?: string[];
      summary?: string;
      source?: string;
      last_verified_at?: string;
    },
  ): Promise<void> {
    const now = new Date().toISOString();
    const patch: Record<string, unknown> = { updated_at: now };
    if (params.title !== undefined) patch['title'] = params.title;
    if (params.content !== undefined) patch['content'] = params.content;
    if (params.topic !== undefined) patch['topic'] = params.topic;
    if (params.tags !== undefined) patch['tags'] = params.tags;
    if (params.summary !== undefined) patch['summary'] = params.summary;
    if (params.source !== undefined) patch['source'] = params.source;
    if (params.last_verified_at !== undefined) patch['last_verified_at'] = params.last_verified_at;

    const session = this.driver.session();
    try {
      await session.run('MATCH (r:Resource {id: $id}) SET r += $patch', { id: resourceId, patch });
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
   * Full-text search over resource title, content, summary, topic, and tags.
   *
   * Uses the `resource_text` fulltext index. Results are ordered by relevance
   * score descending, then by `updated_at` descending for stability.
   * Only returns resources the caller can read (owned + shared via HAS_ACCESS).
   *
   * Three search modes are supported (default: fuzzy):
   *  - exact:    phrase match (Lucene `"..."` query)
   *  - fulltext: escaped keyword query (current legacy behaviour)
   *  - fuzzy:    per-token fuzzy with edit-distance suffix; returns [] when all
   *              tokens are filtered out (avoids hitting the index for empty queries)
   */
  async searchResources(params: {
    userId: string;
    query: string;
    namespace?: string;
    entry_type?: string;
    limit?: number;
    skip?: number;
    match_mode?: MatchMode;
  }): Promise<ResourceWithOwnership[]> {
    const limit = params.limit ?? 20;
    const skip = params.skip ?? 0;
    const mode = params.match_mode ?? 'fuzzy';

    const luceneQuery = buildLuceneQuery(params.query, mode);
    if (luceneQuery === null) return [];

    const session = this.driver.session();
    try {
      const result = await session.run(
        `
        CALL db.index.fulltext.queryNodes('resource_text', $query) YIELD node AS r, score
        MATCH (u:User {id: $userId})-[:OWNS|HAS_ACCESS]->(r)
        WHERE ($namespace IS NULL OR r.namespace = $namespace)
          AND ($entry_type IS NULL OR r.entry_type = $entry_type)
        RETURN r,
          CASE WHEN (u)-[:OWNS]->(r) THEN 'owner' ELSE 'shared' END AS ownership,
          score
        ORDER BY score DESC, r.updated_at DESC
        SKIP $skip LIMIT $limit
        `,
        {
          userId: params.userId,
          query: luceneQuery,
          namespace: params.namespace ?? null,
          entry_type: params.entry_type ?? null,
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

  // ── Entry relations ─────────────────────────────────────────────────────────

  async createEntryRelation(
    userId: string,
    fromId: string,
    toId: string,
    relationType: string,
    label?: string,
  ): Promise<void> {
    if (fromId === toId) {
      throw new Neo4jClientError('INVALID_PARAMS', 'from_id and to_id must be different');
    }
    if (!ENTRY_RELATION_TYPE_REGEX.test(relationType)) {
      throw new Neo4jClientError('INVALID_PARAMS', 'relation_type must be UPPER_SNAKE_CASE');
    }

    const fromResource = await this.getResource(fromId);
    const toResource = await this.getResource(toId);
    if (!fromResource || !toResource) {
      throw new Neo4jClientError('RESOURCE_NOT_FOUND', 'Resource not found');
    }

    if (fromResource.namespace !== toResource.namespace) {
      throw new Neo4jClientError('INVALID_PARAMS', 'Entries must belong to the same namespace');
    }

    const fromRole = await this.getEffectiveRole(userId, fromId);
    const toRole = await this.getEffectiveRole(userId, toId);
    if (!Neo4jClient.hasReadPermission(fromRole) || !Neo4jClient.hasReadPermission(toRole)) {
      throw new Neo4jClientError('PERMISSION_DENIED', 'Permission denied');
    }

    const now = new Date().toISOString();
    const session = this.driver.session();
    try {
      await session.run(
        `
        MATCH (from:Resource {id: $fromId})
        MATCH (to:Resource {id: $toId})
        MERGE (from)-[r:ENTRY_RELATION {relation_type: $relationType}]->(to)
        ON CREATE SET r.created_at = $now
        SET r.label = $label
        `,
        {
          fromId,
          toId,
          relationType,
          now,
          label: label ?? null,
        },
      );

      if (label === undefined) {
        await session.run(
          `
          MATCH (:Resource {id: $fromId})-[r:ENTRY_RELATION {relation_type: $relationType}]->(:Resource {id: $toId})
          REMOVE r.label
          `,
          { fromId, toId, relationType },
        );
      }
    } finally {
      await session.close();
    }
  }

  async deleteEntryRelation(
    userId: string,
    fromId: string,
    toId: string,
    relationType: string,
  ): Promise<void> {
    const fromResource = await this.getResource(fromId);
    const toResource = await this.getResource(toId);
    if (!fromResource || !toResource) {
      throw new Neo4jClientError('RESOURCE_NOT_FOUND', 'Resource not found');
    }
    if (!ENTRY_RELATION_TYPE_REGEX.test(relationType)) {
      throw new Neo4jClientError('INVALID_PARAMS', 'relation_type must be UPPER_SNAKE_CASE');
    }

    const fromRole = await this.getEffectiveRole(userId, fromId);
    if (fromRole !== 'owner') {
      throw new Neo4jClientError('PERMISSION_DENIED', 'Permission denied');
    }

    const session = this.driver.session();
    try {
      await session.run(
        `
        MATCH (:Resource {id: $fromId})-[r:ENTRY_RELATION {relation_type: $relationType}]->(:Resource {id: $toId})
        DELETE r
        `,
        { fromId, toId, relationType },
      );
    } finally {
      await session.close();
    }
  }

  async listEntryRelations(
    userId: string,
    entryId: string,
    direction: EntryRelationDirection,
  ): Promise<EntryRelation[]> {
    const entry = await this.getResource(entryId);
    if (!entry) {
      throw new Neo4jClientError('RESOURCE_NOT_FOUND', 'Resource not found');
    }
    const role = await this.getEffectiveRole(userId, entryId);
    if (!Neo4jClient.hasReadPermission(role)) {
      throw new Neo4jClientError('PERMISSION_DENIED', 'Permission denied');
    }

    const session = this.driver.session();
    try {
      let query: string;
      if (direction === 'outbound') {
        query = `
          MATCH (base:Resource {id: $entryId})-[r:ENTRY_RELATION]->(other:Resource)
          WHERE EXISTS { MATCH (:User {id: $userId})-[:OWNS|HAS_ACCESS]->(other) }
          RETURN 'outbound' AS direction, r.relation_type AS relation_type, r.label AS label, other.id AS entry_id, other.title AS entry_title
          ORDER BY relation_type, entry_title
        `;
      } else if (direction === 'inbound') {
        query = `
          MATCH (other:Resource)-[r:ENTRY_RELATION]->(base:Resource {id: $entryId})
          WHERE EXISTS { MATCH (:User {id: $userId})-[:OWNS|HAS_ACCESS]->(other) }
          RETURN 'inbound' AS direction, r.relation_type AS relation_type, r.label AS label, other.id AS entry_id, other.title AS entry_title
          ORDER BY relation_type, entry_title
        `;
      } else {
        query = `
          MATCH (base:Resource {id: $entryId})-[r:ENTRY_RELATION]->(otherOut:Resource)
          WHERE EXISTS { MATCH (:User {id: $userId})-[:OWNS|HAS_ACCESS]->(otherOut) }
          RETURN 'outbound' AS direction, r.relation_type AS relation_type, r.label AS label, otherOut.id AS entry_id, otherOut.title AS entry_title
          UNION ALL
          MATCH (otherIn:Resource)-[r:ENTRY_RELATION]->(base:Resource {id: $entryId})
          WHERE EXISTS { MATCH (:User {id: $userId})-[:OWNS|HAS_ACCESS]->(otherIn) }
          RETURN 'inbound' AS direction, r.relation_type AS relation_type, r.label AS label, otherIn.id AS entry_id, otherIn.title AS entry_title
        `;
      }

      const result = await session.run(query, { userId, entryId });
      return result.records.map((record) => ({
        direction: record.get('direction') as 'outbound' | 'inbound',
        relation_type: record.get('relation_type') as string,
        ...(record.get('label') !== null ? { label: record.get('label') as string } : {}),
        entry: {
          id: record.get('entry_id') as string,
          title: record.get('entry_title') as string,
        },
      }));
    } finally {
      await session.close();
    }
  }

  async getRelatedEntries(
    userId: string,
    entryId: string,
    relationType?: string,
    limit = 20,
  ): Promise<Resource[]> {
    const entry = await this.getResource(entryId);
    if (!entry) {
      throw new Neo4jClientError('RESOURCE_NOT_FOUND', 'Resource not found');
    }
    const role = await this.getEffectiveRole(userId, entryId);
    if (!Neo4jClient.hasReadPermission(role)) {
      throw new Neo4jClientError('PERMISSION_DENIED', 'Permission denied');
    }
    if (relationType !== undefined && !ENTRY_RELATION_TYPE_REGEX.test(relationType)) {
      throw new Neo4jClientError('INVALID_PARAMS', 'relation_type must be UPPER_SNAKE_CASE');
    }

    const session = this.driver.session();
    try {
      const result = await session.run(
        `
        MATCH (base:Resource {id: $entryId})-[r:ENTRY_RELATION]-(other:Resource)
        WHERE ($relationType IS NULL OR r.relation_type = $relationType)
          AND EXISTS { MATCH (:User {id: $userId})-[:OWNS|HAS_ACCESS]->(other) }
        RETURN DISTINCT other
        ORDER BY other.updated_at DESC
        LIMIT $limit
        `,
        {
          userId,
          entryId,
          relationType: relationType ?? null,
          limit: neo4j.int(limit),
        },
      );
      return result.records.map((record) => record.get('other').properties as Resource);
    } finally {
      await session.close();
    }
  }
}

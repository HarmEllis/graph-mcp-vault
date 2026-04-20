import { randomUUID } from "node:crypto";
import neo4j, { type Driver } from "neo4j-driver";

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
  versioned?: boolean;
}

export interface ResourceVersion {
  id: string;
  resource_id: string;
  version: number;
  title: string;
  content: string;
  created_at: string;
  changed_by: string;
}

export interface ResourceWithOwnership extends Resource {
  ownership: "owner" | "shared";
  score: number;
}

export interface SharingEntry {
  user_id: string;
  name?: string;
  email?: string;
  role: "viewer" | "editor";
  granted_at: string;
}

export interface NamespaceSummary {
  namespace: string;
  owned_count: number;
  shared_count: number;
  structure_template?: string;
}

export interface UserProfile {
  user_id: string;
  name?: string;
  email?: string;
}

export type AutoSharePermission = "read" | "write";

export interface NamespaceConfig {
  namespace: string;
  auto_share: boolean;
  auto_share_permission: AutoSharePermission;
  auto_share_user_ids: string[];
  structure_template?: string;
  versioning_enabled?: boolean;
  max_versions?: number;
}

export type MatchMode = "exact" | "fulltext" | "fuzzy";
export type EntryRelationDirection = "outbound" | "inbound" | "both";

export interface EntryRelation {
  direction: "outbound" | "inbound";
  relation_type: string;
  label?: string;
  created_at?: string;
  entry: {
    id: string;
    title: string;
  };
}

export const ENTRY_RELATION_TYPE_REGEX = /^[A-Z][A-Z0-9_]{1,63}$/;
export type Neo4jClientErrorCode =
  | "INVALID_PARAMS"
  | "RESOURCE_NOT_FOUND"
  | "PERMISSION_DENIED";

export interface ExpandContextLayer {
  distance: number;
  entries: Array<{ id: string; title: string }>;
}

export interface PathResult {
  nodes: Array<{ id: string; title: string; entry_type: string }>;
  relations: Array<{
    relation_type: string;
    label?: string;
    from_id: string;
    to_id: string;
  }>;
  formatted: string;
}

export interface RelationshipPath {
  nodes: Array<{ id: string; title: string; entry_type: string }>;
  relations: Array<{
    relation_type: string;
    label?: string;
    from_id: string;
    to_id: string;
  }>;
  /** Human-readable chain with actual edge directions, e.g.
   *  "NAS <-[MANAGED_BY]- Management VM -[CONNECTS_TO]-> PiKVM" */
  formatted: string;
}

export interface ExplainRelationshipResult {
  entry_a: { id: string; title: string; entry_type: string };
  entry_b: { id: string; title: string; entry_type: string };
  /** Relations where A and B are directly connected (no intermediates). */
  direct_relations: Array<{
    relation_type: string;
    label?: string;
    direction: "a_to_b" | "b_to_a";
  }>;
  paths: RelationshipPath[];
  /** True if at least one direct relation or path was found. */
  connected: boolean;
}

export class Neo4jClientError extends Error {
  constructor(
    public readonly code: Neo4jClientErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "Neo4jClientError";
  }
}

// ── Version snapshot helpers ──────────────────────────────────────────────────

function isConstraintViolation(err: unknown): boolean {
  return (
    err != null &&
    typeof err === "object" &&
    "code" in err &&
    (err as { code: string }).code ===
      "Neo.ClientError.Schema.ConstraintValidationFailed"
  );
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
  const BOOLEAN_OPS = new Set(["AND", "OR", "NOT"]);

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
    .join(" ");
}

/**
 * Dispatches to the appropriate Lucene query builder based on `mode`.
 * Returns null only in fuzzy mode when all tokens are filtered out.
 */
function buildLuceneQuery(query: string, mode: MatchMode): string | null {
  switch (mode) {
    case "exact":
      return buildExactQuery(query);
    case "fulltext":
      return escapeLuceneQuery(query);
    case "fuzzy":
      return buildFuzzyQuery(query);
  }
}

// ── Path helpers ──────────────────────────────────────────────────────────────

/**
 * Builds a human-readable path string from nodes and relations, showing the
 * actual direction of each edge based on its `from_id`/`to_id`.
 *
 * Example: "NAS <-[MANAGED_BY]- Management VM -[CONNECTS_TO]-> PiKVM"
 */
function buildFormattedPath(
  nodes: Array<{ id: string; title: string }>,
  relations: Array<{ relation_type: string; from_id: string }>,
): string {
  return nodes
    .map((node, i) => {
      if (i === 0) return node.title;
      const rel = relations[i - 1];
      const previousNode = nodes[i - 1];
      if (!rel || !previousNode) return node.title;
      const arrow =
        rel.from_id === previousNode.id
          ? `-[${rel.relation_type}]->`
          : `<-[${rel.relation_type}]-`;
      return `${arrow} ${node.title}`;
    })
    .join(" ");
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

  private static hasReadPermission(
    role: "owner" | "editor" | "viewer" | null,
  ): boolean {
    return role === "owner" || role === "editor" || role === "viewer";
  }

  // ── User profile ─────────────────────────────────────────────────────────────

  /**
   * Upserts the `name` and `email` profile fields on a (:User) node.
   *
   * Uses `coalesce` so that a null claim (absent from the JWT) does not
   * overwrite a value that was stored during a previous session. A new User
   * node is created by the MERGE when one does not exist yet.
   */
  async upsertUserProfile(
    userId: string,
    name: string | null,
    email: string | null,
  ): Promise<void> {
    const session = this.driver.session();
    try {
      await session.run(
        `
        MERGE (u:User {id: $userId})
        SET u.name  = coalesce($name,  u.name),
            u.email = coalesce($email, u.email)
        `,
        { userId, name, email },
      );
    } finally {
      await session.close();
    }
  }

  async getUser(userId: string): Promise<UserProfile | null> {
    const session = this.driver.session();
    try {
      const result = await session.run(
        `
        MATCH (u:User {id: $userId})
        RETURN u.id AS user_id, u.name AS name, u.email AS email
        `,
        { userId },
      );
      if (result.records.length === 0) return null;
      const record = result.records[0];
      if (!record) return null;
      return {
        user_id: record.get("user_id") as string,
        ...(record.get("name") !== null
          ? { name: record.get("name") as string }
          : {}),
        ...(record.get("email") !== null
          ? { email: record.get("email") as string }
          : {}),
      };
    } finally {
      await session.close();
    }
  }

  async getExistingUserIds(userIds: string[]): Promise<string[]> {
    const dedupedUserIds = [...new Set(userIds)];
    if (dedupedUserIds.length === 0) return [];

    const session = this.driver.session();
    try {
      const result = await session.run(
        `
        UNWIND $userIds AS userId
        MATCH (u:User {id: userId})
        RETURN DISTINCT u.id AS user_id
        `,
        { userIds: dedupedUserIds },
      );
      const existing = new Set(
        result.records.map((record) => record.get("user_id") as string),
      );
      return dedupedUserIds.filter((id) => existing.has(id));
    } finally {
      await session.close();
    }
  }

  async searchUsers(params: {
    requesterUserId: string;
    name?: string;
    email?: string;
    limit: number;
  }): Promise<UserProfile[]> {
    const session = this.driver.session();
    try {
      if (params.name === undefined && params.email === undefined) {
        const relatedResult = await session.run(
          `
          MATCH (me:User {id: $requesterUserId})-[:OWNS|HAS_ACCESS]->(r:Resource)<-[:OWNS|HAS_ACCESS]-(u:User)
          WHERE u.id <> $requesterUserId
          RETURN DISTINCT u.id AS user_id, u.name AS name, u.email AS email
          ORDER BY coalesce(u.name, u.email, u.id)
          LIMIT $limit
          `,
          {
            requesterUserId: params.requesterUserId,
            limit: neo4j.int(params.limit),
          },
        );
        return relatedResult.records.map((record) => ({
          user_id: record.get("user_id") as string,
          ...(record.get("name") !== null
            ? { name: record.get("name") as string }
            : {}),
          ...(record.get("email") !== null
            ? { email: record.get("email") as string }
            : {}),
        }));
      }

      // Intentional privacy trade-off:
      // with an exact name/email filter we allow direct user lookup to enable
      // explicit sharing workflows, while still preventing broad enumeration
      // (no partial matching, no wildcard search, and caller excluded).
      const result = await session.run(
        `
        MATCH (u:User)
        WHERE u.id <> $requesterUserId
          AND ($name IS NULL OR toLower(coalesce(u.name, '')) = toLower($name))
          AND ($email IS NULL OR toLower(coalesce(u.email, '')) = toLower($email))
        RETURN u.id AS user_id, u.name AS name, u.email AS email
        ORDER BY coalesce(u.name, u.email, u.id)
        LIMIT $limit
        `,
        {
          requesterUserId: params.requesterUserId,
          name: params.name ?? null,
          email: params.email ?? null,
          limit: neo4j.int(params.limit),
        },
      );
      return result.records.map((record) => ({
        user_id: record.get("user_id") as string,
        ...(record.get("name") !== null
          ? { name: record.get("name") as string }
          : {}),
        ...(record.get("email") !== null
          ? { email: record.get("email") as string }
          : {}),
      }));
    } finally {
      await session.close();
    }
  }

  async getNamespaceConfig(
    ownerId: string,
    namespace: string,
  ): Promise<NamespaceConfig> {
    const session = this.driver.session();
    try {
      const result = await session.run(
        `
        MATCH (cfg:NamespaceConfig {owner_id: $ownerId, namespace: $namespace})
        RETURN cfg.auto_share AS auto_share,
               cfg.auto_share_permission AS auto_share_permission,
               cfg.auto_share_user_ids AS auto_share_user_ids,
               cfg.structure_template AS structure_template,
               cfg.versioning_enabled AS versioning_enabled,
               cfg.max_versions AS max_versions
        `,
        { ownerId, namespace },
      );
      if (result.records.length === 0) {
        return {
          namespace,
          auto_share: false,
          auto_share_permission: "read",
          auto_share_user_ids: [],
        };
      }
      const record = result.records[0];
      if (!record) {
        return {
          namespace,
          auto_share: false,
          auto_share_permission: "read",
          auto_share_user_ids: [],
        };
      }
      const permission =
        (record.get("auto_share_permission") as AutoSharePermission | null) ??
        "read";
      const userIds = record.get("auto_share_user_ids") as string[] | null;
      const structureTemplate = record.get("structure_template") as
        | string
        | null;
      return {
        namespace,
        auto_share: (record.get("auto_share") as boolean | null) ?? false,
        auto_share_permission:
          permission === "write" || permission === "read" ? permission : "read",
        auto_share_user_ids: Array.isArray(userIds) ? userIds : [],
        ...(structureTemplate !== null
          ? { structure_template: structureTemplate }
          : {}),
        ...(record.get("versioning_enabled") !== null
          ? { versioning_enabled: record.get("versioning_enabled") as boolean }
          : {}),
        ...(record.get("max_versions") !== null
          ? { max_versions: neo4j.integer.toNumber(record.get("max_versions")) }
          : {}),
      };
    } finally {
      await session.close();
    }
  }

  async updateNamespaceConfig(params: {
    ownerId: string;
    namespace: string;
    auto_share?: boolean;
    auto_share_permission?: AutoSharePermission;
    auto_share_user_ids?: string[];
    structure_template?: string;
    versioning_enabled?: boolean;
    max_versions?: number | null;
  }): Promise<NamespaceConfig> {
    const session = this.driver.session();
    try {
      const result = await session.run(
        `
        MERGE (cfg:NamespaceConfig {owner_id: $ownerId, namespace: $namespace})
        SET cfg.auto_share = coalesce($autoShare, cfg.auto_share, false),
            cfg.auto_share_permission = coalesce(
              $autoSharePermission,
              cfg.auto_share_permission,
              'read'
            ),
            cfg.auto_share_user_ids = coalesce(
              $autoShareUserIds,
              cfg.auto_share_user_ids,
              []
            ),
            cfg.structure_template = coalesce(
              $structureTemplate,
              cfg.structure_template
            ),
            cfg.versioning_enabled = CASE
              WHEN $versioningEnabled IS NOT NULL THEN $versioningEnabled
              ELSE cfg.versioning_enabled
            END,
            cfg.max_versions = CASE
              WHEN $clearMaxVersions THEN null
              WHEN $maxVersions IS NOT NULL THEN $maxVersions
              ELSE cfg.max_versions
            END,
            cfg.updated_at = $now
        RETURN cfg.auto_share AS auto_share,
               cfg.auto_share_permission AS auto_share_permission,
               cfg.auto_share_user_ids AS auto_share_user_ids,
               cfg.structure_template AS structure_template,
               cfg.versioning_enabled AS versioning_enabled,
               cfg.max_versions AS max_versions
        `,
        {
          ownerId: params.ownerId,
          namespace: params.namespace,
          autoShare: params.auto_share ?? null,
          autoSharePermission: params.auto_share_permission ?? null,
          autoShareUserIds: params.auto_share_user_ids ?? null,
          structureTemplate: params.structure_template ?? null,
          versioningEnabled: params.versioning_enabled ?? null,
          clearMaxVersions: params.max_versions === null,
          maxVersions:
            params.max_versions != null ? neo4j.int(params.max_versions) : null,
          now: new Date().toISOString(),
        },
      );
      const record = result.records[0];
      if (!record) {
        return {
          namespace: params.namespace,
          auto_share: false,
          auto_share_permission: "read",
          auto_share_user_ids: [],
        };
      }

      const permission =
        (record.get("auto_share_permission") as AutoSharePermission | null) ??
        "read";
      const userIds = record.get("auto_share_user_ids") as string[] | null;
      const structureTemplate = record.get("structure_template") as
        | string
        | null;
      return {
        namespace: params.namespace,
        auto_share: (record.get("auto_share") as boolean | null) ?? false,
        auto_share_permission:
          permission === "write" || permission === "read" ? permission : "read",
        auto_share_user_ids: Array.isArray(userIds) ? userIds : [],
        ...(structureTemplate !== null
          ? { structure_template: structureTemplate }
          : {}),
        ...(record.get("versioning_enabled") !== null
          ? { versioning_enabled: record.get("versioning_enabled") as boolean }
          : {}),
        ...(record.get("max_versions") !== null
          ? { max_versions: neo4j.integer.toNumber(record.get("max_versions")) }
          : {}),
      };
    } finally {
      await session.close();
    }
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
    versioned?: boolean;
  }): Promise<{ id: string; created_at: string }> {
    const id = randomUUID();
    const now = new Date().toISOString();

    const optionalProps: Record<string, unknown> = {};
    if (params.topic !== undefined) optionalProps.topic = params.topic;
    if (params.tags !== undefined) optionalProps.tags = params.tags;
    if (params.summary !== undefined) optionalProps.summary = params.summary;
    if (params.source !== undefined) optionalProps.source = params.source;
    if (params.last_verified_at !== undefined)
      optionalProps.last_verified_at = params.last_verified_at;
    if (params.versioned !== undefined)
      optionalProps.versioned = params.versioned;

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
      const result = await session.run(
        "MATCH (r:Resource {id: $id}) RETURN r",
        { id: resourceId },
      );
      if (result.records.length === 0) return null;
      const record = result.records[0];
      if (!record) return null;
      return record.get("r").properties as Resource;
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
        ...(record.get("r").properties as Resource),
        ownership: record.get("ownership") as "owner" | "shared",
        score: 0,
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
      entry_type?: string;
      namespace?: string;
      topic?: string;
      tags?: string[];
      summary?: string;
      source?: string;
      last_verified_at?: string;
      versioned?: boolean;
    },
    versioning?: { changedBy: string; maxVersions: number },
  ): Promise<void> {
    if (params.namespace !== undefined) {
      const current = await this.getResource(resourceId);
      if (current && current.namespace !== params.namespace) {
        const guardSession = this.driver.session();
        try {
          const guardResult = await guardSession.run(
            `MATCH (r:Resource {id: $id})
             RETURN EXISTS { (r)-[:ENTRY_RELATION]-() } AS hasRelations`,
            { id: resourceId },
          );
          const guardRecord = guardResult.records[0];
          if (guardRecord && guardRecord.get("hasRelations") === true) {
            throw new Neo4jClientError(
              "INVALID_PARAMS",
              "Cannot change namespace: entry has existing relations",
            );
          }
        } finally {
          await guardSession.close();
        }
      }
    }

    const now = new Date().toISOString();
    const patch: Record<string, unknown> = { updated_at: now };
    if (params.title !== undefined) patch.title = params.title;
    if (params.content !== undefined) patch.content = params.content;
    if (params.entry_type !== undefined) patch.entry_type = params.entry_type;
    if (params.namespace !== undefined) patch.namespace = params.namespace;
    if (params.topic !== undefined) patch.topic = params.topic;
    if (params.tags !== undefined) patch.tags = params.tags;
    if (params.summary !== undefined) patch.summary = params.summary;
    if (params.source !== undefined) patch.source = params.source;
    if (params.last_verified_at !== undefined)
      patch.last_verified_at = params.last_verified_at;
    if (params.versioned !== undefined) patch.versioned = params.versioned;

    const needsSnapshot =
      versioning != null &&
      (params.title !== undefined || params.content !== undefined);

    const session = this.driver.session();
    try {
      if (needsSnapshot) {
        const snapshotConfig = versioning;
        if (!snapshotConfig) {
          throw new Error("Invariant violation: versioning config is required");
        }
        const now2 = new Date().toISOString();
        const MAX_VERSION_RETRIES = 3;
        let lastErr: unknown;
        for (let attempt = 0; attempt < MAX_VERSION_RETRIES; attempt++) {
          try {
            const versionId = randomUUID();
            await session.executeWrite(async (tx) => {
              await tx.run(
                `
            MATCH (r:Resource {id: $resourceId})
            OPTIONAL MATCH (r)-[:HAS_VERSION]->(existing:ResourceVersion)
            WITH r, coalesce(max(existing.version), 0) + 1 AS nextVer
            CREATE (v:ResourceVersion {
              id: $versionId,
              resource_id: $resourceId,
              version: nextVer,
              title: r.title,
              content: r.content,
              created_at: $now,
              changed_by: $changedBy
            })
            CREATE (r)-[:HAS_VERSION]->(v)
            `,
                {
                  resourceId,
                  versionId,
                  now: now2,
                  changedBy: snapshotConfig.changedBy,
                },
              );
              await tx.run("MATCH (r:Resource {id: $id}) SET r += $patch", {
                id: resourceId,
                patch,
              });
              if (snapshotConfig.maxVersions > 0) {
                await tx.run(
                  `
                  MATCH (r:Resource {id: $resourceId})-[:HAS_VERSION]->(v:ResourceVersion)
                  WITH v ORDER BY v.version ASC
                  WITH collect(v) AS versions
                  WHERE size(versions) > $maxVersions
                  UNWIND versions[0..size(versions) - $maxVersions] AS toDelete
                  DETACH DELETE toDelete
                  `,
                  {
                    resourceId,
                    maxVersions: neo4j.int(snapshotConfig.maxVersions),
                  },
                );
              }
            });
            lastErr = undefined;
            break;
          } catch (err) {
            lastErr = err;
            if (!isConstraintViolation(err)) throw err;
            // Concurrent write grabbed the same version number — retry
          }
        }
        if (lastErr != null) throw lastErr;
      } else {
        await session.run("MATCH (r:Resource {id: $id}) SET r += $patch", {
          id: resourceId,
          patch,
        });
      }
    } finally {
      await session.close();
    }
  }

  /** DETACH DELETEs the Resource node, removing all relationships. */
  async deleteResource(resourceId: string): Promise<void> {
    const session = this.driver.session();
    try {
      await session.run("MATCH (r:Resource {id: $id}) DETACH DELETE r", {
        id: resourceId,
      });
    } finally {
      await session.close();
    }
  }

  // ── Versioning ───────────────────────────────────────────────────────────────

  async listVersions(resourceId: string): Promise<ResourceVersion[]> {
    const session = this.driver.session();
    try {
      const result = await session.run(
        `
        MATCH (r:Resource {id: $resourceId})-[:HAS_VERSION]->(v:ResourceVersion)
        RETURN v ORDER BY v.version DESC
        `,
        { resourceId },
      );
      return result.records.map((record) => {
        const props = record.get("v").properties as Record<string, unknown>;
        return {
          id: props.id as string,
          resource_id: props.resource_id as string,
          version: neo4j.integer.toNumber(
            props.version as Parameters<typeof neo4j.integer.toNumber>[0],
          ),
          title: props.title as string,
          content: props.content as string,
          created_at: props.created_at as string,
          changed_by: props.changed_by as string,
        };
      });
    } finally {
      await session.close();
    }
  }

  async getVersion(
    resourceId: string,
    version: number,
  ): Promise<ResourceVersion | null> {
    const session = this.driver.session();
    try {
      const result = await session.run(
        `
        MATCH (r:Resource {id: $resourceId})-[:HAS_VERSION]->(v:ResourceVersion {version: $version})
        RETURN v
        `,
        { resourceId, version: neo4j.int(version) },
      );
      if (result.records.length === 0) return null;
      const record = result.records[0];
      if (!record) return null;
      const props = record.get("v").properties as Record<string, unknown>;
      return {
        id: props.id as string,
        resource_id: props.resource_id as string,
        version: neo4j.integer.toNumber(
          props.version as Parameters<typeof neo4j.integer.toNumber>[0],
        ),
        title: props.title as string,
        content: props.content as string,
        created_at: props.created_at as string,
        changed_by: props.changed_by as string,
      };
    } finally {
      await session.close();
    }
  }

  async restoreVersion(
    resourceId: string,
    version: number,
    changedBy: string,
    maxVersions: number,
  ): Promise<void> {
    const now = new Date().toISOString();
    const MAX_VERSION_RETRIES = 3;
    let lastErr: unknown;
    const session = this.driver.session();
    try {
      for (let attempt = 0; attempt < MAX_VERSION_RETRIES; attempt++) {
        try {
          await session.executeWrite(async (tx) => {
            // Only snapshot current content when versioning is active
            if (maxVersions > 0) {
              const versionId = randomUUID();
              await tx.run(
                `
                MATCH (r:Resource {id: $resourceId})
                OPTIONAL MATCH (r)-[:HAS_VERSION]->(existing:ResourceVersion)
                WITH r, coalesce(max(existing.version), 0) + 1 AS nextVer
                CREATE (v:ResourceVersion {
                  id: $versionId,
                  resource_id: $resourceId,
                  version: nextVer,
                  title: r.title,
                  content: r.content,
                  created_at: $now,
                  changed_by: $changedBy
                })
                CREATE (r)-[:HAS_VERSION]->(v)
                `,
                { resourceId, versionId, now, changedBy },
              );
            }

            await tx.run(
              `
              MATCH (r:Resource {id: $resourceId})
              MATCH (r)-[:HAS_VERSION]->(v:ResourceVersion {version: $version})
              SET r.title = v.title,
                  r.content = v.content,
                  r.updated_at = $now
              `,
              { resourceId, version: neo4j.int(version), now },
            );

            if (maxVersions > 0) {
              await tx.run(
                `
                MATCH (r:Resource {id: $resourceId})-[:HAS_VERSION]->(v:ResourceVersion)
                WITH v ORDER BY v.version ASC
                WITH collect(v) AS versions
                WHERE size(versions) > $maxVersions
                UNWIND versions[0..size(versions) - $maxVersions] AS toDelete
                DETACH DELETE toDelete
                `,
                { resourceId, maxVersions: neo4j.int(maxVersions) },
              );
            }
          });
          lastErr = undefined;
          break;
        } catch (err) {
          lastErr = err;
          if (!isConstraintViolation(err)) throw err;
          // Concurrent write grabbed the same version number — retry
        }
      }
      if (lastErr != null) throw lastErr;
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
    const mode = params.match_mode ?? "fuzzy";

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
      return result.records.map((record) => {
        const r = record.get("r").properties as Resource;
        const raw = Number(record.get("score"));
        const score = Number.isFinite(raw) ? raw : 0;
        if (!Number.isFinite(raw)) {
          console.warn("[searchResources] non-finite score from driver", {
            resourceId: r.id,
          });
        }
        return {
          ...r,
          ownership: record.get("ownership") as "owner" | "shared",
          score,
        };
      });
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
  ): Promise<"owner" | "editor" | "viewer" | null> {
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
      const role = record.get("role") as string | null;
      if (role === "owner" || role === "editor" || role === "viewer")
        return role;
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
    role: "viewer" | "editor",
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

  async shareResourceWithUsers(params: {
    resourceId: string;
    targetUserIds: string[];
    role: "viewer" | "editor";
  }): Promise<string[]> {
    const dedupedTargetUserIds = [...new Set(params.targetUserIds)];
    if (dedupedTargetUserIds.length === 0) return [];

    const now = new Date().toISOString();
    const session = this.driver.session();
    try {
      const result = await session.run(
        `
        MATCH (r:Resource {id: $resourceId})
        WITH r, $targetUserIds AS targetUserIds
        UNWIND targetUserIds AS targetUserId
        MATCH (u:User {id: targetUserId})
        MERGE (u)-[acc:HAS_ACCESS]->(r)
        SET acc.role = $role, acc.granted_at = $now
        RETURN DISTINCT u.id AS user_id
        `,
        {
          resourceId: params.resourceId,
          targetUserIds: dedupedTargetUserIds,
          role: params.role,
          now,
        },
      );
      const sharedUserIds = new Set(
        result.records.map((record) => record.get("user_id") as string),
      );
      return dedupedTargetUserIds.filter((id) => sharedUserIds.has(id));
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
  async listNamespaces(params: { userId: string }): Promise<
    NamespaceSummary[]
  > {
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

      const templateResult = await session.run(
        `
        MATCH (cfg:NamespaceConfig {owner_id: $userId})
        WHERE cfg.structure_template IS NOT NULL
        RETURN cfg.namespace AS namespace,
               cfg.structure_template AS structure_template
        `,
        { userId: params.userId },
      );

      const map = new Map<string, NamespaceSummary>();

      for (const record of ownedResult.records) {
        const namespace = record.get("namespace") as string;
        const owned_count = neo4j.integer.toNumber(record.get("owned_count"));
        map.set(namespace, { namespace, owned_count, shared_count: 0 });
      }

      for (const record of sharedResult.records) {
        const namespace = record.get("namespace") as string;
        const shared_count = neo4j.integer.toNumber(record.get("shared_count"));
        const existing = map.get(namespace);
        if (existing) {
          existing.shared_count = shared_count;
        } else {
          map.set(namespace, { namespace, owned_count: 0, shared_count });
        }
      }

      for (const record of templateResult.records) {
        const namespace = record.get("namespace") as string;
        const structure_template = record.get("structure_template") as string;
        const existing = map.get(namespace);
        if (existing) {
          existing.structure_template = structure_template;
        } else {
          map.set(namespace, {
            namespace,
            owned_count: 0,
            shared_count: 0,
            structure_template,
          });
        }
      }

      return [...map.values()].sort((a, b) =>
        a.namespace.localeCompare(b.namespace),
      );
    } finally {
      await session.close();
    }
  }

  /**
   * Returns HAS_ACCESS grants on the resource (does not include the owner).
   * Results are ordered by granted_at DESC for determinism. An optional limit
   * caps the number of entries returned.
   */
  async listSharing(
    resourceId: string,
    limit: number,
  ): Promise<SharingEntry[]> {
    const session = this.driver.session();
    try {
      const result = await session.run(
        `
        MATCH (u:User)-[acc:HAS_ACCESS]->(r:Resource {id: $resourceId})
        RETURN u.id AS user_id, u.name AS name, u.email AS email,
               acc.role AS role, acc.granted_at AS granted_at
        ORDER BY acc.granted_at DESC
        LIMIT $limit
`,
        { resourceId, limit: neo4j.int(limit) },
      );
      return result.records.map((record) => ({
        user_id: record.get("user_id") as string,
        ...(record.get("name") !== null
          ? { name: record.get("name") as string }
          : {}),
        ...(record.get("email") !== null
          ? { email: record.get("email") as string }
          : {}),
        role: record.get("role") as "viewer" | "editor",
        granted_at: record.get("granted_at") as string,
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
      throw new Neo4jClientError(
        "INVALID_PARAMS",
        "from_id and to_id must be different",
      );
    }
    if (!ENTRY_RELATION_TYPE_REGEX.test(relationType)) {
      throw new Neo4jClientError(
        "INVALID_PARAMS",
        "relation_type must be UPPER_SNAKE_CASE",
      );
    }

    const fromResource = await this.getResource(fromId);
    const toResource = await this.getResource(toId);
    if (!fromResource || !toResource) {
      throw new Neo4jClientError("RESOURCE_NOT_FOUND", "Resource not found");
    }

    if (fromResource.namespace !== toResource.namespace) {
      throw new Neo4jClientError(
        "INVALID_PARAMS",
        "Entries must belong to the same namespace",
      );
    }

    const fromRole = await this.getEffectiveRole(userId, fromId);
    const toRole = await this.getEffectiveRole(userId, toId);
    if (
      !Neo4jClient.hasReadPermission(fromRole) ||
      !Neo4jClient.hasReadPermission(toRole)
    ) {
      throw new Neo4jClientError("PERMISSION_DENIED", "Permission denied");
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
      throw new Neo4jClientError("RESOURCE_NOT_FOUND", "Resource not found");
    }
    if (!ENTRY_RELATION_TYPE_REGEX.test(relationType)) {
      throw new Neo4jClientError(
        "INVALID_PARAMS",
        "relation_type must be UPPER_SNAKE_CASE",
      );
    }

    const fromRole = await this.getEffectiveRole(userId, fromId);
    if (fromRole !== "owner") {
      throw new Neo4jClientError("PERMISSION_DENIED", "Permission denied");
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
    limit: number,
  ): Promise<EntryRelation[]> {
    const entry = await this.getResource(entryId);
    if (!entry) {
      throw new Neo4jClientError("RESOURCE_NOT_FOUND", "Resource not found");
    }
    const role = await this.getEffectiveRole(userId, entryId);
    if (!Neo4jClient.hasReadPermission(role)) {
      throw new Neo4jClientError("PERMISSION_DENIED", "Permission denied");
    }

    const session = this.driver.session();
    try {
      let query: string;
      if (direction === "outbound") {
        query = `
          MATCH (base:Resource {id: $entryId})-[r:ENTRY_RELATION]->(other:Resource)
          WHERE EXISTS { MATCH (:User {id: $userId})-[:OWNS|HAS_ACCESS]->(other) }
          RETURN 'outbound' AS direction, r.relation_type AS relation_type, r.label AS label, r.created_at AS created_at, other.id AS entry_id, other.title AS entry_title
          ORDER BY relation_type, entry_title
          LIMIT $limit
        `;
      } else if (direction === "inbound") {
        query = `
          MATCH (other:Resource)-[r:ENTRY_RELATION]->(base:Resource {id: $entryId})
          WHERE EXISTS { MATCH (:User {id: $userId})-[:OWNS|HAS_ACCESS]->(other) }
          RETURN 'inbound' AS direction, r.relation_type AS relation_type, r.label AS label, r.created_at AS created_at, other.id AS entry_id, other.title AS entry_title
          ORDER BY relation_type, entry_title
          LIMIT $limit
        `;
      } else {
        query = `
          CALL {
            MATCH (base:Resource {id: $entryId})-[r:ENTRY_RELATION]->(otherOut:Resource)
            WHERE EXISTS { MATCH (:User {id: $userId})-[:OWNS|HAS_ACCESS]->(otherOut) }
            RETURN 'outbound' AS direction, r.relation_type AS relation_type, r.label AS label, r.created_at AS created_at, otherOut.id AS entry_id, otherOut.title AS entry_title
            UNION ALL
            MATCH (otherIn:Resource)-[r:ENTRY_RELATION]->(base:Resource {id: $entryId})
            WHERE EXISTS { MATCH (:User {id: $userId})-[:OWNS|HAS_ACCESS]->(otherIn) }
            RETURN 'inbound' AS direction, r.relation_type AS relation_type, r.label AS label, r.created_at AS created_at, otherIn.id AS entry_id, otherIn.title AS entry_title
          }
          RETURN direction, relation_type, label, created_at, entry_id, entry_title
          ORDER BY relation_type, entry_title
          LIMIT $limit
        `;
      }

      const result = await session.run(query, {
        userId,
        entryId,
        limit: neo4j.int(limit),
      });
      return result.records.map((record) => ({
        direction: record.get("direction") as "outbound" | "inbound",
        relation_type: record.get("relation_type") as string,
        ...(record.get("label") !== null
          ? { label: record.get("label") as string }
          : {}),
        ...(record.get("created_at") !== null
          ? { created_at: record.get("created_at") as string }
          : {}),
        entry: {
          id: record.get("entry_id") as string,
          title: record.get("entry_title") as string,
        },
      }));
    } finally {
      await session.close();
    }
  }

  // ── Graph traversal ─────────────────────────────────────────────────────────

  /**
   * Expands the neighborhood of `entryId` up to `maxHops` hops away.
   *
   * Only nodes the caller can read (OWNS|HAS_ACCESS) are traversed and returned.
   * Paths that pass through inaccessible intermediate nodes are excluded.
   * Results are grouped by minimum distance from the anchor entry.
   * `limit` caps the total number of unique nodes returned across all hops.
   */
  async expandContext(params: {
    userId: string;
    entryId: string;
    direction?: EntryRelationDirection;
    maxHops: number;
    relationTypes: string[] | null;
    limit: number;
  }): Promise<ExpandContextLayer[]> {
    const entry = await this.getResource(params.entryId);
    if (!entry) {
      throw new Neo4jClientError("RESOURCE_NOT_FOUND", "Resource not found");
    }
    const role = await this.getEffectiveRole(params.userId, params.entryId);
    if (!Neo4jClient.hasReadPermission(role)) {
      throw new Neo4jClientError("PERMISSION_DENIED", "Permission denied");
    }
    if (params.relationTypes !== null) {
      for (const rt of params.relationTypes) {
        if (!ENTRY_RELATION_TYPE_REGEX.test(rt)) {
          throw new Neo4jClientError(
            "INVALID_PARAMS",
            `relation_type must be UPPER_SNAKE_CASE: ${rt}`,
          );
        }
      }
    }

    const dir = params.direction ?? "both";
    // Neo4j does not allow parameters as range bounds in variable-length path
    // patterns — embed the integer literal directly (safe: already capped).
    const hopsLiteral = params.maxHops;
    let pathPattern: string;
    if (dir === "outbound") {
      pathPattern = `(start:Resource {id: $entryId})-[:ENTRY_RELATION*1..${hopsLiteral}]->(neighbor:Resource)`;
    } else if (dir === "inbound") {
      pathPattern = `(neighbor:Resource)-[:ENTRY_RELATION*1..${hopsLiteral}]->(start:Resource {id: $entryId})`;
    } else {
      pathPattern = `(start:Resource {id: $entryId})-[:ENTRY_RELATION*1..${hopsLiteral}]-(neighbor:Resource)`;
    }

    const neighborFilter = dir === "both" ? "AND neighbor <> start" : "";

    const query = `
      MATCH path = ${pathPattern}
      WHERE neighbor.namespace = start.namespace
        ${neighborFilter}
        AND ALL(n IN nodes(path) WHERE
          n = start OR EXISTS { MATCH (:User {id: $userId})-[:OWNS|HAS_ACCESS]->(n) }
        )
        AND ($relTypes IS NULL OR ALL(r IN relationships(path) WHERE r.relation_type IN $relTypes))
      WITH neighbor, min(length(path)) AS distance
      ORDER BY distance, neighbor.id
      LIMIT $limit
      WITH distance, collect({ id: neighbor.id, title: neighbor.title }) AS entries
      RETURN distance, entries
      ORDER BY distance
    `;

    const session = this.driver.session();
    try {
      const result = await session.run(query, {
        userId: params.userId,
        entryId: params.entryId,
        relTypes: params.relationTypes,
        limit: neo4j.int(params.limit),
      });
      return result.records.map((record) => ({
        distance: neo4j.integer.toNumber(record.get("distance")),
        entries: record.get("entries") as Array<{ id: string; title: string }>,
      }));
    } finally {
      await session.close();
    }
  }

  /**
   * Finds paths between two entries via ENTRY_RELATION edges.
   *
   * Traverses in both directions by default (undirected). Use `direction` to
   * restrict to outbound-only or inbound-only traversal.
   *
   * Only paths where every node is accessible to the caller are returned.
   * Both entries must exist in the same namespace and the caller must have
   * read access to both.
   */
  async findPaths(params: {
    userId: string;
    fromId: string;
    toId: string;
    maxDepth: number;
    maxPaths: number;
    relationTypes: string[] | null;
    direction?: "outbound" | "inbound" | "both";
  }): Promise<PathResult[]> {
    if (params.fromId === params.toId) {
      throw new Neo4jClientError(
        "INVALID_PARAMS",
        "from_id and to_id must be different",
      );
    }
    if (params.relationTypes !== null) {
      for (const rt of params.relationTypes) {
        if (!ENTRY_RELATION_TYPE_REGEX.test(rt)) {
          throw new Neo4jClientError(
            "INVALID_PARAMS",
            `relation_type must be UPPER_SNAKE_CASE: ${rt}`,
          );
        }
      }
    }

    const fromResource = await this.getResource(params.fromId);
    const toResource = await this.getResource(params.toId);
    if (!fromResource || !toResource) {
      throw new Neo4jClientError("RESOURCE_NOT_FOUND", "Resource not found");
    }
    if (fromResource.namespace !== toResource.namespace) {
      throw new Neo4jClientError(
        "INVALID_PARAMS",
        "Entries must belong to the same namespace",
      );
    }

    const fromRole = await this.getEffectiveRole(params.userId, params.fromId);
    const toRole = await this.getEffectiveRole(params.userId, params.toId);
    if (
      !Neo4jClient.hasReadPermission(fromRole) ||
      !Neo4jClient.hasReadPermission(toRole)
    ) {
      throw new Neo4jClientError("PERMISSION_DENIED", "Permission denied");
    }

    // Embed depth literal — Neo4j does not allow parameters in range bounds.
    const depthLiteral = params.maxDepth;
    const dir = params.direction ?? "both";
    let pathPattern: string;
    if (dir === "outbound") {
      pathPattern = `(fromNode:Resource {id: $fromId})-[:ENTRY_RELATION*1..${depthLiteral}]->(toNode:Resource {id: $toId})`;
    } else if (dir === "inbound") {
      pathPattern = `(fromNode:Resource {id: $fromId})<-[:ENTRY_RELATION*1..${depthLiteral}]-(toNode:Resource {id: $toId})`;
    } else {
      pathPattern = `(fromNode:Resource {id: $fromId})-[:ENTRY_RELATION*1..${depthLiteral}]-(toNode:Resource {id: $toId})`;
    }
    const session = this.driver.session();
    try {
      const result = await session.run(
        `
        MATCH path = ${pathPattern}
        WHERE ALL(n IN nodes(path) WHERE EXISTS { MATCH (:User {id: $userId})-[:OWNS|HAS_ACCESS]->(n) })
          AND ($relTypes IS NULL OR ALL(r IN relationships(path) WHERE r.relation_type IN $relTypes))
        WITH path ORDER BY length(path), [n IN nodes(path) | n.id]
        LIMIT $maxPaths
        RETURN
          [n IN nodes(path) | { id: n.id, title: n.title, entry_type: n.entry_type }] AS pathNodes,
          [r IN relationships(path) | {
            relation_type: r.relation_type,
            label: r.label,
            from_id: startNode(r).id,
            to_id: endNode(r).id
          }] AS pathRels
        `,
        {
          userId: params.userId,
          fromId: params.fromId,
          toId: params.toId,
          maxPaths: neo4j.int(params.maxPaths),
          relTypes: params.relationTypes,
        },
      );
      const mapped = result.records.map((record) => {
        const rawNodes = record.get("pathNodes") as Array<{
          id: string;
          title: string;
          entry_type: string;
        }>;
        const rawRels = record.get("pathRels") as Array<{
          relation_type: string;
          label: string | null;
          from_id: string;
          to_id: string;
        }>;
        const relations = rawRels.map((r) => ({
          relation_type: r.relation_type,
          ...(r.label !== null ? { label: r.label } : {}),
          from_id: r.from_id,
          to_id: r.to_id,
        }));
        return {
          nodes: rawNodes,
          relations,
          formatted: buildFormattedPath(rawNodes, relations),
        };
      });

      // Deduplicate by canonical path key (node-id sequence + relation sequence).
      // Neo4j undirected traversal can return the same physical path twice;
      // ORDER BY ensures deterministic ordering before we trim duplicates.
      const seen = new Set<string>();
      return mapped.filter((p) => {
        const key = `${p.nodes.map((n) => n.id).join(",")}|${p.relations
          .map((r) => `${r.from_id}>${r.to_id}:${r.relation_type}`)
          .join(",")}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
    } finally {
      await session.close();
    }
  }

  /**
   * Explains how two entries are connected by finding direct relations and all
   * indirect paths between them (undirected traversal).
   *
   * Returns a structured result including a human-readable `formatted` string
   * per path (e.g. "NAS <-[MANAGED_BY]- Management VM -[CONNECTS_TO]-> PiKVM").
   *
   * Both entries must exist, belong to the same namespace, and be readable by
   * the caller.
   */
  async explainRelationship(params: {
    userId: string;
    entryAId: string;
    entryBId: string;
    maxDepth: number;
    maxPaths: number;
  }): Promise<ExplainRelationshipResult> {
    if (params.entryAId === params.entryBId) {
      throw new Neo4jClientError(
        "INVALID_PARAMS",
        "entry_a_id and entry_b_id must be different",
      );
    }
    // Existence + namespace + access checks (reuse existing methods, same as findPaths)
    const resourceA = await this.getResource(params.entryAId);
    const resourceB = await this.getResource(params.entryBId);
    if (!resourceA || !resourceB) {
      throw new Neo4jClientError("RESOURCE_NOT_FOUND", "Resource not found");
    }
    if (resourceA.namespace !== resourceB.namespace) {
      throw new Neo4jClientError(
        "INVALID_PARAMS",
        "Entries must belong to the same namespace",
      );
    }
    const roleA = await this.getEffectiveRole(params.userId, params.entryAId);
    const roleB = await this.getEffectiveRole(params.userId, params.entryBId);
    if (
      !Neo4jClient.hasReadPermission(roleA) ||
      !Neo4jClient.hasReadPermission(roleB)
    ) {
      throw new Neo4jClientError("PERMISSION_DENIED", "Permission denied");
    }

    const entry_a = {
      id: resourceA.id,
      title: resourceA.title,
      entry_type: resourceA.entry_type,
    };
    const entry_b = {
      id: resourceB.id,
      title: resourceB.title,
      entry_type: resourceB.entry_type,
    };

    const depthLiteral = params.maxDepth;
    const session = this.driver.session();
    try {
      // Step 1: direct relations (bidirectional)
      const directResult = await session.run(
        `
        MATCH (a:Resource {id: $entryAId})-[r:ENTRY_RELATION]-(b:Resource {id: $entryBId})
        RETURN r.relation_type AS relation_type, r.label AS label,
               startNode(r).id AS from_id
        `,
        { entryAId: params.entryAId, entryBId: params.entryBId },
      );
      const direct_relations = directResult.records.map((record) => {
        const fromId = record.get("from_id") as string;
        const label = record.get("label") as string | null;
        return {
          relation_type: record.get("relation_type") as string,
          ...(label !== null ? { label } : {}),
          direction: (fromId === params.entryAId ? "a_to_b" : "b_to_a") as
            | "a_to_b"
            | "b_to_a",
        };
      });

      // Step 2: indirect paths (undirected, shortest first, deterministic)
      const pathResult = await session.run(
        `
        MATCH path = (a:Resource {id: $entryAId})-[:ENTRY_RELATION*1..${depthLiteral}]-(b:Resource {id: $entryBId})
        WHERE ALL(n IN nodes(path) WHERE EXISTS { MATCH (:User {id: $userId})-[:OWNS|HAS_ACCESS]->(n) })
        WITH path ORDER BY length(path), [n IN nodes(path) | n.id]
        LIMIT $maxPaths
        RETURN
          [n IN nodes(path) | { id: n.id, title: n.title, entry_type: n.entry_type }] AS pathNodes,
          [r IN relationships(path) | {
            relation_type: r.relation_type,
            label: r.label,
            from_id: startNode(r).id,
            to_id: endNode(r).id
          }] AS pathRels
        `,
        {
          userId: params.userId,
          entryAId: params.entryAId,
          entryBId: params.entryBId,
          maxPaths: neo4j.int(params.maxPaths),
        },
      );
      const paths: RelationshipPath[] = pathResult.records.map((record) => {
        const rawNodes = record.get("pathNodes") as Array<{
          id: string;
          title: string;
          entry_type: string;
        }>;
        const rawRels = record.get("pathRels") as Array<{
          relation_type: string;
          label: string | null;
          from_id: string;
          to_id: string;
        }>;
        const relations = rawRels.map((r) => ({
          relation_type: r.relation_type,
          ...(r.label !== null ? { label: r.label } : {}),
          from_id: r.from_id,
          to_id: r.to_id,
        }));
        return {
          nodes: rawNodes,
          relations,
          formatted: buildFormattedPath(rawNodes, relations),
        };
      });

      return {
        entry_a,
        entry_b,
        direct_relations,
        paths,
        connected: direct_relations.length > 0 || paths.length > 0,
      };
    } finally {
      await session.close();
    }
  }

  /**
   * Returns the count of ENTRY_RELATION edges connected to `resourceId`,
   * split by direction (outbound / inbound).
   *
   * Only edges where the opposite node is accessible to `userId` are counted,
   * preventing degree-leak of inaccessible entries in multi-tenant graphs.
   * Uses two isolated CALL subqueries to avoid Cartesian multiplication.
   */
  async getRelationSummary(
    resourceId: string,
    userId: string,
  ): Promise<{ outbound: number; inbound: number }> {
    const session = this.driver.session();
    try {
      const result = await session.run(
        `
        MATCH (r:Resource {id: $id})
        CALL {
          WITH r
          OPTIONAL MATCH (r)-[out:ENTRY_RELATION]->(other)
            WHERE EXISTS { MATCH (:User {id: $userId})-[:OWNS|HAS_ACCESS]->(other) }
          RETURN count(DISTINCT out) AS outbound
        }
        CALL {
          WITH r
          OPTIONAL MATCH (other2)-[in:ENTRY_RELATION]->(r)
            WHERE EXISTS { MATCH (:User {id: $userId})-[:OWNS|HAS_ACCESS]->(other2) }
          RETURN count(DISTINCT in) AS inbound
        }
        RETURN outbound, inbound
        `,
        { id: resourceId, userId },
      );
      const record = result.records[0];
      if (!record) return { outbound: 0, inbound: 0 };
      const outbound = (record.get("outbound") as neo4j.Integer).toNumber();
      const inbound = (record.get("inbound") as neo4j.Integer).toNumber();
      return { outbound, inbound };
    } finally {
      await session.close();
    }
  }

  /**
   * Finds all entries that transitively reference (point to) `entryId` via
   * outbound ENTRY_RELATION edges, up to `maxDepth` hops away (inbound traversal
   * from the anchor's perspective).
   *
   * Only accessible nodes are included; paths through inaccessible nodes are
   * excluded. Results are grouped by hop distance from the anchor entry.
   * `limit` caps the total number of unique impacted entries returned.
   */
  async impactAnalysis(params: {
    userId: string;
    entryId: string;
    maxDepth: number;
    relationTypes: string[] | null;
    limit: number;
  }): Promise<{ layers: ExpandContextLayer[]; total_impacted: number }> {
    const entry = await this.getResource(params.entryId);
    if (!entry) {
      throw new Neo4jClientError("RESOURCE_NOT_FOUND", "Resource not found");
    }
    const role = await this.getEffectiveRole(params.userId, params.entryId);
    if (!Neo4jClient.hasReadPermission(role)) {
      throw new Neo4jClientError("PERMISSION_DENIED", "Permission denied");
    }
    if (params.relationTypes !== null) {
      for (const rt of params.relationTypes) {
        if (!ENTRY_RELATION_TYPE_REGEX.test(rt)) {
          throw new Neo4jClientError(
            "INVALID_PARAMS",
            `relation_type must be UPPER_SNAKE_CASE: ${rt}`,
          );
        }
      }
    }

    // Embed depth literal — Neo4j does not allow parameters in range bounds.
    const depthLiteral = params.maxDepth;
    const session = this.driver.session();
    try {
      const result = await session.run(
        `
        MATCH path = (impacted:Resource)-[:ENTRY_RELATION*1..${depthLiteral}]->(start:Resource {id: $entryId})
        WHERE impacted.namespace = start.namespace
          AND ALL(n IN nodes(path) WHERE
            n = start OR EXISTS { MATCH (:User {id: $userId})-[:OWNS|HAS_ACCESS]->(n) }
          )
          AND ($relTypes IS NULL OR ALL(r IN relationships(path) WHERE r.relation_type IN $relTypes))
        WITH impacted, min(length(path)) AS distance
        ORDER BY distance, impacted.id
        LIMIT $limit
        WITH distance, collect({ id: impacted.id, title: impacted.title }) AS entries
        RETURN distance, entries
        ORDER BY distance
        `,
        {
          userId: params.userId,
          entryId: params.entryId,
          relTypes: params.relationTypes,
          limit: neo4j.int(params.limit),
        },
      );
      const layers: ExpandContextLayer[] = result.records.map((record) => ({
        distance: neo4j.integer.toNumber(record.get("distance")),
        entries: record.get("entries") as Array<{ id: string; title: string }>,
      }));
      const total_impacted = layers.reduce(
        (sum, l) => sum + l.entries.length,
        0,
      );
      return { layers, total_impacted };
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
      throw new Neo4jClientError("RESOURCE_NOT_FOUND", "Resource not found");
    }
    const role = await this.getEffectiveRole(userId, entryId);
    if (!Neo4jClient.hasReadPermission(role)) {
      throw new Neo4jClientError("PERMISSION_DENIED", "Permission denied");
    }
    if (
      relationType !== undefined &&
      !ENTRY_RELATION_TYPE_REGEX.test(relationType)
    ) {
      throw new Neo4jClientError(
        "INVALID_PARAMS",
        "relation_type must be UPPER_SNAKE_CASE",
      );
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
      return result.records.map(
        (record) => record.get("other").properties as Resource,
      );
    } finally {
      await session.close();
    }
  }
}

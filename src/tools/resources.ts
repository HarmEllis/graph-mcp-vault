import { z } from "zod";
import { ErrorCode } from "../errors.js";
import { zNamespace } from "../namespace.js";
import {
  ENTRY_RELATION_TYPE_REGEX,
  type EntryRelationDirection,
  type MatchMode,
  type Neo4jClient,
  Neo4jClientError,
} from "../neo4j-client.js";
import {
  DEFAULT_EXPAND_CONTEXT_LIMIT,
  DEFAULT_IMPACT_LIMIT,
  DEFAULT_LIST_RELATIONS_LIMIT,
  DEFAULT_MAX_DEPTH,
  DEFAULT_MAX_HOPS,
  DEFAULT_MAX_PATHS,
  MAX_DEPTH_CAP,
  MAX_EXPAND_CONTEXT_LIMIT,
  MAX_HOPS_CAP,
  MAX_IMPACT_LIMIT,
  MAX_LIST_RELATIONS_LIMIT,
  MAX_PATHS_CAP,
} from "./graph-constants.js";
import {
  type RegisteredTool,
  type ToolContext,
  ToolError,
} from "./registry.js";

// ── Permission helpers ────────────────────────────────────────────────────────

type Permission = "read" | "write" | "delete";

function hasPermission(
  role: "owner" | "editor" | "viewer" | null,
  permission: Permission,
): boolean {
  if (role === null) return false;
  if (role === "owner") return true;
  if (role === "editor") return permission === "read" || permission === "write";
  // viewer
  return permission === "read";
}

/**
 * Resolves the caller's effective role on an entry, throwing the appropriate
 * ToolError if the entry is absent or the permission is insufficient.
 */
async function requirePermission(
  neo4jClient: Neo4jClient,
  userId: string,
  entryId: string,
  permission: Permission,
): Promise<"owner" | "editor" | "viewer"> {
  const resource = await neo4jClient.getResource(entryId);
  if (!resource)
    throw new ToolError(ErrorCode.RESOURCE_NOT_FOUND, "Resource not found");

  const role = await neo4jClient.getEffectiveRole(userId, entryId);
  if (role === null || !hasPermission(role, permission)) {
    throw new ToolError(ErrorCode.PERMISSION_DENIED, "Permission denied");
  }
  return role;
}

function throwMappedClientError(error: unknown): never {
  if (error instanceof Neo4jClientError) {
    if (error.code === "INVALID_PARAMS") {
      throw new ToolError(ErrorCode.INVALID_PARAMS, error.message);
    }
    if (error.code === "RESOURCE_NOT_FOUND") {
      throw new ToolError(ErrorCode.RESOURCE_NOT_FOUND, error.message);
    }
    if (error.code === "PERMISSION_DENIED") {
      throw new ToolError(ErrorCode.PERMISSION_DENIED, error.message);
    }
  }
  throw error;
}

// ── Shared metadata schema ────────────────────────────────────────────────────

const metadataSchema = z.object({
  topic: z.string().optional(),
  tags: z.array(z.string().min(1).max(100)).max(50).optional(),
  summary: z.string().optional(),
  source: z.string().max(2048).optional(),
  last_verified_at: z.string().datetime().optional(),
});

// ── knowledge_create_entry ────────────────────────────────────────────────────

const createSchema = z
  .object({
    entry_type: z.string().min(1),
    title: z.string().min(1),
    content: z.string(),
    namespace: zNamespace.optional(),
  })
  .merge(metadataSchema);

async function handleCreate(
  args: Record<string, unknown>,
  ctx: ToolContext,
  neo4jClient: Neo4jClient,
): Promise<unknown> {
  const parsed = createSchema.safeParse(args);
  if (!parsed.success) {
    throw new ToolError(
      ErrorCode.INVALID_PARAMS,
      `Invalid params: ${parsed.error.message}`,
    );
  }
  const {
    entry_type,
    title,
    content,
    namespace,
    topic,
    tags,
    summary,
    source,
    last_verified_at,
  } = parsed.data;
  const effectiveNamespace = namespace ?? ctx.namespace;

  const created = await neo4jClient.createResource({
    userId: ctx.userId,
    namespace: effectiveNamespace,
    entry_type,
    title,
    content,
    ...(topic !== undefined && { topic }),
    ...(tags !== undefined && { tags }),
    ...(summary !== undefined && { summary }),
    ...(source !== undefined && { source }),
    ...(last_verified_at !== undefined && { last_verified_at }),
  });

  const cfg = await neo4jClient.getNamespaceConfig(
    ctx.userId,
    effectiveNamespace,
  );
  if (!cfg.auto_share) return created;

  const granted_role =
    cfg.auto_share_permission === "write" ? "editor" : "viewer";
  const targetUserIds = cfg.auto_share_user_ids.filter(
    (targetUserId) => targetUserId !== ctx.userId,
  );
  const shared_with = await neo4jClient.shareResourceWithUsers({
    resourceId: created.id,
    targetUserIds,
    role: granted_role,
  });

  return {
    ...created,
    auto_share: {
      enabled: true,
      permission: cfg.auto_share_permission,
      granted_role,
      shared_with_count: shared_with.length,
      shared_with,
    },
  };
}

// ── knowledge_get_entry ───────────────────────────────────────────────────────

const getSchema = z.object({ entry_id: z.string().min(1) });

async function handleGet(
  args: Record<string, unknown>,
  ctx: ToolContext,
  neo4jClient: Neo4jClient,
): Promise<unknown> {
  const parsed = getSchema.safeParse(args);
  if (!parsed.success) {
    throw new ToolError(
      ErrorCode.INVALID_PARAMS,
      `Invalid params: ${parsed.error.message}`,
    );
  }
  const { entry_id } = parsed.data;

  const resource = await neo4jClient.getResource(entry_id);
  if (!resource)
    throw new ToolError(ErrorCode.RESOURCE_NOT_FOUND, "Resource not found");

  const role = await neo4jClient.getEffectiveRole(ctx.userId, entry_id);
  if (role === null)
    throw new ToolError(ErrorCode.PERMISSION_DENIED, "Permission denied");

  const { outbound, inbound } = await neo4jClient.getRelationSummary(
    entry_id,
    ctx.userId,
  );
  return {
    ...resource,
    role,
    relation_summary: { outbound, inbound, total: outbound + inbound },
  };
}

// ── knowledge_list_entries ────────────────────────────────────────────────────

const listSchema = z.object({
  namespace: zNamespace.optional(),
  entry_type: z.string().optional(),
  limit: z.number().int().positive().optional(),
  skip: z.number().int().min(0).optional(),
});

async function handleList(
  args: Record<string, unknown>,
  ctx: ToolContext,
  neo4jClient: Neo4jClient,
): Promise<unknown> {
  const parsed = listSchema.safeParse(args);
  if (!parsed.success) {
    throw new ToolError(
      ErrorCode.INVALID_PARAMS,
      `Invalid params: ${parsed.error.message}`,
    );
  }
  const resources = await neo4jClient.listResources({
    userId: ctx.userId,
    namespace: parsed.data.namespace ?? ctx.namespace,
    ...(parsed.data.entry_type !== undefined && {
      entry_type: parsed.data.entry_type,
    }),
    ...(parsed.data.limit !== undefined && { limit: parsed.data.limit }),
    ...(parsed.data.skip !== undefined && { skip: parsed.data.skip }),
  });
  return { resources };
}

// ── knowledge_update_entry ────────────────────────────────────────────────────

const updateSchema = z
  .object({
    entry_id: z.string().min(1),
    title: z.string().min(1).optional(),
    content: z.string().optional(),
    entry_type: z.string().min(1).optional(),
    namespace: zNamespace.optional(),
  })
  .merge(metadataSchema);

async function handleUpdate(
  args: Record<string, unknown>,
  ctx: ToolContext,
  neo4jClient: Neo4jClient,
): Promise<unknown> {
  const parsed = updateSchema.safeParse(args);
  if (!parsed.success) {
    throw new ToolError(
      ErrorCode.INVALID_PARAMS,
      `Invalid params: ${parsed.error.message}`,
    );
  }
  const {
    entry_id,
    title,
    content,
    entry_type,
    namespace,
    topic,
    tags,
    summary,
    source,
    last_verified_at,
  } = parsed.data;

  await requirePermission(neo4jClient, ctx.userId, entry_id, "write");
  try {
    await neo4jClient.updateResource(entry_id, {
      ...(title !== undefined && { title }),
      ...(content !== undefined && { content }),
      ...(entry_type !== undefined && { entry_type }),
      ...(namespace !== undefined && { namespace }),
      ...(topic !== undefined && { topic }),
      ...(tags !== undefined && { tags }),
      ...(summary !== undefined && { summary }),
      ...(source !== undefined && { source }),
      ...(last_verified_at !== undefined && { last_verified_at }),
    });
  } catch (error) {
    throwMappedClientError(error);
  }
  return {};
}

// ── knowledge_delete_entry ────────────────────────────────────────────────────

const deleteSchema = z.object({ entry_id: z.string().min(1) });

async function handleDelete(
  args: Record<string, unknown>,
  ctx: ToolContext,
  neo4jClient: Neo4jClient,
): Promise<unknown> {
  const parsed = deleteSchema.safeParse(args);
  if (!parsed.success) {
    throw new ToolError(
      ErrorCode.INVALID_PARAMS,
      `Invalid params: ${parsed.error.message}`,
    );
  }
  const { entry_id } = parsed.data;

  await requirePermission(neo4jClient, ctx.userId, entry_id, "delete");
  await neo4jClient.deleteResource(entry_id);
  return {};
}

// ── knowledge_search_entries ──────────────────────────────────────────────────

const searchSchema = z.object({
  query: z.string().min(1),
  namespace: zNamespace.optional(),
  all_namespaces: z.boolean().optional(),
  entry_type: z.string().optional(),
  limit: z.number().int().positive().optional(),
  skip: z.number().int().min(0).optional(),
  match_mode: z.enum(["exact", "fulltext", "fuzzy"]).optional(),
});

async function handleSearch(
  args: Record<string, unknown>,
  ctx: ToolContext,
  neo4jClient: Neo4jClient,
): Promise<unknown> {
  const parsed = searchSchema.safeParse(args);
  if (!parsed.success) {
    throw new ToolError(
      ErrorCode.INVALID_PARAMS,
      `Invalid params: ${parsed.error.message}`,
    );
  }
  const { namespace } = parsed.data;

  // Default: search all accessible namespaces (undefined → NULL in Neo4j = no namespace filter).
  // Pass namespace explicitly to scope results to a single namespace.
  // all_namespaces is kept for backwards compatibility but is a no-op — all namespaces are
  // searched by default. When namespace is also provided, namespace takes precedence.
  const effectiveNamespace = namespace ?? undefined;

  const resources = await neo4jClient.searchResources({
    userId: ctx.userId,
    query: parsed.data.query,
    ...(effectiveNamespace !== undefined && { namespace: effectiveNamespace }),
    ...(parsed.data.entry_type !== undefined && {
      entry_type: parsed.data.entry_type,
    }),
    ...(parsed.data.limit !== undefined && { limit: parsed.data.limit }),
    ...(parsed.data.skip !== undefined && { skip: parsed.data.skip }),
    ...(parsed.data.match_mode !== undefined && {
      match_mode: parsed.data.match_mode as MatchMode,
    }),
  });

  // Hint: when the query contains structured tokens (IPs, paths, versions, emails) and
  // the caller is using fuzzy mode, suggest a more precise match mode.
  const tokens = parsed.data.query.split(/\s+/).filter(Boolean);
  const hasStructuredTokens = tokens.some((t) => /[./:@]/.test(t));
  const hint =
    hasStructuredTokens && (parsed.data.match_mode ?? "fuzzy") === "fuzzy"
      ? "Query contains structured tokens (e.g. IP address, path, version). " +
        "For precise matching retry with match_mode:'fulltext' (keyword) or match_mode:'exact' (phrase)."
      : undefined;

  return { resources, ...(hint !== undefined && { hint }) };
}

// ── knowledge_create_relation ─────────────────────────────────────────────────

const relationTypeSchema = z
  .string()
  .regex(ENTRY_RELATION_TYPE_REGEX, "relation_type must be UPPER_SNAKE_CASE");

const createRelationSchema = z.object({
  from_id: z.string().min(1),
  to_id: z.string().min(1),
  relation_type: relationTypeSchema,
  label: z.string().optional(),
});

async function handleCreateRelation(
  args: Record<string, unknown>,
  ctx: ToolContext,
  neo4jClient: Neo4jClient,
): Promise<unknown> {
  const parsed = createRelationSchema.safeParse(args);
  if (!parsed.success) {
    throw new ToolError(
      ErrorCode.INVALID_PARAMS,
      `Invalid params: ${parsed.error.message}`,
    );
  }
  const { from_id, to_id, relation_type, label } = parsed.data;

  try {
    await neo4jClient.createEntryRelation(
      ctx.userId,
      from_id,
      to_id,
      relation_type,
      label,
    );
    return {};
  } catch (error) {
    throwMappedClientError(error);
  }
}

// ── knowledge_delete_relation ─────────────────────────────────────────────────

const deleteRelationSchema = z.object({
  from_id: z.string().min(1),
  to_id: z.string().min(1),
  relation_type: relationTypeSchema,
});

async function handleDeleteRelation(
  args: Record<string, unknown>,
  ctx: ToolContext,
  neo4jClient: Neo4jClient,
): Promise<unknown> {
  const parsed = deleteRelationSchema.safeParse(args);
  if (!parsed.success) {
    throw new ToolError(
      ErrorCode.INVALID_PARAMS,
      `Invalid params: ${parsed.error.message}`,
    );
  }
  const { from_id, to_id, relation_type } = parsed.data;

  try {
    await neo4jClient.deleteEntryRelation(
      ctx.userId,
      from_id,
      to_id,
      relation_type,
    );
    return {};
  } catch (error) {
    throwMappedClientError(error);
  }
}

// ── knowledge_list_relations ──────────────────────────────────────────────────

const listRelationsSchema = z.object({
  entry_id: z.string().min(1),
  direction: z.enum(["outbound", "inbound", "both"]).optional(),
  limit: z.number().int().positive().max(MAX_LIST_RELATIONS_LIMIT).optional(),
});

async function handleListRelations(
  args: Record<string, unknown>,
  ctx: ToolContext,
  neo4jClient: Neo4jClient,
): Promise<unknown> {
  const parsed = listRelationsSchema.safeParse(args);
  if (!parsed.success) {
    throw new ToolError(
      ErrorCode.INVALID_PARAMS,
      `Invalid params: ${parsed.error.message}`,
    );
  }
  const { entry_id, direction, limit: rawLimit } = parsed.data;
  const limit = rawLimit ?? DEFAULT_LIST_RELATIONS_LIMIT;

  try {
    const relations = await neo4jClient.listEntryRelations(
      ctx.userId,
      entry_id,
      (direction ?? "both") as EntryRelationDirection,
      limit,
    );
    return { relations };
  } catch (error) {
    throwMappedClientError(error);
  }
}

// ── knowledge_expand_context ──────────────────────────────────────────────────

const relationTypesItemSchema = z
  .string()
  .regex(ENTRY_RELATION_TYPE_REGEX, "relation_type must be UPPER_SNAKE_CASE");

const expandContextSchema = z.object({
  entry_id: z.string().min(1),
  direction: z.enum(["outbound", "inbound", "both"]).optional(),
  max_hops: z.number().int().positive().max(MAX_HOPS_CAP).optional(),
  relation_types: z.array(relationTypesItemSchema).optional(),
  limit: z.number().int().positive().max(MAX_EXPAND_CONTEXT_LIMIT).optional(),
});

async function handleExpandContext(
  args: Record<string, unknown>,
  ctx: ToolContext,
  neo4jClient: Neo4jClient,
): Promise<unknown> {
  const parsed = expandContextSchema.safeParse(args);
  if (!parsed.success) {
    throw new ToolError(
      ErrorCode.INVALID_PARAMS,
      `Invalid params: ${parsed.error.message}`,
    );
  }
  const {
    entry_id,
    direction,
    max_hops: rawHops,
    relation_types,
    limit: rawLimit,
  } = parsed.data;
  const maxHops = rawHops ?? DEFAULT_MAX_HOPS;
  const limit = rawLimit ?? DEFAULT_EXPAND_CONTEXT_LIMIT;

  try {
    const layers = await neo4jClient.expandContext({
      userId: ctx.userId,
      entryId: entry_id,
      direction: (direction ?? "both") as EntryRelationDirection,
      maxHops,
      relationTypes: relation_types ?? null,
      limit,
    });
    return { layers };
  } catch (error) {
    throwMappedClientError(error);
  }
}

// ── knowledge_find_paths ──────────────────────────────────────────────────────

const findPathsSchema = z.object({
  from_id: z.string().min(1),
  to_id: z.string().min(1),
  max_depth: z.number().int().positive().max(MAX_DEPTH_CAP).optional(),
  max_paths: z.number().int().positive().max(MAX_PATHS_CAP).optional(),
  relation_types: z.array(relationTypesItemSchema).optional(),
  direction: z.enum(["outbound", "inbound", "both"]).optional(),
});

async function handleFindPaths(
  args: Record<string, unknown>,
  ctx: ToolContext,
  neo4jClient: Neo4jClient,
): Promise<unknown> {
  const parsed = findPathsSchema.safeParse(args);
  if (!parsed.success) {
    throw new ToolError(
      ErrorCode.INVALID_PARAMS,
      `Invalid params: ${parsed.error.message}`,
    );
  }
  const {
    from_id,
    to_id,
    max_depth: rawDepth,
    max_paths: rawPaths,
    relation_types,
    direction,
  } = parsed.data;
  const maxDepth = rawDepth ?? DEFAULT_MAX_DEPTH;
  const maxPaths = rawPaths ?? DEFAULT_MAX_PATHS;
  const dir = direction ?? "both";

  try {
    const paths = await neo4jClient.findPaths({
      userId: ctx.userId,
      fromId: from_id,
      toId: to_id,
      maxDepth,
      maxPaths,
      relationTypes: relation_types ?? null,
      direction: dir,
    });

    // Hint: when no path found and direction was explicit, suggest alternatives
    const hint =
      paths.length === 0 && direction !== undefined && direction !== "both"
        ? `No path found in direction '${dir}'. Try direction:'both' to search in all directions, or swap from_id and to_id.`
        : undefined;

    return { paths, ...(hint !== undefined && { hint }) };
  } catch (error) {
    throwMappedClientError(error);
  }
}

// ── knowledge_explain_relationship ────────────────────────────────────────────

const explainRelationshipSchema = z.object({
  entry_a_id: z.string().min(1),
  entry_b_id: z.string().min(1),
  max_depth: z.number().int().positive().max(MAX_DEPTH_CAP).optional(),
  max_paths: z.number().int().positive().max(MAX_PATHS_CAP).optional(),
});

async function handleExplainRelationship(
  args: Record<string, unknown>,
  ctx: ToolContext,
  neo4jClient: Neo4jClient,
): Promise<unknown> {
  const parsed = explainRelationshipSchema.safeParse(args);
  if (!parsed.success) {
    throw new ToolError(
      ErrorCode.INVALID_PARAMS,
      `Invalid params: ${parsed.error.message}`,
    );
  }
  const {
    entry_a_id,
    entry_b_id,
    max_depth: rawDepth,
    max_paths: rawPaths,
  } = parsed.data;

  if (entry_a_id === entry_b_id) {
    throw new ToolError(
      ErrorCode.INVALID_PARAMS,
      "entry_a_id and entry_b_id must be different",
    );
  }

  const maxDepth = rawDepth ?? DEFAULT_MAX_DEPTH;
  const maxPaths = rawPaths ?? DEFAULT_MAX_PATHS;

  try {
    return await neo4jClient.explainRelationship({
      userId: ctx.userId,
      entryAId: entry_a_id,
      entryBId: entry_b_id,
      maxDepth,
      maxPaths,
    });
  } catch (error) {
    throwMappedClientError(error);
  }
}

// ── knowledge_impact_analysis ─────────────────────────────────────────────────

const impactAnalysisSchema = z.object({
  entry_id: z.string().min(1),
  max_depth: z.number().int().positive().max(MAX_DEPTH_CAP).optional(),
  relation_types: z.array(relationTypesItemSchema).optional(),
  limit: z.number().int().positive().max(MAX_IMPACT_LIMIT).optional(),
});

async function handleImpactAnalysis(
  args: Record<string, unknown>,
  ctx: ToolContext,
  neo4jClient: Neo4jClient,
): Promise<unknown> {
  const parsed = impactAnalysisSchema.safeParse(args);
  if (!parsed.success) {
    throw new ToolError(
      ErrorCode.INVALID_PARAMS,
      `Invalid params: ${parsed.error.message}`,
    );
  }
  const {
    entry_id,
    max_depth: rawDepth,
    relation_types,
    limit: rawLimit,
  } = parsed.data;
  const maxDepth = rawDepth ?? DEFAULT_MAX_DEPTH;
  const limit = rawLimit ?? DEFAULT_IMPACT_LIMIT;

  try {
    const result = await neo4jClient.impactAnalysis({
      userId: ctx.userId,
      entryId: entry_id,
      maxDepth,
      relationTypes: relation_types ?? null,
      limit,
    });
    return result;
  } catch (error) {
    throwMappedClientError(error);
  }
}

// ── knowledge_list_namespaces ─────────────────────────────────────────────────

async function handleListNamespaces(
  _args: Record<string, unknown>,
  ctx: ToolContext,
  neo4jClient: Neo4jClient,
): Promise<unknown> {
  const namespaces = await neo4jClient.listNamespaces({ userId: ctx.userId });

  // Ensure the current session namespace is always present, even with zero counts
  if (!namespaces.some((n) => n.namespace === ctx.namespace)) {
    namespaces.push({
      namespace: ctx.namespace,
      owned_count: 0,
      shared_count: 0,
    });
    namespaces.sort((a, b) => a.namespace.localeCompare(b.namespace));
  }

  return { namespaces };
}

// ── Factory ───────────────────────────────────────────────────────────────────

/**
 * Returns the knowledge entry tool registrations, each closing over `neo4jClient`.
 */
export function createResourceTools(
  neo4jClient: Neo4jClient,
): RegisteredTool[] {
  return [
    {
      descriptor: {
        name: "knowledge_create_entry",
        description:
          "Save a new knowledge entry to the memory bank. Use this to store notes, decisions, facts, documentation snippets, or any information that should be remembered. Always retrieve before creating to avoid duplicates.",
        inputSchema: {
          type: "object",
          properties: {
            entry_type: {
              type: "string",
              description: "Entry type (e.g. note, decision, fact, reference)",
            },
            title: { type: "string", description: "Short descriptive title" },
            content: {
              type: "string",
              description:
                "Full text of the knowledge entry. Write in Markdown format.",
            },
            namespace: {
              type: "string",
              description: "Namespace override (optional)",
            },
            topic: {
              type: "string",
              description: "Broad subject area (optional)",
            },
            tags: {
              type: "array",
              items: { type: "string" },
              description:
                "Keyword tags for filtering and search (optional, max 50)",
            },
            summary: {
              type: "string",
              description: "One-sentence summary for quick scanning (optional)",
            },
            source: {
              type: "string",
              description: "Origin URL or citation (optional, max 2048 chars)",
            },
            last_verified_at: {
              type: "string",
              description:
                "ISO 8601 datetime when this entry was last verified (optional)",
            },
          },
          required: ["entry_type", "title", "content"],
        },
      },
      handler: (args, ctx) => handleCreate(args, ctx, neo4jClient),
    },
    {
      descriptor: {
        name: "knowledge_get_entry",
        description:
          "Retrieve a specific knowledge entry by its ID. Use this to read a known entry in full. Requires at least read access.",
        inputSchema: {
          type: "object",
          properties: {
            entry_id: { type: "string", description: "UUID of the entry" },
          },
          required: ["entry_id"],
        },
      },
      handler: (args, ctx) => handleGet(args, ctx, neo4jClient),
    },
    {
      descriptor: {
        name: "knowledge_list_entries",
        description:
          "List all knowledge entries the caller can read (owned and shared) in a namespace. Use this to browse the memory bank or discover what has been stored.",
        inputSchema: {
          type: "object",
          properties: {
            namespace: {
              type: "string",
              description: "Namespace to list (defaults to session namespace)",
            },
            entry_type: { type: "string", description: "Filter by entry type" },
            limit: { type: "number", description: "Max results (default 50)" },
            skip: {
              type: "number",
              description: "Pagination offset (default 0)",
            },
          },
          required: [],
        },
      },
      handler: (args, ctx) => handleList(args, ctx, neo4jClient),
    },
    {
      descriptor: {
        name: "knowledge_update_entry",
        description:
          "Update the title, content, or metadata of a knowledge entry. Requires editor or owner role. Retrieve the entry first to see its current state.",
        inputSchema: {
          type: "object",
          properties: {
            entry_id: {
              type: "string",
              description: "UUID of the entry to update",
            },
            title: { type: "string" },
            content: {
              type: "string",
              description:
                "Full text of the knowledge entry. Write in Markdown format.",
            },
            entry_type: {
              type: "string",
              description: "Change the entry type (e.g. note, decision, fact)",
            },
            namespace: {
              type: "string",
              description:
                "Move entry to a different namespace. Not allowed if the entry has existing relations.",
            },
            topic: { type: "string" },
            tags: { type: "array", items: { type: "string" } },
            summary: { type: "string" },
            source: { type: "string" },
            last_verified_at: { type: "string" },
          },
          required: ["entry_id"],
        },
      },
      handler: (args, ctx) => handleUpdate(args, ctx, neo4jClient),
    },
    {
      descriptor: {
        name: "knowledge_delete_entry",
        description:
          "Permanently delete a knowledge entry and all its access grants. Owner only. This action is irreversible.",
        inputSchema: {
          type: "object",
          properties: { entry_id: { type: "string" } },
          required: ["entry_id"],
        },
      },
      handler: (args, ctx) => handleDelete(args, ctx, neo4jClient),
    },
    {
      descriptor: {
        name: "knowledge_create_relation",
        description:
          "Create a typed relation between two knowledge entries. Requires read access to both entries.",
        inputSchema: {
          type: "object",
          properties: {
            from_id: {
              type: "string",
              description: "UUID of the source entry",
            },
            to_id: { type: "string", description: "UUID of the target entry" },
            relation_type: {
              type: "string",
              description:
                "Relation type in UPPER_SNAKE_CASE (e.g. DEPENDS_ON)",
            },
            label: {
              type: "string",
              description: "Optional free-text relation label",
            },
          },
          required: ["from_id", "to_id", "relation_type"],
        },
      },
      handler: (args, ctx) => handleCreateRelation(args, ctx, neo4jClient),
    },
    {
      descriptor: {
        name: "knowledge_delete_relation",
        description:
          "Delete a typed relation between two entries. Requires owner role on the source entry.",
        inputSchema: {
          type: "object",
          properties: {
            from_id: {
              type: "string",
              description: "UUID of the source entry",
            },
            to_id: { type: "string", description: "UUID of the target entry" },
            relation_type: {
              type: "string",
              description: "Relation type in UPPER_SNAKE_CASE",
            },
          },
          required: ["from_id", "to_id", "relation_type"],
        },
      },
      handler: (args, ctx) => handleDeleteRelation(args, ctx, neo4jClient),
    },
    {
      descriptor: {
        name: "knowledge_list_relations",
        description:
          "List entry relations for one entry. Returns outbound, inbound, or both directions.",
        inputSchema: {
          type: "object",
          properties: {
            entry_id: { type: "string", description: "UUID of the entry" },
            direction: {
              type: "string",
              enum: ["outbound", "inbound", "both"],
              description: "Direction filter (default both)",
            },
            limit: {
              type: "number",
              description: `Max relations to return (default ${DEFAULT_LIST_RELATIONS_LIMIT}, max ${MAX_LIST_RELATIONS_LIMIT})`,
            },
          },
          required: ["entry_id"],
        },
      },
      handler: (args, ctx) => handleListRelations(args, ctx, neo4jClient),
    },
    {
      descriptor: {
        name: "knowledge_search_entries",
        description:
          'Search the knowledge memory bank by keyword. Always call this before creating new entries to avoid duplicates. Only returns entries the caller can read.\n\nSearch strategy:\n- By default, searches ALL namespaces you can access. Use namespace to restrict to one namespace.\n- For structured data (IP addresses, version numbers, file paths, domain names) use match_mode:"fulltext" or match_mode:"exact" — fuzzy mode may return false matches for these.\n- Use match_mode:"fuzzy" (default) for natural-language keywords where typo tolerance helps.\n- Each result includes a score field (higher = stronger match); results with a very low score relative to others are weak matches.\n- If the response includes a hint field, it suggests a more precise search mode for your query.',
        inputSchema: {
          type: "object",
          properties: {
            query: { type: "string", description: "Search keywords or phrase" },
            namespace: {
              type: "string",
              description:
                "Restrict results to this namespace. Omit to search all accessible namespaces.",
            },
            all_namespaces: {
              type: "boolean",
              description:
                "Deprecated no-op — all namespaces are searched by default. Kept for backwards compatibility.",
            },
            entry_type: { type: "string", description: "Filter by entry type" },
            limit: { type: "number", description: "Max results (default 20)" },
            skip: {
              type: "number",
              description: "Pagination offset (default 0)",
            },
            match_mode: {
              type: "string",
              enum: ["exact", "fulltext", "fuzzy"],
              description:
                'Search mode: "fuzzy" (default, tolerates typos), "fulltext" (exact keyword match, best for IPs/versions/paths), or "exact" (phrase match)',
            },
          },
          required: ["query"],
        },
      },
      handler: (args, ctx) => handleSearch(args, ctx, neo4jClient),
    },
    {
      descriptor: {
        name: "knowledge_list_namespaces",
        description:
          "List all namespaces the caller owns or has shared access to, with per-namespace entry counts.",
        inputSchema: {
          type: "object",
          properties: {},
          required: [],
        },
      },
      handler: (args, ctx) => handleListNamespaces(args, ctx, neo4jClient),
    },
    {
      descriptor: {
        name: "knowledge_expand_context",
        description:
          "Expand the neighborhood of an entry by traversing entry relations up to max_hops away. Returns entries grouped by hop distance. Only includes entries the caller can read. Use this to explore related knowledge around a central entry.",
        inputSchema: {
          type: "object",
          properties: {
            entry_id: {
              type: "string",
              description: "UUID of the anchor entry",
            },
            direction: {
              type: "string",
              enum: ["outbound", "inbound", "both"],
              description: "Traversal direction (default both)",
            },
            max_hops: {
              type: "number",
              description: `Maximum hops to traverse (default ${DEFAULT_MAX_HOPS}, max ${MAX_HOPS_CAP})`,
            },
            relation_types: {
              type: "array",
              items: { type: "string" },
              description:
                "Filter to specific relation types in UPPER_SNAKE_CASE (optional)",
            },
            limit: {
              type: "number",
              description: `Max total nodes returned across all hops (default ${DEFAULT_EXPAND_CONTEXT_LIMIT}, max ${MAX_EXPAND_CONTEXT_LIMIT})`,
            },
          },
          required: ["entry_id"],
        },
      },
      handler: (args, ctx) => handleExpandContext(args, ctx, neo4jClient),
    },
    {
      descriptor: {
        name: "knowledge_find_paths",
        description:
          "Find paths between two entries via entry relations. Searches in both directions by default (undirected). Use direction to restrict to outbound-only or inbound-only traversal. Only returns paths where every intermediate node is accessible to the caller. Both entries must be in the same namespace.",
        inputSchema: {
          type: "object",
          properties: {
            from_id: {
              type: "string",
              description: "UUID of the source entry",
            },
            to_id: {
              type: "string",
              description: "UUID of the destination entry",
            },
            direction: {
              type: "string",
              enum: ["outbound", "inbound", "both"],
              description:
                "Traversal direction: 'both' (default, undirected), 'outbound' (following relation arrows), or 'inbound' (against relation arrows)",
            },
            max_depth: {
              type: "number",
              description: `Maximum path depth (default ${DEFAULT_MAX_DEPTH}, max ${MAX_DEPTH_CAP})`,
            },
            max_paths: {
              type: "number",
              description: `Maximum number of paths to return (default ${DEFAULT_MAX_PATHS}, max ${MAX_PATHS_CAP})`,
            },
            relation_types: {
              type: "array",
              items: { type: "string" },
              description:
                "Filter to specific relation types in UPPER_SNAKE_CASE (optional)",
            },
          },
          required: ["from_id", "to_id"],
        },
      },
      handler: (args, ctx) => handleFindPaths(args, ctx, neo4jClient),
    },
    {
      descriptor: {
        name: "knowledge_explain_relationship",
        description:
          "Explain how two entries are connected. Finds direct relations and all indirect paths between them (undirected, up to max_depth hops). Returns a structured result including human-readable path strings like 'NAS <-[MANAGED_BY]- Management VM -[CONNECTS_TO]-> PiKVM'. Use this as the primary tool when the user asks how two things are related.",
        inputSchema: {
          type: "object",
          properties: {
            entry_a_id: {
              type: "string",
              description: "UUID of the first entry",
            },
            entry_b_id: {
              type: "string",
              description: "UUID of the second entry",
            },
            max_depth: {
              type: "number",
              description: `Maximum path depth (default ${DEFAULT_MAX_DEPTH}, max ${MAX_DEPTH_CAP})`,
            },
            max_paths: {
              type: "number",
              description: `Maximum number of paths to return (default ${DEFAULT_MAX_PATHS}, max ${MAX_PATHS_CAP}). Pass 1 to get only the shortest path.`,
            },
          },
          required: ["entry_a_id", "entry_b_id"],
        },
      },
      handler: (args, ctx) => handleExplainRelationship(args, ctx, neo4jClient),
    },
    {
      descriptor: {
        name: "knowledge_impact_analysis",
        description:
          "Find all entries that depend on or reference a given entry, grouped by hop distance (impact layers). Identifies what would be affected if the anchor entry changes. Only readable entries are included.",
        inputSchema: {
          type: "object",
          properties: {
            entry_id: {
              type: "string",
              description: "UUID of the anchor entry to analyse",
            },
            max_depth: {
              type: "number",
              description: `Maximum traversal depth (default ${DEFAULT_MAX_DEPTH}, max ${MAX_DEPTH_CAP})`,
            },
            relation_types: {
              type: "array",
              items: { type: "string" },
              description:
                "Filter to specific relation types in UPPER_SNAKE_CASE (optional)",
            },
            limit: {
              type: "number",
              description: `Max total impacted entries returned across all layers (default ${DEFAULT_IMPACT_LIMIT}, max ${MAX_IMPACT_LIMIT})`,
            },
          },
          required: ["entry_id"],
        },
      },
      handler: (args, ctx) => handleImpactAnalysis(args, ctx, neo4jClient),
    },
  ];
}

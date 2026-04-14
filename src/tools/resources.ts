import { z } from 'zod';
import type { MatchMode, Neo4jClient } from '../neo4j-client.js';
import { ErrorCode } from '../errors.js';
import { ToolError, type RegisteredTool, type ToolContext } from './registry.js';

// ── Permission helpers ────────────────────────────────────────────────────────

type Permission = 'read' | 'write' | 'delete';

function hasPermission(
  role: 'owner' | 'editor' | 'viewer' | null,
  permission: Permission,
): boolean {
  if (role === null) return false;
  if (role === 'owner') return true;
  if (role === 'editor') return permission === 'read' || permission === 'write';
  // viewer
  return permission === 'read';
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
): Promise<'owner' | 'editor' | 'viewer'> {
  const resource = await neo4jClient.getResource(entryId);
  if (!resource) throw new ToolError(ErrorCode.RESOURCE_NOT_FOUND, 'Resource not found');

  const role = await neo4jClient.getEffectiveRole(userId, entryId);
  if (role === null || !hasPermission(role, permission)) {
    throw new ToolError(ErrorCode.PERMISSION_DENIED, 'Permission denied');
  }
  return role;
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
    namespace: z.string().optional(),
  })
  .merge(metadataSchema);

async function handleCreate(
  args: Record<string, unknown>,
  ctx: ToolContext,
  neo4jClient: Neo4jClient,
): Promise<unknown> {
  const parsed = createSchema.safeParse(args);
  if (!parsed.success) {
    throw new ToolError(ErrorCode.INVALID_PARAMS, `Invalid params: ${parsed.error.message}`);
  }
  const { entry_type, title, content, namespace, topic, tags, summary, source, last_verified_at } =
    parsed.data;
  return neo4jClient.createResource({
    userId: ctx.userId,
    namespace: namespace ?? ctx.namespace,
    entry_type,
    title,
    content,
    ...(topic !== undefined && { topic }),
    ...(tags !== undefined && { tags }),
    ...(summary !== undefined && { summary }),
    ...(source !== undefined && { source }),
    ...(last_verified_at !== undefined && { last_verified_at }),
  });
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
    throw new ToolError(ErrorCode.INVALID_PARAMS, `Invalid params: ${parsed.error.message}`);
  }
  const { entry_id } = parsed.data;

  const resource = await neo4jClient.getResource(entry_id);
  if (!resource) throw new ToolError(ErrorCode.RESOURCE_NOT_FOUND, 'Resource not found');

  const role = await neo4jClient.getEffectiveRole(ctx.userId, entry_id);
  if (role === null) throw new ToolError(ErrorCode.PERMISSION_DENIED, 'Permission denied');

  return { ...resource, role };
}

// ── knowledge_list_entries ────────────────────────────────────────────────────

const listSchema = z.object({
  namespace: z.string().optional(),
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
    throw new ToolError(ErrorCode.INVALID_PARAMS, `Invalid params: ${parsed.error.message}`);
  }
  const resources = await neo4jClient.listResources({
    userId: ctx.userId,
    namespace: parsed.data.namespace ?? ctx.namespace,
    ...(parsed.data.entry_type !== undefined && { entry_type: parsed.data.entry_type }),
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
  })
  .merge(metadataSchema);

async function handleUpdate(
  args: Record<string, unknown>,
  ctx: ToolContext,
  neo4jClient: Neo4jClient,
): Promise<unknown> {
  const parsed = updateSchema.safeParse(args);
  if (!parsed.success) {
    throw new ToolError(ErrorCode.INVALID_PARAMS, `Invalid params: ${parsed.error.message}`);
  }
  const { entry_id, title, content, topic, tags, summary, source, last_verified_at } = parsed.data;

  await requirePermission(neo4jClient, ctx.userId, entry_id, 'write');
  await neo4jClient.updateResource(entry_id, {
    ...(title !== undefined && { title }),
    ...(content !== undefined && { content }),
    ...(topic !== undefined && { topic }),
    ...(tags !== undefined && { tags }),
    ...(summary !== undefined && { summary }),
    ...(source !== undefined && { source }),
    ...(last_verified_at !== undefined && { last_verified_at }),
  });
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
    throw new ToolError(ErrorCode.INVALID_PARAMS, `Invalid params: ${parsed.error.message}`);
  }
  const { entry_id } = parsed.data;

  await requirePermission(neo4jClient, ctx.userId, entry_id, 'delete');
  await neo4jClient.deleteResource(entry_id);
  return {};
}

// ── knowledge_search_entries ──────────────────────────────────────────────────

const searchSchema = z.object({
  query: z.string().min(1),
  namespace: z.string().optional(),
  entry_type: z.string().optional(),
  limit: z.number().int().positive().optional(),
  skip: z.number().int().min(0).optional(),
  match_mode: z.enum(['exact', 'fulltext', 'fuzzy']).optional(),
});

async function handleSearch(
  args: Record<string, unknown>,
  ctx: ToolContext,
  neo4jClient: Neo4jClient,
): Promise<unknown> {
  const parsed = searchSchema.safeParse(args);
  if (!parsed.success) {
    throw new ToolError(ErrorCode.INVALID_PARAMS, `Invalid params: ${parsed.error.message}`);
  }
  const resources = await neo4jClient.searchResources({
    userId: ctx.userId,
    query: parsed.data.query,
    namespace: parsed.data.namespace ?? ctx.namespace,
    ...(parsed.data.entry_type !== undefined && { entry_type: parsed.data.entry_type }),
    ...(parsed.data.limit !== undefined && { limit: parsed.data.limit }),
    ...(parsed.data.skip !== undefined && { skip: parsed.data.skip }),
    ...(parsed.data.match_mode !== undefined && {
      match_mode: parsed.data.match_mode as MatchMode,
    }),
  });
  return { resources };
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
    namespaces.push({ namespace: ctx.namespace, owned_count: 0, shared_count: 0 });
    namespaces.sort((a, b) => a.namespace.localeCompare(b.namespace));
  }

  return { namespaces };
}

// ── Factory ───────────────────────────────────────────────────────────────────

/**
 * Returns the seven knowledge entry tool registrations, each closing over `neo4jClient`.
 */
export function createResourceTools(neo4jClient: Neo4jClient): RegisteredTool[] {
  return [
    {
      descriptor: {
        name: 'knowledge_create_entry',
        description:
          'Save a new knowledge entry to the memory bank. Use this to store notes, decisions, facts, documentation snippets, or any information that should be remembered. Always retrieve before creating to avoid duplicates.',
        inputSchema: {
          type: 'object',
          properties: {
            entry_type: {
              type: 'string',
              description: 'Entry type (e.g. note, decision, fact, reference)',
            },
            title: { type: 'string', description: 'Short descriptive title' },
            content: { type: 'string', description: 'Full text of the knowledge entry' },
            namespace: { type: 'string', description: 'Namespace override (optional)' },
            topic: { type: 'string', description: 'Broad subject area (optional)' },
            tags: {
              type: 'array',
              items: { type: 'string' },
              description: 'Keyword tags for filtering and search (optional, max 50)',
            },
            summary: {
              type: 'string',
              description: 'One-sentence summary for quick scanning (optional)',
            },
            source: {
              type: 'string',
              description: 'Origin URL or citation (optional, max 2048 chars)',
            },
            last_verified_at: {
              type: 'string',
              description: 'ISO 8601 datetime when this entry was last verified (optional)',
            },
          },
          required: ['entry_type', 'title', 'content'],
        },
      },
      handler: (args, ctx) => handleCreate(args, ctx, neo4jClient),
    },
    {
      descriptor: {
        name: 'knowledge_get_entry',
        description:
          'Retrieve a specific knowledge entry by its ID. Use this to read a known entry in full. Requires at least read access.',
        inputSchema: {
          type: 'object',
          properties: { entry_id: { type: 'string', description: 'UUID of the entry' } },
          required: ['entry_id'],
        },
      },
      handler: (args, ctx) => handleGet(args, ctx, neo4jClient),
    },
    {
      descriptor: {
        name: 'knowledge_list_entries',
        description:
          'List all knowledge entries the caller can read (owned and shared) in a namespace. Use this to browse the memory bank or discover what has been stored.',
        inputSchema: {
          type: 'object',
          properties: {
            namespace: {
              type: 'string',
              description: 'Namespace to list (defaults to session namespace)',
            },
            entry_type: { type: 'string', description: 'Filter by entry type' },
            limit: { type: 'number', description: 'Max results (default 50)' },
            skip: { type: 'number', description: 'Pagination offset (default 0)' },
          },
          required: [],
        },
      },
      handler: (args, ctx) => handleList(args, ctx, neo4jClient),
    },
    {
      descriptor: {
        name: 'knowledge_update_entry',
        description:
          'Update the title, content, or metadata of a knowledge entry. Requires editor or owner role. Retrieve the entry first to see its current state.',
        inputSchema: {
          type: 'object',
          properties: {
            entry_id: { type: 'string', description: 'UUID of the entry to update' },
            title: { type: 'string' },
            content: { type: 'string' },
            topic: { type: 'string' },
            tags: { type: 'array', items: { type: 'string' } },
            summary: { type: 'string' },
            source: { type: 'string' },
            last_verified_at: { type: 'string' },
          },
          required: ['entry_id'],
        },
      },
      handler: (args, ctx) => handleUpdate(args, ctx, neo4jClient),
    },
    {
      descriptor: {
        name: 'knowledge_delete_entry',
        description:
          'Permanently delete a knowledge entry and all its access grants. Owner only. This action is irreversible.',
        inputSchema: {
          type: 'object',
          properties: { entry_id: { type: 'string' } },
          required: ['entry_id'],
        },
      },
      handler: (args, ctx) => handleDelete(args, ctx, neo4jClient),
    },
    {
      descriptor: {
        name: 'knowledge_search_entries',
        description:
          'Search the knowledge memory bank by keyword. Always call this before creating new entries to avoid duplicates. Only returns entries the caller can read.',
        inputSchema: {
          type: 'object',
          properties: {
            query: { type: 'string', description: 'Search keywords or phrase' },
            namespace: {
              type: 'string',
              description: 'Namespace to search in (defaults to session namespace)',
            },
            entry_type: { type: 'string', description: 'Filter by entry type' },
            limit: { type: 'number', description: 'Max results (default 20)' },
            skip: { type: 'number', description: 'Pagination offset (default 0)' },
            match_mode: {
              type: 'string',
              enum: ['exact', 'fulltext', 'fuzzy'],
              description:
                'Search mode: "fuzzy" (default, tolerates typos), "fulltext" (exact keyword match), or "exact" (phrase match)',
            },
          },
          required: ['query'],
        },
      },
      handler: (args, ctx) => handleSearch(args, ctx, neo4jClient),
    },
    {
      descriptor: {
        name: 'knowledge_list_namespaces',
        description:
          'List all namespaces the caller owns or has shared access to, with per-namespace entry counts.',
        inputSchema: {
          type: 'object',
          properties: {},
          required: [],
        },
      },
      handler: (args, ctx) => handleListNamespaces(args, ctx, neo4jClient),
    },
  ];
}

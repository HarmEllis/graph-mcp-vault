import { z } from 'zod';
import type { Neo4jClient } from '../neo4j-client.js';
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
 * Resolves the caller's effective role on a resource, throwing the appropriate
 * ToolError if the resource is absent or the permission is insufficient.
 */
async function requirePermission(
  neo4jClient: Neo4jClient,
  userId: string,
  resourceId: string,
  permission: Permission,
): Promise<'owner' | 'editor' | 'viewer'> {
  const resource = await neo4jClient.getResource(resourceId);
  if (!resource) throw new ToolError(ErrorCode.RESOURCE_NOT_FOUND, 'Resource not found');

  const role = await neo4jClient.getEffectiveRole(userId, resourceId);
  if (role === null || !hasPermission(role, permission)) {
    throw new ToolError(ErrorCode.PERMISSION_DENIED, 'Permission denied');
  }
  return role;
}

// ── create_resource ───────────────────────────────────────────────────────────

const createSchema = z.object({
  type: z.string().min(1),
  title: z.string().min(1),
  content: z.string(),
  namespace: z.string().optional(),
});

async function handleCreate(
  args: Record<string, unknown>,
  ctx: ToolContext,
  neo4jClient: Neo4jClient,
): Promise<unknown> {
  const parsed = createSchema.safeParse(args);
  if (!parsed.success) {
    throw new ToolError(ErrorCode.INVALID_PARAMS, `Invalid params: ${parsed.error.message}`);
  }
  const { type, title, content, namespace } = parsed.data;
  return neo4jClient.createResource({
    userId: ctx.userId,
    namespace: namespace ?? ctx.namespace,
    type,
    title,
    content,
  });
}

// ── get_resource ──────────────────────────────────────────────────────────────

const getSchema = z.object({ resource_id: z.string().min(1) });

async function handleGet(
  args: Record<string, unknown>,
  ctx: ToolContext,
  neo4jClient: Neo4jClient,
): Promise<unknown> {
  const parsed = getSchema.safeParse(args);
  if (!parsed.success) {
    throw new ToolError(ErrorCode.INVALID_PARAMS, `Invalid params: ${parsed.error.message}`);
  }
  const { resource_id } = parsed.data;

  const resource = await neo4jClient.getResource(resource_id);
  if (!resource) throw new ToolError(ErrorCode.RESOURCE_NOT_FOUND, 'Resource not found');

  const role = await neo4jClient.getEffectiveRole(ctx.userId, resource_id);
  if (role === null) throw new ToolError(ErrorCode.PERMISSION_DENIED, 'Permission denied');

  return { ...resource, role };
}

// ── list_resources ────────────────────────────────────────────────────────────

const listSchema = z.object({
  namespace: z.string().optional(),
  type: z.string().optional(),
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
    ...(parsed.data.type !== undefined && { type: parsed.data.type }),
    ...(parsed.data.limit !== undefined && { limit: parsed.data.limit }),
    ...(parsed.data.skip !== undefined && { skip: parsed.data.skip }),
  });
  return { resources };
}

// ── update_resource ───────────────────────────────────────────────────────────

const updateSchema = z.object({
  resource_id: z.string().min(1),
  title: z.string().min(1).optional(),
  content: z.string().optional(),
});

async function handleUpdate(
  args: Record<string, unknown>,
  ctx: ToolContext,
  neo4jClient: Neo4jClient,
): Promise<unknown> {
  const parsed = updateSchema.safeParse(args);
  if (!parsed.success) {
    throw new ToolError(ErrorCode.INVALID_PARAMS, `Invalid params: ${parsed.error.message}`);
  }
  const { resource_id, title, content } = parsed.data;

  await requirePermission(neo4jClient, ctx.userId, resource_id, 'write');
  await neo4jClient.updateResource(resource_id, {
    ...(title !== undefined && { title }),
    ...(content !== undefined && { content }),
  });
  return {};
}

// ── delete_resource ───────────────────────────────────────────────────────────

const deleteSchema = z.object({ resource_id: z.string().min(1) });

async function handleDelete(
  args: Record<string, unknown>,
  ctx: ToolContext,
  neo4jClient: Neo4jClient,
): Promise<unknown> {
  const parsed = deleteSchema.safeParse(args);
  if (!parsed.success) {
    throw new ToolError(ErrorCode.INVALID_PARAMS, `Invalid params: ${parsed.error.message}`);
  }
  const { resource_id } = parsed.data;

  await requirePermission(neo4jClient, ctx.userId, resource_id, 'delete');
  await neo4jClient.deleteResource(resource_id);
  return {};
}

// ── search_resources ──────────────────────────────────────────────────────────

const searchSchema = z.object({
  query: z.string().min(1),
  namespace: z.string().optional(),
  type: z.string().optional(),
  limit: z.number().int().positive().optional(),
  skip: z.number().int().min(0).optional(),
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
    ...(parsed.data.type !== undefined && { type: parsed.data.type }),
    ...(parsed.data.limit !== undefined && { limit: parsed.data.limit }),
    ...(parsed.data.skip !== undefined && { skip: parsed.data.skip }),
  });
  return { resources };
}

// ── Factory ───────────────────────────────────────────────────────────────────

/**
 * Returns the six resource tool registrations, each closing over `neo4jClient`.
 */
export function createResourceTools(neo4jClient: Neo4jClient): RegisteredTool[] {
  return [
    {
      descriptor: {
        name: 'create_resource',
        description: 'Create a new resource owned by the caller.',
        inputSchema: {
          type: 'object',
          properties: {
            type: { type: 'string', description: 'Resource type (e.g. note, task)' },
            title: { type: 'string', description: 'Resource title' },
            content: { type: 'string', description: 'Resource content' },
            namespace: { type: 'string', description: 'Namespace override (optional)' },
          },
          required: ['type', 'title', 'content'],
        },
      },
      handler: (args, ctx) => handleCreate(args, ctx, neo4jClient),
    },
    {
      descriptor: {
        name: 'get_resource',
        description: 'Retrieve a resource by id. Requires read access.',
        inputSchema: {
          type: 'object',
          properties: { resource_id: { type: 'string' } },
          required: ['resource_id'],
        },
      },
      handler: (args, ctx) => handleGet(args, ctx, neo4jClient),
    },
    {
      descriptor: {
        name: 'list_resources',
        description: 'List all resources the caller can read.',
        inputSchema: {
          type: 'object',
          properties: {
            namespace: { type: 'string' },
            type: { type: 'string' },
            limit: { type: 'number' },
            skip: { type: 'number' },
          },
          required: [],
        },
      },
      handler: (args, ctx) => handleList(args, ctx, neo4jClient),
    },
    {
      descriptor: {
        name: 'update_resource',
        description: 'Update a resource title and/or content. Requires write access.',
        inputSchema: {
          type: 'object',
          properties: {
            resource_id: { type: 'string' },
            title: { type: 'string' },
            content: { type: 'string' },
          },
          required: ['resource_id'],
        },
      },
      handler: (args, ctx) => handleUpdate(args, ctx, neo4jClient),
    },
    {
      descriptor: {
        name: 'delete_resource',
        description: 'Delete a resource and all its relationships. Owner only.',
        inputSchema: {
          type: 'object',
          properties: { resource_id: { type: 'string' } },
          required: ['resource_id'],
        },
      },
      handler: (args, ctx) => handleDelete(args, ctx, neo4jClient),
    },
    {
      descriptor: {
        name: 'search_resources',
        description: 'Full-text search over resource titles and content. Only returns resources the caller can read.',
        inputSchema: {
          type: 'object',
          properties: {
            query: { type: 'string', description: 'Search keywords' },
            namespace: { type: 'string', description: 'Namespace to search in (defaults to session namespace)' },
            type: { type: 'string', description: 'Filter by resource type' },
            limit: { type: 'number', description: 'Max results (default 20)' },
            skip: { type: 'number', description: 'Pagination offset (default 0)' },
          },
          required: ['query'],
        },
      },
      handler: (args, ctx) => handleSearch(args, ctx, neo4jClient),
    },
  ];
}

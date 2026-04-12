import { z } from 'zod';
import type { Neo4jClient } from '../neo4j-client.js';
import { ErrorCode } from '../errors.js';
import { ToolError, type RegisteredTool, type ToolContext } from './registry.js';

// ── Permission helpers ────────────────────────────────────────────────────────

/**
 * Asserts the caller is the owner of the resource.
 * Throws RESOURCE_NOT_FOUND if the resource does not exist, or
 * PERMISSION_DENIED if the caller is not the owner.
 */
async function requireOwner(
  neo4jClient: Neo4jClient,
  userId: string,
  resourceId: string,
): Promise<void> {
  const resource = await neo4jClient.getResource(resourceId);
  if (!resource) throw new ToolError(ErrorCode.RESOURCE_NOT_FOUND, 'Resource not found');

  const role = await neo4jClient.getEffectiveRole(userId, resourceId);
  if (role !== 'owner') {
    throw new ToolError(ErrorCode.PERMISSION_DENIED, 'Permission denied');
  }
}

/**
 * Asserts the caller has at least read access to the resource.
 * Throws RESOURCE_NOT_FOUND or PERMISSION_DENIED otherwise.
 */
async function requireRead(
  neo4jClient: Neo4jClient,
  userId: string,
  resourceId: string,
): Promise<void> {
  const resource = await neo4jClient.getResource(resourceId);
  if (!resource) throw new ToolError(ErrorCode.RESOURCE_NOT_FOUND, 'Resource not found');

  const role = await neo4jClient.getEffectiveRole(userId, resourceId);
  if (role === null) throw new ToolError(ErrorCode.PERMISSION_DENIED, 'Permission denied');
}

// ── share_resource ────────────────────────────────────────────────────────────

const shareSchema = z.object({
  resource_id: z.string().min(1),
  target_user_id: z.string().min(1),
  role: z.enum(['viewer', 'editor']),
});

async function handleShare(
  args: Record<string, unknown>,
  ctx: ToolContext,
  neo4jClient: Neo4jClient,
): Promise<unknown> {
  const parsed = shareSchema.safeParse(args);
  if (!parsed.success) {
    throw new ToolError(ErrorCode.INVALID_PARAMS, `Invalid params: ${parsed.error.message}`);
  }
  const { resource_id, target_user_id, role } = parsed.data;

  await requireOwner(neo4jClient, ctx.userId, resource_id);
  await neo4jClient.shareResource(resource_id, target_user_id, role);
  return {};
}

// ── revoke_access ─────────────────────────────────────────────────────────────

const revokeSchema = z.object({
  resource_id: z.string().min(1),
  target_user_id: z.string().min(1),
});

async function handleRevoke(
  args: Record<string, unknown>,
  ctx: ToolContext,
  neo4jClient: Neo4jClient,
): Promise<unknown> {
  const parsed = revokeSchema.safeParse(args);
  if (!parsed.success) {
    throw new ToolError(ErrorCode.INVALID_PARAMS, `Invalid params: ${parsed.error.message}`);
  }
  const { resource_id, target_user_id } = parsed.data;

  // Resource must exist before any other check
  const resource = await neo4jClient.getResource(resource_id);
  if (!resource) throw new ToolError(ErrorCode.RESOURCE_NOT_FOUND, 'Resource not found');

  // Prevent revoking own access
  if (target_user_id === ctx.userId) {
    throw new ToolError(ErrorCode.PERMISSION_DENIED, 'Cannot revoke owner access');
  }

  // Only owners may revoke access
  const role = await neo4jClient.getEffectiveRole(ctx.userId, resource_id);
  if (role !== 'owner') {
    throw new ToolError(ErrorCode.PERMISSION_DENIED, 'Permission denied');
  }

  await neo4jClient.revokeAccess(resource_id, target_user_id);
  return {};
}

// ── list_sharing ──────────────────────────────────────────────────────────────

const listSharingSchema = z.object({ resource_id: z.string().min(1) });

async function handleListSharing(
  args: Record<string, unknown>,
  ctx: ToolContext,
  neo4jClient: Neo4jClient,
): Promise<unknown> {
  const parsed = listSharingSchema.safeParse(args);
  if (!parsed.success) {
    throw new ToolError(ErrorCode.INVALID_PARAMS, `Invalid params: ${parsed.error.message}`);
  }
  const { resource_id } = parsed.data;

  await requireRead(neo4jClient, ctx.userId, resource_id);
  const sharing = await neo4jClient.listSharing(resource_id);
  return { sharing };
}

// ── Factory ───────────────────────────────────────────────────────────────────

/**
 * Returns the three sharing tool registrations, each closing over `neo4jClient`.
 */
export function createSharingTools(neo4jClient: Neo4jClient): RegisteredTool[] {
  return [
    {
      descriptor: {
        name: 'share_resource',
        description: 'Grant another user access to a resource. Owner only.',
        inputSchema: {
          type: 'object',
          properties: {
            resource_id: { type: 'string' },
            target_user_id: { type: 'string' },
            role: { type: 'string', enum: ['viewer', 'editor'] },
          },
          required: ['resource_id', 'target_user_id', 'role'],
        },
      },
      handler: (args, ctx) => handleShare(args, ctx, neo4jClient),
    },
    {
      descriptor: {
        name: 'revoke_access',
        description: 'Remove a user\'s access to a resource. Owner only.',
        inputSchema: {
          type: 'object',
          properties: {
            resource_id: { type: 'string' },
            target_user_id: { type: 'string' },
          },
          required: ['resource_id', 'target_user_id'],
        },
      },
      handler: (args, ctx) => handleRevoke(args, ctx, neo4jClient),
    },
    {
      descriptor: {
        name: 'list_sharing',
        description: 'List all users with access to a resource. Requires read access.',
        inputSchema: {
          type: 'object',
          properties: { resource_id: { type: 'string' } },
          required: ['resource_id'],
        },
      },
      handler: (args, ctx) => handleListSharing(args, ctx, neo4jClient),
    },
  ];
}

import { z } from "zod";
import { ErrorCode } from "../errors.js";
import type { Neo4jClient } from "../neo4j-client.js";
import {
  DEFAULT_LIST_ACCESS_LIMIT,
  MAX_LIST_ACCESS_LIMIT,
} from "./graph-constants.js";
import {
  type RegisteredTool,
  type ToolContext,
  ToolError,
} from "./registry.js";

// ── Permission helpers ────────────────────────────────────────────────────────

/**
 * Asserts the caller is the owner of the entry.
 * Throws RESOURCE_NOT_FOUND if the entry does not exist, or
 * PERMISSION_DENIED if the caller is not the owner.
 */
async function requireOwner(
  neo4jClient: Neo4jClient,
  userId: string,
  entryId: string,
): Promise<void> {
  const resource = await neo4jClient.getResource(entryId);
  if (!resource)
    throw new ToolError(ErrorCode.RESOURCE_NOT_FOUND, "Resource not found");

  const role = await neo4jClient.getEffectiveRole(userId, entryId);
  if (role !== "owner") {
    throw new ToolError(ErrorCode.PERMISSION_DENIED, "Permission denied");
  }
}

/**
 * Asserts the caller has at least read access to the entry.
 * Throws RESOURCE_NOT_FOUND or PERMISSION_DENIED otherwise.
 */
async function requireRead(
  neo4jClient: Neo4jClient,
  userId: string,
  entryId: string,
): Promise<void> {
  const resource = await neo4jClient.getResource(entryId);
  if (!resource)
    throw new ToolError(ErrorCode.RESOURCE_NOT_FOUND, "Resource not found");

  const role = await neo4jClient.getEffectiveRole(userId, entryId);
  if (role === null)
    throw new ToolError(ErrorCode.PERMISSION_DENIED, "Permission denied");
}

// ── knowledge_share_entry ─────────────────────────────────────────────────────

const shareSchema = z.object({
  entry_id: z.string().min(1),
  target_user_id: z.string().min(1),
  role: z.enum(["viewer", "editor"]),
});

async function handleShare(
  args: Record<string, unknown>,
  ctx: ToolContext,
  neo4jClient: Neo4jClient,
): Promise<unknown> {
  const parsed = shareSchema.safeParse(args);
  if (!parsed.success) {
    throw new ToolError(
      ErrorCode.INVALID_PARAMS,
      `Invalid params: ${parsed.error.message}`,
    );
  }
  const { entry_id, target_user_id, role } = parsed.data;

  await requireOwner(neo4jClient, ctx.userId, entry_id);
  await neo4jClient.shareResource(entry_id, target_user_id, role);
  return {};
}

// ── knowledge_revoke_access ───────────────────────────────────────────────────

const revokeSchema = z.object({
  entry_id: z.string().min(1),
  target_user_id: z.string().min(1),
});

async function handleRevoke(
  args: Record<string, unknown>,
  ctx: ToolContext,
  neo4jClient: Neo4jClient,
): Promise<unknown> {
  const parsed = revokeSchema.safeParse(args);
  if (!parsed.success) {
    throw new ToolError(
      ErrorCode.INVALID_PARAMS,
      `Invalid params: ${parsed.error.message}`,
    );
  }
  const { entry_id, target_user_id } = parsed.data;

  // Entry must exist before any other check
  const resource = await neo4jClient.getResource(entry_id);
  if (!resource)
    throw new ToolError(ErrorCode.RESOURCE_NOT_FOUND, "Resource not found");

  // Prevent revoking own access
  if (target_user_id === ctx.userId) {
    throw new ToolError(
      ErrorCode.PERMISSION_DENIED,
      "Cannot revoke owner access",
    );
  }

  // Only owners may revoke access
  const role = await neo4jClient.getEffectiveRole(ctx.userId, entry_id);
  if (role !== "owner") {
    throw new ToolError(ErrorCode.PERMISSION_DENIED, "Permission denied");
  }

  await neo4jClient.revokeAccess(entry_id, target_user_id);
  return {};
}

// ── knowledge_list_access ─────────────────────────────────────────────────────

const listAccessSchema = z.object({
  entry_id: z.string().min(1),
  limit: z.number().int().positive().max(MAX_LIST_ACCESS_LIMIT).optional(),
});

async function handleListAccess(
  args: Record<string, unknown>,
  ctx: ToolContext,
  neo4jClient: Neo4jClient,
): Promise<unknown> {
  const parsed = listAccessSchema.safeParse(args);
  if (!parsed.success) {
    throw new ToolError(
      ErrorCode.INVALID_PARAMS,
      `Invalid params: ${parsed.error.message}`,
    );
  }
  const { entry_id, limit: rawLimit } = parsed.data;
  const limit = rawLimit ?? DEFAULT_LIST_ACCESS_LIMIT;

  await requireRead(neo4jClient, ctx.userId, entry_id);
  const sharing = await neo4jClient.listSharing(entry_id, limit);
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
        name: "knowledge_share_entry",
        description:
          "Grant another user access to a knowledge entry. Owner only.",
        inputSchema: {
          type: "object",
          properties: {
            entry_id: {
              type: "string",
              description: "UUID of the entry to share",
            },
            target_user_id: { type: "string" },
            role: { type: "string", enum: ["viewer", "editor"] },
          },
          required: ["entry_id", "target_user_id", "role"],
        },
      },
      handler: (args, ctx) => handleShare(args, ctx, neo4jClient),
    },
    {
      descriptor: {
        name: "knowledge_revoke_access",
        description: "Remove a user's access to a knowledge entry. Owner only.",
        inputSchema: {
          type: "object",
          properties: {
            entry_id: { type: "string", description: "UUID of the entry" },
            target_user_id: { type: "string" },
          },
          required: ["entry_id", "target_user_id"],
        },
      },
      handler: (args, ctx) => handleRevoke(args, ctx, neo4jClient),
    },
    {
      descriptor: {
        name: "knowledge_list_access",
        description:
          "List all users with access to a knowledge entry. Requires at least read access. Results are ordered by grant date (most recent first).",
        inputSchema: {
          type: "object",
          properties: {
            entry_id: { type: "string" },
            limit: {
              type: "number",
              description: `Max access grants to return (default ${DEFAULT_LIST_ACCESS_LIMIT}, max ${MAX_LIST_ACCESS_LIMIT})`,
            },
          },
          required: ["entry_id"],
        },
      },
      handler: (args, ctx) => handleListAccess(args, ctx, neo4jClient),
    },
  ];
}

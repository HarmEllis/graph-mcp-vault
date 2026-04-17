import { z } from "zod";
import { ErrorCode } from "../errors.js";
import type { AutoSharePermission, Neo4jClient } from "../neo4j-client.js";
import {
  type RegisteredTool,
  type ToolContext,
  ToolError,
} from "./registry.js";

const getNamespaceConfigSchema = z.object({
  namespace: z.string().min(1).optional(),
});

async function handleGetNamespaceConfig(
  args: Record<string, unknown>,
  ctx: ToolContext,
  neo4jClient: Neo4jClient,
): Promise<unknown> {
  const parsed = getNamespaceConfigSchema.safeParse(args);
  if (!parsed.success) {
    throw new ToolError(
      ErrorCode.INVALID_PARAMS,
      `Invalid params: ${parsed.error.message}`,
    );
  }
  const namespace = parsed.data.namespace ?? ctx.namespace;
  return await neo4jClient.getNamespaceConfig(ctx.userId, namespace);
}

const updateNamespaceConfigSchema = z
  .object({
    namespace: z.string().min(1).optional(),
    auto_share: z.boolean().optional(),
    auto_share_permission: z.enum(["read", "write"]).optional(),
    auto_share_user_ids: z.array(z.string().min(1)).max(500).optional(),
  })
  .refine(
    (value) =>
      value.auto_share !== undefined ||
      value.auto_share_permission !== undefined ||
      value.auto_share_user_ids !== undefined,
    {
      message:
        "At least one of auto_share, auto_share_permission, auto_share_user_ids is required",
    },
  );

async function handleUpdateNamespaceConfig(
  args: Record<string, unknown>,
  ctx: ToolContext,
  neo4jClient: Neo4jClient,
): Promise<unknown> {
  const parsed = updateNamespaceConfigSchema.safeParse(args);
  if (!parsed.success) {
    throw new ToolError(
      ErrorCode.INVALID_PARAMS,
      `Invalid params: ${parsed.error.message}`,
    );
  }
  const namespace = parsed.data.namespace ?? ctx.namespace;

  const uniqueUserIds =
    parsed.data.auto_share_user_ids === undefined
      ? undefined
      : [...new Set(parsed.data.auto_share_user_ids)].filter(
          (id) => id !== ctx.userId,
        );

  if (uniqueUserIds !== undefined) {
    for (const userId of uniqueUserIds) {
      const user = await neo4jClient.getUser(userId);
      if (!user) {
        throw new ToolError(
          ErrorCode.RESOURCE_NOT_FOUND,
          "Target user not found",
        );
      }
    }
  }

  return await neo4jClient.updateNamespaceConfig({
    ownerId: ctx.userId,
    namespace,
    ...(parsed.data.auto_share !== undefined
      ? { auto_share: parsed.data.auto_share }
      : {}),
    ...(parsed.data.auto_share_permission !== undefined
      ? {
          auto_share_permission: parsed.data
            .auto_share_permission as AutoSharePermission,
        }
      : {}),
    ...(uniqueUserIds !== undefined
      ? { auto_share_user_ids: uniqueUserIds }
      : {}),
  });
}

export function createNamespaceConfigTools(
  neo4jClient: Neo4jClient,
): RegisteredTool[] {
  return [
    {
      descriptor: {
        name: "knowledge_get_namespace_config",
        description:
          "Get namespace auto-share settings for the current user (or explicit namespace).",
        inputSchema: {
          type: "object",
          properties: {
            namespace: { type: "string" },
          },
        },
      },
      handler: (args, ctx) => handleGetNamespaceConfig(args, ctx, neo4jClient),
    },
    {
      descriptor: {
        name: "knowledge_update_namespace_config",
        description:
          "Update namespace auto-share settings for the current user.",
        inputSchema: {
          type: "object",
          properties: {
            namespace: { type: "string" },
            auto_share: { type: "boolean" },
            auto_share_permission: { type: "string", enum: ["read", "write"] },
            auto_share_user_ids: { type: "array", items: { type: "string" } },
          },
        },
      },
      handler: (args, ctx) =>
        handleUpdateNamespaceConfig(args, ctx, neo4jClient),
    },
  ];
}

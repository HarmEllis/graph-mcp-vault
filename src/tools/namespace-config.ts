import { z } from "zod";
import { ErrorCode } from "../errors.js";
import { zNamespace } from "../namespace.js";
import type { AutoSharePermission, Neo4jClient } from "../neo4j-client.js";
import {
  type RegisteredTool,
  type ToolContext,
  ToolError,
} from "./registry.js";

const getNamespaceConfigSchema = z.object({
  namespace: zNamespace.optional(),
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
    namespace: zNamespace.optional(),
    auto_share: z.boolean().optional(),
    auto_share_permission: z.enum(["read", "write"]).optional(),
    auto_share_user_ids: z.array(z.string().min(1)).max(500).optional(),
    structure_template: z.string().max(10000).optional(),
  })
  .refine(
    (value) =>
      value.auto_share !== undefined ||
      value.auto_share_permission !== undefined ||
      value.auto_share_user_ids !== undefined ||
      value.structure_template !== undefined,
    {
      message:
        "At least one of auto_share, auto_share_permission, auto_share_user_ids, structure_template is required",
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
    const existingUserIds = await neo4jClient.getExistingUserIds(uniqueUserIds);
    if (existingUserIds.length !== uniqueUserIds.length) {
      throw new ToolError(
        ErrorCode.RESOURCE_NOT_FOUND,
        "Target user not found",
      );
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
    ...(parsed.data.structure_template !== undefined
      ? { structure_template: parsed.data.structure_template }
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
          "Get namespace settings for the current user (or explicit namespace), including auto-share config and structure_template.",
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
          "Update namespace settings for the current user: auto-share config and/or a Markdown structure_template that describes the intended organisation of this namespace.",
        inputSchema: {
          type: "object",
          properties: {
            namespace: { type: "string" },
            auto_share: { type: "boolean" },
            auto_share_permission: { type: "string", enum: ["read", "write"] },
            auto_share_user_ids: { type: "array", items: { type: "string" } },
            structure_template: {
              type: "string",
              description:
                "Markdown text describing the intended structure of this namespace (entry types, tags, relation types, conventions). Shown in knowledge_list_namespaces so every session sees it automatically.",
            },
          },
        },
      },
      handler: (args, ctx) =>
        handleUpdateNamespaceConfig(args, ctx, neo4jClient),
    },
  ];
}

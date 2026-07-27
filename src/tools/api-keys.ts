import { randomUUID } from "node:crypto";
import { z } from "zod";
import { generateApiKey } from "../auth.js";
import type { Config } from "../config.js";
import { ErrorCode } from "../errors.js";
import { zNamespace } from "../namespace.js";
import type { Neo4jClient } from "../neo4j-client.js";
import {
  type RegisteredTool,
  type ToolContext,
  ToolError,
} from "./registry.js";

const createApiKeySchema = z.object({
  name: z.string().min(1).max(100),
  namespaces: z.array(zNamespace).optional(),
  expires_in_days: z.number().int().min(1).max(365).optional(),
});

async function handleCreateApiKey(
  args: Record<string, unknown>,
  ctx: ToolContext,
  neo4jClient: Neo4jClient,
  config: Config,
): Promise<unknown> {
  if (!config.apiKeysEnabled) {
    throw new ToolError(
      ErrorCode.PERMISSION_DENIED,
      "API key management is not enabled",
    );
  }

  const parsed = createApiKeySchema.safeParse(args);
  if (!parsed.success) {
    throw new ToolError(
      ErrorCode.INVALID_PARAMS,
      `Invalid params: ${parsed.error.message}`,
    );
  }

  if (config.apiKeysHashSecret === undefined) {
    throw new ToolError(
      ErrorCode.PERMISSION_DENIED,
      "API key hash secret is not configured",
    );
  }

  const { name, namespaces: rawNamespaces, expires_in_days } = parsed.data;

  // Deduplicate while preserving order
  const namespaces =
    rawNamespaces !== undefined ? [...new Set(rawNamespaces)] : undefined;

  const { raw, hash, prefix } = await generateApiKey(config.apiKeysHashSecret);

  const expiresAt =
    expires_in_days !== undefined
      ? new Date(
          Date.now() + expires_in_days * 24 * 60 * 60 * 1000,
        ).toISOString()
      : null;

  // Build the namespace allow-list for the new key
  let namespaceList =
    namespaces !== undefined && namespaces.length > 0 ? namespaces : null;

  // Prevent privilege escalation: a namespace-restricted caller cannot mint a
  // key with broader scope than its own effective scope. Using the effective
  // scope (not the raw allow-list) means a hard-locked session cannot mint a
  // key for a namespace it may not itself reach.
  const callerScope = ctx.namespaceScope;
  if (callerScope !== null) {
    if (namespaceList === null) {
      // Caller omitted namespaces (unrestricted) — cap to caller's own scope
      namespaceList = [...callerScope];
    } else {
      const outsideScope = namespaceList.filter(
        (ns) => !callerScope.includes(ns),
      );
      if (outsideScope.length > 0) {
        throw new ToolError(
          ErrorCode.INVALID_PARAMS,
          `Namespace(s) not in caller's allowed scope: ${outsideScope.join(", ")}`,
        );
      }
    }
  }

  // Atomic count-check + create prevents TOCTOU races at the per-user limit.
  const record = await neo4jClient.createApiKeyWithLimit({
    id: randomUUID(),
    userId: ctx.userId,
    name,
    keyHash: hash,
    keyPrefix: prefix,
    namespaces: namespaceList,
    expiresAt,
    maxPerUser: config.apiKeysMaxPerUser,
  });

  if (record === null) {
    throw new ToolError(
      ErrorCode.INVALID_PARAMS,
      `Maximum number of active API keys (${config.apiKeysMaxPerUser}) reached`,
    );
  }

  return {
    id: record.id,
    name: record.name,
    key: raw,
    key_prefix: record.key_prefix,
    namespaces: record.namespaces,
    expires_at: record.expires_at,
  };
}

const listApiKeysSchema = z.object({});

async function handleListApiKeys(
  args: Record<string, unknown>,
  ctx: ToolContext,
  neo4jClient: Neo4jClient,
  config: Config,
): Promise<unknown> {
  if (!config.apiKeysEnabled) {
    throw new ToolError(
      ErrorCode.PERMISSION_DENIED,
      "API key management is not enabled",
    );
  }

  const parsed = listApiKeysSchema.safeParse(args);
  if (!parsed.success) {
    throw new ToolError(
      ErrorCode.INVALID_PARAMS,
      `Invalid params: ${parsed.error.message}`,
    );
  }

  const keys = await neo4jClient.listApiKeys(ctx.userId);

  // Namespace-scoped callers may only see keys whose namespace allow-list is
  // entirely within their own effective scope. Unrestricted keys (null) and
  // keys for other namespaces are invisible to them.
  const callerScope = ctx.namespaceScope;
  if (callerScope !== null) {
    const filtered = keys.filter((k) =>
      k.namespaces?.every((ns) => callerScope.includes(ns)),
    );
    return { api_keys: filtered };
  }

  return { api_keys: keys };
}

const revokeApiKeySchema = z.object({
  key_id: z.string().min(1),
});

async function handleRevokeApiKey(
  args: Record<string, unknown>,
  ctx: ToolContext,
  neo4jClient: Neo4jClient,
  config: Config,
): Promise<unknown> {
  if (!config.apiKeysEnabled) {
    throw new ToolError(
      ErrorCode.PERMISSION_DENIED,
      "API key management is not enabled",
    );
  }

  const parsed = revokeApiKeySchema.safeParse(args);
  if (!parsed.success) {
    throw new ToolError(
      ErrorCode.INVALID_PARAMS,
      `Invalid params: ${parsed.error.message}`,
    );
  }

  const { key_id } = parsed.data;

  // Namespace-scoped callers may only revoke keys whose namespace allow-list is
  // entirely within their own effective scope.
  const callerScope = ctx.namespaceScope;
  if (callerScope !== null) {
    const allKeys = await neo4jClient.listApiKeys(ctx.userId);
    const targetKey = allKeys.find((k) => k.id === key_id);
    if (
      !targetKey ||
      targetKey.namespaces === null ||
      !targetKey.namespaces.every((ns) => callerScope.includes(ns))
    ) {
      throw new ToolError(
        ErrorCode.PERMISSION_DENIED,
        "API key is not within caller's allowed scope",
      );
    }
  }

  const revoked = await neo4jClient.revokeApiKey(ctx.userId, key_id);
  if (!revoked) {
    throw new ToolError(ErrorCode.RESOURCE_NOT_FOUND, "API key not found");
  }

  return { revoked: true };
}

export function createApiKeyTools(
  neo4jClient: Neo4jClient,
  config: Config,
): RegisteredTool[] {
  return [
    {
      descriptor: {
        name: "knowledge_create_api_key",
        description:
          "Create a new API key for the authenticated user. The raw key is returned exactly once and cannot be recovered.",
        inputSchema: {
          type: "object",
          properties: {
            name: {
              type: "string",
              description: "Human-readable label for the key (1-100 chars).",
            },
            namespaces: {
              type: "array",
              items: { type: "string" },
              description:
                "Optional namespace allow-list. Omit for unrestricted access.",
            },
            expires_in_days: {
              type: "number",
              description:
                "Optional expiry window in days (1-365). Omit for no expiry.",
            },
          },
          required: ["name"],
        },
      },
      handler: (args, ctx) =>
        handleCreateApiKey(args, ctx, neo4jClient, config),
    },
    {
      descriptor: {
        name: "knowledge_list_api_keys",
        description:
          "List all API keys owned by the authenticated user. Never returns the raw key or key hash.",
        inputSchema: {
          type: "object",
          properties: {},
        },
      },
      handler: (args, ctx) => handleListApiKeys(args, ctx, neo4jClient, config),
    },
    {
      descriptor: {
        name: "knowledge_revoke_api_key",
        description:
          "Revoke an API key owned by the authenticated user. Idempotent: revoking an already-revoked key returns { revoked: true }.",
        inputSchema: {
          type: "object",
          properties: {
            key_id: {
              type: "string",
              description: "ID of the API key to revoke.",
            },
          },
          required: ["key_id"],
        },
      },
      handler: (args, ctx) =>
        handleRevokeApiKey(args, ctx, neo4jClient, config),
    },
  ];
}

import { z } from "zod";
import { ErrorCode } from "../errors.js";
import type { Neo4jClient } from "../neo4j-client.js";
import {
  type RegisteredTool,
  type ToolContext,
  ToolError,
} from "./registry.js";

const MAX_SEARCH_USERS_LIMIT = 50;
const DEFAULT_SEARCH_USERS_LIMIT = 10;

const getCurrentUserSchema = z.object({});

async function handleGetCurrentUser(
  args: Record<string, unknown>,
  ctx: ToolContext,
  neo4jClient: Neo4jClient,
): Promise<unknown> {
  const parsed = getCurrentUserSchema.safeParse(args);
  if (!parsed.success) {
    throw new ToolError(
      ErrorCode.INVALID_PARAMS,
      `Invalid params: ${parsed.error.message}`,
    );
  }

  const user = await neo4jClient.getUser(ctx.userId);
  if (!user) return { user_id: ctx.userId };
  return user;
}

const searchUsersSchema = z.object({
  name: z.string().min(1).optional(),
  email: z.string().min(1).optional(),
  limit: z.number().int().positive().max(MAX_SEARCH_USERS_LIMIT).optional(),
});

async function handleSearchUsers(
  args: Record<string, unknown>,
  ctx: ToolContext,
  neo4jClient: Neo4jClient,
): Promise<unknown> {
  const parsed = searchUsersSchema.safeParse(args);
  if (!parsed.success) {
    throw new ToolError(
      ErrorCode.INVALID_PARAMS,
      `Invalid params: ${parsed.error.message}`,
    );
  }
  const { name, email, limit } = parsed.data;
  const users = await neo4jClient.searchUsers({
    requesterUserId: ctx.userId,
    ...(name !== undefined ? { name } : {}),
    ...(email !== undefined ? { email } : {}),
    limit: limit ?? DEFAULT_SEARCH_USERS_LIMIT,
  });
  return { users };
}

export function createUserTools(neo4jClient: Neo4jClient): RegisteredTool[] {
  return [
    {
      descriptor: {
        name: "knowledge_get_current_user",
        description:
          "Return the authenticated user's profile information (user ID, name, email).",
        inputSchema: {
          type: "object",
          properties: {},
        },
      },
      handler: (args, ctx) => handleGetCurrentUser(args, ctx, neo4jClient),
    },
    {
      descriptor: {
        name: "knowledge_search_users",
        description:
          "Find users for sharing. Without name/email, returns only users connected by existing sharing relationships. With name/email, performs exact case-insensitive lookup.",
        inputSchema: {
          type: "object",
          properties: {
            name: {
              type: "string",
              description: "Optional exact name match (case-insensitive).",
            },
            email: {
              type: "string",
              description: "Optional exact email match (case-insensitive).",
            },
            limit: {
              type: "number",
              description: `Max users to return (default ${DEFAULT_SEARCH_USERS_LIMIT}, max ${MAX_SEARCH_USERS_LIMIT})`,
            },
          },
        },
      },
      handler: (args, ctx) => handleSearchUsers(args, ctx, neo4jClient),
    },
  ];
}

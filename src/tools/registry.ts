import type { ErrorCodeValue } from "../errors.js";

// ── Descriptor types ──────────────────────────────────────────────────────────

export interface McpToolInputSchema {
  type: "object";
  properties: Record<string, unknown>;
  required?: string[];
  additionalProperties?: boolean;
}

export interface McpTool {
  name: string;
  description: string;
  inputSchema: McpToolInputSchema;
}

// ── Runtime types ─────────────────────────────────────────────────────────────

export interface ToolContext {
  userId: string;
  namespace: string;
}

export type ToolHandler = (
  args: Record<string, unknown>,
  ctx: ToolContext,
) => Promise<unknown>;

export interface RegisteredTool {
  descriptor: McpTool;
  handler: ToolHandler;
}

// ── ToolError ─────────────────────────────────────────────────────────────────

/**
 * Thrown by tool handlers for expected failures (permission denied, not found,
 * invalid params). The router catches this and converts it to a JSON-RPC error.
 */
export class ToolError extends Error {
  constructor(
    public readonly code: ErrorCodeValue,
    message: string,
  ) {
    super(message);
    this.name = "ToolError";
  }
}

// ── Tool list ─────────────────────────────────────────────────────────────────

/**
 * Populated by `createResourceTools` (Part 7) and `createSharingTools` (Part 8).
 * main.ts builds the full list and passes it to `createMcpRouter`.
 */
export const TOOL_LIST: RegisteredTool[] = [];

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
  lockedNamespace?: boolean;
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

// ── Write tool set ────────────────────────────────────────────────────────────

export const WRITE_TOOLS = new Set([
  "knowledge_create_entry",
  "knowledge_update_entry",
  "knowledge_delete_entry",
  "knowledge_create_relation",
  "knowledge_delete_relation",
  "knowledge_share_entry",
  "knowledge_revoke_access",
  "knowledge_update_namespace_config",
]);

// Tools that accept an optional `namespace` filter and default to ALL namespaces
// when omitted. These need namespace injection when a session lock is active.
export const NAMESPACE_INJECT_TOOLS = new Set([
  "knowledge_search_entries",
]);

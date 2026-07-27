import { ErrorCode, type ErrorCodeValue } from "../errors.js";
import type { NamespaceScope } from "../session.js";

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
  /** Default namespace for calls that omit one. Not a permission boundary. */
  namespace: string;
  /**
   * Namespaces this session may reach, or `null` when unrestricted. Required so
   * a forgotten field cannot silently mean "unrestricted" — see DECISIONS.md D-033.
   */
  namespaceScope: NamespaceScope;
  authMethod: "jwt" | "api_key";
  apiKeyId?: string;
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

// ── Namespace scope ───────────────────────────────────────────────────────────

/** True when the session's effective scope permits reaching `namespace`. */
export function isNamespaceInScope(
  scope: NamespaceScope,
  namespace: string,
): boolean {
  return scope === null || scope.includes(namespace);
}

/**
 * Rejects a namespace the session is not scoped for.
 *
 * This is a preflight check for precise error reporting only — the security
 * boundary is the `$namespaceScope` predicate inside the Cypher queries.
 */
export function assertNamespaceInScope(
  ctx: ToolContext,
  namespace: string,
): void {
  if (!isNamespaceInScope(ctx.namespaceScope, namespace)) {
    throw new ToolError(
      ErrorCode.PERMISSION_DENIED,
      `Namespace is outside the session scope: ${namespace}`,
    );
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
  "knowledge_create_api_key",
  "knowledge_revoke_api_key",
]);

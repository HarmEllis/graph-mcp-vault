// ── Types ─────────────────────────────────────────────────────────────────────

export interface McpToolInputSchema {
  type: 'object';
  properties: Record<string, unknown>;
  required?: string[];
  additionalProperties?: boolean;
}

export interface McpTool {
  name: string;
  description: string;
  inputSchema: McpToolInputSchema;
}

// ── Tool list ─────────────────────────────────────────────────────────────────

/**
 * The full list of MCP tools exposed by this server.
 * Populated incrementally as tool implementations are added (Parts 7–8).
 */
export const TOOL_LIST: McpTool[] = [];

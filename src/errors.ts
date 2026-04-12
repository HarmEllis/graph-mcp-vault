export const ErrorCode = {
  PARSE_ERROR: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  SESSION_NOT_FOUND: -32000,
  SESSION_NAMESPACE_CONFLICT: -32001,
  PERMISSION_DENIED: -32002,
  RESOURCE_NOT_FOUND: -32003,
  INTERNAL_ERROR: -32004,
} as const;

export type ErrorCodeValue = (typeof ErrorCode)[keyof typeof ErrorCode];

export interface JsonRpcError {
  jsonrpc: '2.0';
  id: number | string | null;
  error: {
    code: ErrorCodeValue;
    message: string;
    data?: unknown;
  };
}

export function makeJsonRpcError(
  id: number | string | null,
  code: ErrorCodeValue,
  message: string,
  data?: unknown,
): JsonRpcError {
  const error: JsonRpcError['error'] = { code, message };
  if (data !== undefined) {
    error.data = data;
  }
  return { jsonrpc: '2.0', id, error };
}

import { describe, it, expect } from 'vitest';
import { ErrorCode, makeJsonRpcError } from '../src/errors.js';

describe('ErrorCode', () => {
  it('has the correct numeric values per the error taxonomy', () => {
    expect(ErrorCode.PARSE_ERROR).toBe(-32700);
    expect(ErrorCode.INVALID_REQUEST).toBe(-32600);
    expect(ErrorCode.METHOD_NOT_FOUND).toBe(-32601);
    expect(ErrorCode.INVALID_PARAMS).toBe(-32602);
    expect(ErrorCode.SESSION_NOT_FOUND).toBe(-32000);
    expect(ErrorCode.SESSION_NAMESPACE_CONFLICT).toBe(-32001);
    expect(ErrorCode.PERMISSION_DENIED).toBe(-32002);
    expect(ErrorCode.RESOURCE_NOT_FOUND).toBe(-32003);
    expect(ErrorCode.INTERNAL_ERROR).toBe(-32004);
  });
});

describe('makeJsonRpcError', () => {
  it('creates a well-formed JSON-RPC 2.0 error response', () => {
    const err = makeJsonRpcError(1, ErrorCode.INVALID_REQUEST, 'bad request');
    expect(err).toEqual({
      jsonrpc: '2.0',
      id: 1,
      error: { code: -32600, message: 'bad request' },
    });
  });

  it('includes optional data field when provided', () => {
    const err = makeJsonRpcError(2, ErrorCode.INTERNAL_ERROR, 'oops', {
      detail: 'stack trace',
    });
    expect(err.error.data).toEqual({ detail: 'stack trace' });
  });

  it('omits data field when not provided', () => {
    const err = makeJsonRpcError(3, ErrorCode.PARSE_ERROR, 'malformed');
    expect('data' in err.error).toBe(false);
  });

  it('accepts null id for notifications or parse failures', () => {
    const err = makeJsonRpcError(null, ErrorCode.PARSE_ERROR, 'malformed JSON');
    expect(err.id).toBeNull();
  });

  it('accepts string id', () => {
    const err = makeJsonRpcError('req-abc', ErrorCode.METHOD_NOT_FOUND, 'unknown method');
    expect(err.id).toBe('req-abc');
  });

  it('returns the exact code value in the error envelope', () => {
    const err = makeJsonRpcError(5, ErrorCode.PERMISSION_DENIED, 'not allowed');
    expect(err.error.code).toBe(-32002);
  });
});

import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { SignJWT, exportJWK, generateKeyPair } from 'jose';
import type { KeyLike } from 'jose';
import { Hono } from 'hono';
import { createLogger } from '../src/logger.js';
import type { Logger, LogLevel } from '../src/logger.js';
import { createMcpRouter } from '../src/routers/mcp.js';
import { JwksClient } from '../src/auth.js';
import { SessionStore } from '../src/session.js';
import { ErrorCode } from '../src/errors.js';
import { ToolError } from '../src/tools/registry.js';
import type { RegisteredTool } from '../src/tools/registry.js';
import type { Config } from '../src/config.js';

// ── Logger unit tests ─────────────────────────────────────────────────────────

describe('createLogger: level filtering', () => {
  it('suppresses logs below minLevel', () => {
    const lines: string[] = [];
    const logger = createLogger('warn', (l) => lines.push(l));
    logger.debug('debug_event');
    logger.info('info_event');
    expect(lines).toHaveLength(0);
  });

  it('emits logs at minLevel', () => {
    const lines: string[] = [];
    const logger = createLogger('warn', (l) => lines.push(l));
    logger.warn('warn_event');
    expect(lines).toHaveLength(1);
  });

  it('emits logs above minLevel', () => {
    const lines: string[] = [];
    const logger = createLogger('warn', (l) => lines.push(l));
    logger.error('error_event');
    expect(lines).toHaveLength(1);
  });

  it('emits all levels when minLevel is trace', () => {
    const lines: string[] = [];
    const logger = createLogger('trace', (l) => lines.push(l));
    logger.trace('t');
    logger.debug('d');
    logger.info('i');
    logger.warn('w');
    logger.error('e');
    expect(lines).toHaveLength(5);
  });
});

describe('createLogger: structured output', () => {
  it('emits valid JSON on every call', () => {
    const lines: string[] = [];
    const logger = createLogger('info', (l) => lines.push(l));
    logger.info('some_event');
    expect(() => JSON.parse(lines[0]!)).not.toThrow();
  });

  it('emitted object contains timestamp, level, and event', () => {
    const lines: string[] = [];
    const logger = createLogger('info', (l) => lines.push(l));
    logger.info('test_event');
    const entry = JSON.parse(lines[0]!) as Record<string, unknown>;
    expect(typeof entry['timestamp']).toBe('string');
    expect(entry['level']).toBe('info');
    expect(entry['event']).toBe('test_event');
  });

  it('includes extra fields in the emitted object', () => {
    const lines: string[] = [];
    const logger = createLogger('info', (l) => lines.push(l));
    logger.info('ctx_event', { userId: 'u1', namespace: 'ns1', durationMs: 42 });
    const entry = JSON.parse(lines[0]!) as Record<string, unknown>;
    expect(entry['userId']).toBe('u1');
    expect(entry['namespace']).toBe('ns1');
    expect(entry['durationMs']).toBe(42);
  });

  it('timestamp is a valid ISO 8601 string', () => {
    const lines: string[] = [];
    const logger = createLogger('info', (l) => lines.push(l));
    logger.info('ts_event');
    const entry = JSON.parse(lines[0]!) as Record<string, unknown>;
    expect(() => new Date(entry['timestamp'] as string).toISOString()).not.toThrow();
  });
});

// ── MCP router integration tests ──────────────────────────────────────────────

const ISSUER = 'https://oidc.example.com';
const AUDIENCE = 'graph-mcp-vault';
const KID = 'log-test-key';
const JWKS_URI = `${ISSUER}/.well-known/jwks.json`;

const BASE_CONFIG: Config = {
  oidcIssuer: ISSUER,
  oidcAudience: AUDIENCE,
  jwksCacheTtl: 3600,
  metadataCacheTtl: 3600,
  neo4jUri: 'bolt://localhost:7687',
  neo4jUser: 'neo4j',
  neo4jPassword: 'secret',
  host: '0.0.0.0',
  port: 8000,
  defaultNamespace: 'default',
  logLevel: 'info',
  allowedOrigins: '',
};

let privateKey: KeyLike;
let jwksDoc: object;

beforeAll(async () => {
  const pair = await generateKeyPair('RS256');
  privateKey = pair.privateKey;
  const jwk = await exportJWK(pair.publicKey);
  jwksDoc = { keys: [{ ...jwk, kid: KID, use: 'sig' }] };
});

afterEach(() => {
  vi.restoreAllMocks();
});

function stubJwks(): void {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => jwksDoc }),
  );
}

async function makeToken(sub = 'user-test'): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({ sub })
    .setProtectedHeader({ alg: 'RS256', kid: KID })
    .setIssuer(ISSUER)
    .setAudience(AUDIENCE)
    .setIssuedAt()
    .setExpirationTime(now + 3600)
    .sign(privateKey);
}

/** Builds an app with a capturing logger and optional registered tools. */
function buildApp(
  tools: RegisteredTool[] = [],
  minLevel: LogLevel = 'trace',
): { app: Hono; lines: Record<string, unknown>[] } {
  const captured: Record<string, unknown>[] = [];
  const logger = createLogger(minLevel, (l) => captured.push(JSON.parse(l) as Record<string, unknown>));
  const sessionStore = new SessionStore();
  const jwksClient = new JwksClient(JWKS_URI, BASE_CONFIG.jwksCacheTtl * 1000);
  const app = new Hono();
  app.route('/', createMcpRouter(BASE_CONFIG, sessionStore, jwksClient, tools, logger));
  return { app, lines: captured };
}

async function post(
  app: Hono,
  path: string,
  body: unknown,
  headers: Record<string, string> = {},
): Promise<Response> {
  return app.request(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
}

async function doInitialize(
  app: Hono,
  token: string,
  namespace = 'default',
): Promise<string> {
  const res = await post(
    app,
    '/mcp',
    {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2025-03-26',
        capabilities: {},
        clientInfo: { name: 'test', version: '1.0' },
        meta: { namespace },
      },
    },
    { Authorization: `Bearer ${token}` },
  );
  const sid = res.headers.get('mcp-session-id');
  if (!sid) throw new Error(`initialize failed (status ${res.status})`);
  return sid;
}

// ── auth_failure ──────────────────────────────────────────────────────────────

describe('MCP logging: auth_failure', () => {
  it('emits auth_failure warn when Authorization header is absent', async () => {
    stubJwks();
    const { app, lines } = buildApp();
    await post(app, '/mcp', { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
    const entry = lines.find((l) => l['event'] === 'auth_failure');
    expect(entry).toBeDefined();
    expect(entry!['level']).toBe('warn');
  });

  it('does NOT include the JWT token in the auth_failure log', async () => {
    stubJwks();
    const { app, lines } = buildApp();
    const token = await makeToken();
    // Send an invalid token to force auth failure
    await post(app, '/mcp', { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }, {
      Authorization: `Bearer ${token}-tampered`,
    });
    const logOutput = JSON.stringify(lines);
    expect(logOutput).not.toContain(token);
  });
});

// ── session events ────────────────────────────────────────────────────────────

describe('MCP logging: session events', () => {
  it('emits session_missing warn when Mcp-Session-Id header is absent', async () => {
    stubJwks();
    const { app, lines } = buildApp();
    const token = await makeToken();
    await post(
      app,
      '/mcp',
      { jsonrpc: '2.0', id: 2, method: 'tools/list' },
      { Authorization: `Bearer ${token}` },
    );
    const entry = lines.find((l) => l['event'] === 'session_missing');
    expect(entry).toBeDefined();
    expect(entry!['level']).toBe('warn');
  });

  it('emits session_not_found warn for an unknown session id', async () => {
    stubJwks();
    const { app, lines } = buildApp();
    const token = await makeToken();
    await post(
      app,
      '/mcp',
      { jsonrpc: '2.0', id: 2, method: 'tools/list' },
      { Authorization: `Bearer ${token}`, 'Mcp-Session-Id': '00000000-0000-0000-0000-000000000000' },
    );
    const entry = lines.find((l) => l['event'] === 'session_not_found');
    expect(entry).toBeDefined();
    expect(entry!['level']).toBe('warn');
  });

  it('emits namespace_conflict warn when URL namespace mismatches session', async () => {
    stubJwks();
    const { app, lines } = buildApp();
    const token = await makeToken();
    const sid = await doInitialize(app, token, 'ns-a');
    // clear relevant lines so far, re-use same lines array
    lines.length = 0;
    await post(
      app,
      '/mcp/ns-b',
      { jsonrpc: '2.0', id: 3, method: 'tools/list' },
      { Authorization: `Bearer ${token}`, 'Mcp-Session-Id': sid },
    );
    const entry = lines.find((l) => l['event'] === 'namespace_conflict');
    expect(entry).toBeDefined();
    expect(entry!['level']).toBe('warn');
  });
});

// ── session_created ───────────────────────────────────────────────────────────

describe('MCP logging: session_created', () => {
  it('emits session_created info with userId, namespace, sessionId', async () => {
    stubJwks();
    const { app, lines } = buildApp();
    const token = await makeToken('the-user');
    const sid = await doInitialize(app, token, 'my-ns');
    const entry = lines.find((l) => l['event'] === 'session_created');
    expect(entry).toBeDefined();
    expect(entry!['level']).toBe('info');
    expect(entry!['userId']).toBe('the-user');
    expect(entry!['namespace']).toBe('my-ns');
    expect(entry!['sessionId']).toBe(sid);
  });
});

// ── tools/list ────────────────────────────────────────────────────────────────

describe('MCP logging: tools_list', () => {
  it('emits tools_list info with userId and namespace', async () => {
    stubJwks();
    const { app, lines } = buildApp();
    const token = await makeToken('list-user');
    const sid = await doInitialize(app, token, 'list-ns');
    lines.length = 0;
    await post(
      app,
      '/mcp',
      { jsonrpc: '2.0', id: 2, method: 'tools/list' },
      { Authorization: `Bearer ${token}`, 'Mcp-Session-Id': sid },
    );
    const entry = lines.find((l) => l['event'] === 'tools_list');
    expect(entry).toBeDefined();
    expect(entry!['level']).toBe('info');
    expect(entry!['userId']).toBe('list-user');
    expect(entry!['namespace']).toBe('list-ns');
  });
});

// ── tool_call success ─────────────────────────────────────────────────────────

const echoTool: RegisteredTool = {
  descriptor: {
    name: 'echo',
    description: 'Echo the input back.',
    inputSchema: { type: 'object', properties: { msg: { type: 'string' } }, required: [] },
  },
  handler: async (args) => ({ echoed: args['msg'] }),
};

const failTool: RegisteredTool = {
  descriptor: {
    name: 'fail',
    description: 'Always throws PERMISSION_DENIED.',
    inputSchema: { type: 'object', properties: {}, required: [] },
  },
  handler: async () => {
    throw new ToolError(ErrorCode.PERMISSION_DENIED, 'nope');
  },
};

describe('MCP logging: tool_call', () => {
  it('emits tool_call info with tool, userId, namespace, durationMs, isError:false on success', async () => {
    stubJwks();
    const { app, lines } = buildApp([echoTool]);
    const token = await makeToken('call-user');
    const sid = await doInitialize(app, token, 'call-ns');
    lines.length = 0;
    await post(
      app,
      '/mcp',
      { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'echo', arguments: { msg: 'hi' } } },
      { Authorization: `Bearer ${token}`, 'Mcp-Session-Id': sid },
    );
    const entry = lines.find((l) => l['event'] === 'tool_call');
    expect(entry).toBeDefined();
    expect(entry!['level']).toBe('info');
    expect(entry!['tool']).toBe('echo');
    expect(entry!['userId']).toBe('call-user');
    expect(entry!['namespace']).toBe('call-ns');
    expect(typeof entry!['durationMs']).toBe('number');
    expect(entry!['isError']).toBe(false);
  });

  it('emits tool_call info with isError:true and jsonRpcErrorCode on ToolError', async () => {
    stubJwks();
    const { app, lines } = buildApp([failTool]);
    const token = await makeToken('fail-user');
    const sid = await doInitialize(app, token, 'fail-ns');
    lines.length = 0;
    await post(
      app,
      '/mcp',
      { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'fail', arguments: {} } },
      { Authorization: `Bearer ${token}`, 'Mcp-Session-Id': sid },
    );
    const entry = lines.find((l) => l['event'] === 'tool_call');
    expect(entry).toBeDefined();
    expect(entry!['isError']).toBe(true);
    expect(entry!['jsonRpcErrorCode']).toBe(ErrorCode.PERMISSION_DENIED);
    expect(typeof entry!['durationMs']).toBe('number');
  });

  it('does not log resource content in tool_call logs', async () => {
    stubJwks();
    const { app, lines } = buildApp([echoTool]);
    const token = await makeToken('privacy-user');
    const sid = await doInitialize(app, token, 'priv-ns');
    lines.length = 0;
    const secretPayload = 'SUPER_SECRET_CONTENT_XYZ';
    await post(
      app,
      '/mcp',
      {
        jsonrpc: '2.0',
        id: 5,
        method: 'tools/call',
        params: { name: 'echo', arguments: { msg: secretPayload } },
      },
      { Authorization: `Bearer ${token}`, 'Mcp-Session-Id': sid },
    );
    const logOutput = JSON.stringify(lines);
    expect(logOutput).not.toContain(secretPayload);
  });

  it('emits request_start and request_end debug events', async () => {
    stubJwks();
    const { app, lines } = buildApp([], 'debug');
    const token = await makeToken();
    await post(
      app,
      '/mcp',
      { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 't', version: '1' } } },
      { Authorization: `Bearer ${token}` },
    );
    expect(lines.some((l) => l['event'] === 'request_start')).toBe(true);
    expect(lines.some((l) => l['event'] === 'request_end')).toBe(true);
  });
});

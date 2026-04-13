import { Hono } from 'hono';
import type { Context } from 'hono';
import { validateBearerToken, type JwksClient } from '../auth.js';
import { ErrorCode, makeJsonRpcError } from '../errors.js';
import type { SessionStore } from '../session.js';
import type { Config } from '../config.js';
import { ToolError, type RegisteredTool, type ToolContext } from '../tools/registry.js';

// ── Constants ─────────────────────────────────────────────────────────────────

const SUPPORTED_VERSION = '2025-03-26';

// All protocol versions the MCP ecosystem has defined. The server negotiates
// down to SUPPORTED_VERSION regardless of which version the client proposes,
// matching the version-negotiation intent of the MCP spec.
const KNOWN_PROTOCOL_VERSIONS = new Set([
  '2025-11-25',
  '2025-06-18',
  '2025-03-26',
  '2024-11-05',
  '2024-10-07',
]);
const SERVER_NAME = 'graph-mcp-vault';
const SERVER_VERSION = '0.1.0';

// ── JSON-RPC types ────────────────────────────────────────────────────────────

type JsonRpcId = number | string | null;

interface JsonRpcRequest {
  jsonrpc: '2.0';
  id: JsonRpcId;
  method: string;
  params?: unknown;
}

interface JsonRpcNotification {
  jsonrpc: '2.0';
  method: string;
  params?: unknown;
}

type JsonRpcMessage = JsonRpcRequest | JsonRpcNotification;

// ── Parse helpers ─────────────────────────────────────────────────────────────

function parseMessage(raw: unknown): JsonRpcMessage | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const r = raw as Record<string, unknown>;
  if (r['jsonrpc'] !== '2.0' || typeof r['method'] !== 'string') return null;
  const method = r['method'];
  const msg: Record<string, unknown> = { jsonrpc: '2.0', method };
  if (r['params'] !== undefined) msg['params'] = r['params'];

  if ('id' in r) {
    const id = r['id'];
    if (id !== null && typeof id !== 'number' && typeof id !== 'string') return null;
    msg['id'] = id;
    return msg as unknown as JsonRpcRequest;
  }
  return msg as unknown as JsonRpcNotification;
}

function isRequest(msg: JsonRpcMessage): msg is JsonRpcRequest {
  return 'id' in msg;
}

// ── Dispatch result ───────────────────────────────────────────────────────────

interface DispatchResult {
  response: unknown;
  sessionId: string | null;
  httpStatus: number;
}

interface CorsResolution {
  allowed: boolean;
  allowOrigin: string | undefined;
}

function resolveCorsOrigin(
  origin: string | undefined,
  allowedOrigins: string,
): CorsResolution {
  if (!origin) {
    return { allowed: true, allowOrigin: undefined };
  }
  if (!allowedOrigins) {
    return { allowed: true, allowOrigin: undefined };
  }

  const allowed = allowedOrigins
    .split(',')
    .map((value) => value.trim())
    .filter((value) => value.length > 0);

  if (allowed.includes('*')) {
    return { allowed: true, allowOrigin: '*' };
  }
  if (allowed.includes(origin)) {
    return { allowed: true, allowOrigin: origin };
  }
  return { allowed: false, allowOrigin: undefined };
}

function withCorsHeaders(response: Response, allowOrigin: string | undefined): Response {
  if (!allowOrigin) return response;

  const headers = new Headers(response.headers);
  headers.set('Access-Control-Allow-Origin', allowOrigin);
  headers.set('Access-Control-Expose-Headers', 'Mcp-Session-Id');
  if (allowOrigin !== '*') {
    headers.append('Vary', 'Origin');
  }
  return new Response(response.body, { status: response.status, headers });
}

function makePreflightResponse(
  status: number,
  allowOrigin: string | undefined,
): Response {
  const headers = new Headers();
  if (allowOrigin) {
    headers.set('Access-Control-Allow-Origin', allowOrigin);
    headers.set('Access-Control-Allow-Methods', 'POST, OPTIONS');
    headers.set('Access-Control-Allow-Headers', 'Authorization, Content-Type, Mcp-Session-Id');
    headers.set('Access-Control-Max-Age', '86400');
    if (allowOrigin !== '*') {
      headers.append('Vary', 'Origin');
    }
  }
  return new Response(null, { status, headers });
}

// ── createMcpRouter ───────────────────────────────────────────────────────────

export function createMcpRouter(
  config: Config,
  sessionStore: SessionStore,
  jwksClient: JwksClient,
  tools: RegisteredTool[],
): Hono {
  const app = new Hono();

  // GET /mcp and /mcp/:namespace → 405
  app.get('/mcp', (c) => c.text('Method Not Allowed', 405));
  app.get('/mcp/:namespace', (c) => c.text('Method Not Allowed', 405));

  // OPTIONS /mcp and /mcp/:namespace → CORS preflight
  function handleOptions(c: Context): Response {
    const cors = resolveCorsOrigin(c.req.header('origin'), config.allowedOrigins);
    if (!cors.allowed) {
      return makePreflightResponse(403, cors.allowOrigin);
    }
    return makePreflightResponse(204, cors.allowOrigin);
  }

  app.options('/mcp', handleOptions);
  app.options('/mcp/:namespace', handleOptions);

  // ── Shared POST handler ───────────────────────────────────────────────────

  async function handlePost(c: Context): Promise<Response> {
    const urlNamespace = c.req.param('namespace') as string | undefined;

    // 1. CORS origin check
    const cors = resolveCorsOrigin(c.req.header('origin'), config.allowedOrigins);
    if (!cors.allowed) {
      return withCorsHeaders(c.json({ error: 'forbidden' }, 403), cors.allowOrigin);
    }

    // 2. Parse JSON body
    let rawBody: unknown;
    try {
      rawBody = await c.req.json();
    } catch {
      return withCorsHeaders(
        c.json(makeJsonRpcError(null, ErrorCode.PARSE_ERROR, 'Parse error'), 400),
        cors.allowOrigin,
      );
    }

    // 3. Authenticate
    let userId: string;
    try {
      ({ userId } = await validateBearerToken(
        c.req.header('authorization'),
        config,
        jwksClient,
      ));
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unauthorized';
      return withCorsHeaders(c.json({ error: 'unauthorized', message }, 401), cors.allowOrigin);
    }

    // 4. Batch vs single
    if (Array.isArray(rawBody)) {
      return withCorsHeaders(
        await handleBatch(rawBody, userId, urlNamespace, c.req.header('mcp-session-id')),
        cors.allowOrigin,
      );
    }
    return withCorsHeaders(
      await handleSingle(rawBody, userId, urlNamespace, c.req.header('mcp-session-id')),
      cors.allowOrigin,
    );
  }

  // ── Single message ────────────────────────────────────────────────────────

  async function handleSingle(
    raw: unknown,
    userId: string,
    urlNamespace: string | undefined,
    sessionHeader: string | undefined,
  ): Promise<Response> {
    const msg = parseMessage(raw);
    if (!msg) {
      return Response.json(
        makeJsonRpcError(null, ErrorCode.INVALID_REQUEST, 'Invalid JSON-RPC request'),
        { status: 400 },
      );
    }

    if (!isRequest(msg)) {
      return new Response(null, { status: 202 });
    }

    const result = await dispatchRequest(msg, userId, urlNamespace, sessionHeader);
    const headers: Record<string, string> = {};
    if (result.sessionId !== null) headers['Mcp-Session-Id'] = result.sessionId;
    return Response.json(result.response, { status: result.httpStatus, headers });
  }

  // ── Batch ─────────────────────────────────────────────────────────────────

  async function handleBatch(
    items: unknown[],
    userId: string,
    urlNamespace: string | undefined,
    sessionHeader: string | undefined,
  ): Promise<Response> {
    const responses: unknown[] = [];
    let newSessionId: string | null = null;

    for (const item of items) {
      const msg = parseMessage(item);
      if (!msg) {
        responses.push(
          makeJsonRpcError(null, ErrorCode.INVALID_REQUEST, 'Invalid JSON-RPC request'),
        );
        continue;
      }
      if (!isRequest(msg)) continue;

      const result = await dispatchRequest(msg, userId, urlNamespace, sessionHeader);
      if (result.sessionId !== null) newSessionId = result.sessionId;
      responses.push(result.response);
    }

    if (responses.length === 0) {
      return new Response(null, { status: 202 });
    }

    const headers: Record<string, string> = {};
    if (newSessionId !== null) headers['Mcp-Session-Id'] = newSessionId;
    return Response.json(responses, { status: 200, headers });
  }

  // ── Method dispatch ───────────────────────────────────────────────────────

  async function dispatchRequest(
    req: JsonRpcRequest,
    userId: string,
    urlNamespace: string | undefined,
    sessionHeader: string | undefined,
  ): Promise<DispatchResult> {
    const { id, method } = req;

    if (method === 'initialize') {
      return handleInitialize(req, userId, urlNamespace);
    }

    if (!sessionHeader) {
      return {
        response: makeJsonRpcError(id, ErrorCode.INVALID_REQUEST, 'Missing Mcp-Session-Id header'),
        sessionId: null,
        httpStatus: 400,
      };
    }

    const session = sessionStore.get(sessionHeader);
    if (!session) {
      return {
        response: makeJsonRpcError(id, ErrorCode.SESSION_NOT_FOUND, 'Session not found or expired'),
        sessionId: null,
        httpStatus: 404,
      };
    }
    if (session.userId !== userId) {
      return {
        response: makeJsonRpcError(id, ErrorCode.SESSION_NOT_FOUND, 'Session not found or expired'),
        sessionId: null,
        httpStatus: 404,
      };
    }

    if (urlNamespace !== undefined && urlNamespace !== session.namespace) {
      return {
        response: makeJsonRpcError(id, ErrorCode.SESSION_NAMESPACE_CONFLICT, 'Namespace mismatch'),
        sessionId: null,
        httpStatus: 404,
      };
    }

    const ctx: ToolContext = { userId: session.userId, namespace: session.namespace };

    switch (method) {
      case 'tools/list':
        return {
          response: { jsonrpc: '2.0', id, result: { tools: tools.map((t) => t.descriptor) } },
          sessionId: null,
          httpStatus: 200,
        };

      case 'tools/call':
        return handleToolCall(req, ctx);

      default:
        return {
          response: makeJsonRpcError(id, ErrorCode.METHOD_NOT_FOUND, `Method not found: ${method}`),
          sessionId: null,
          httpStatus: 200,
        };
    }
  }

  // ── tools/call handler ────────────────────────────────────────────────────

  async function handleToolCall(req: JsonRpcRequest, ctx: ToolContext): Promise<DispatchResult> {
    const { id } = req;
    const params = req.params as Record<string, unknown> | undefined;

    const toolName = params?.['name'];
    if (typeof toolName !== 'string') {
      return {
        response: makeJsonRpcError(id, ErrorCode.INVALID_PARAMS, 'Missing or invalid tool name'),
        sessionId: null,
        httpStatus: 200,
      };
    }

    const registered = tools.find((t) => t.descriptor.name === toolName);
    if (!registered) {
      return {
        response: makeJsonRpcError(id, ErrorCode.METHOD_NOT_FOUND, `Unknown tool: ${toolName}`),
        sessionId: null,
        httpStatus: 200,
      };
    }

    const args = (params?.['arguments'] ?? {}) as Record<string, unknown>;

    try {
      const result = await registered.handler(args, ctx);
      return { response: { jsonrpc: '2.0', id, result }, sessionId: null, httpStatus: 200 };
    } catch (err) {
      if (err instanceof ToolError) {
        return {
          response: makeJsonRpcError(id, err.code, err.message),
          sessionId: null,
          httpStatus: 200,
        };
      }
      const msg = err instanceof Error ? err.message : 'Internal error';
      return {
        response: makeJsonRpcError(id, ErrorCode.INTERNAL_ERROR, msg),
        sessionId: null,
        httpStatus: 500,
      };
    }
  }

  // ── initialize handler ────────────────────────────────────────────────────

  function handleInitialize(
    req: JsonRpcRequest,
    userId: string,
    urlNamespace: string | undefined,
  ): DispatchResult {
    const { id } = req;
    const params = req.params as Record<string, unknown> | undefined;

    const clientVersion = params?.['protocolVersion'];
    if (typeof clientVersion !== 'string' || !KNOWN_PROTOCOL_VERSIONS.has(clientVersion)) {
      return {
        response: makeJsonRpcError(
          id,
          ErrorCode.INVALID_REQUEST,
          'Unsupported protocol version',
          { supported: [SUPPORTED_VERSION] },
        ),
        sessionId: null,
        httpStatus: 400,
      };
    }

    const metaNamespace = (() => {
      const meta = params?.['meta'];
      if (typeof meta === 'object' && meta !== null) {
        const ns = (meta as Record<string, unknown>)['namespace'];
        return typeof ns === 'string' ? ns : undefined;
      }
      return undefined;
    })();

    const namespace = metaNamespace ?? urlNamespace ?? config.defaultNamespace;
    const sessionId = sessionStore.create(userId, namespace);

    return {
      response: {
        jsonrpc: '2.0',
        id,
        result: {
          protocolVersion: SUPPORTED_VERSION,
          capabilities: { tools: {} },
          serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
          meta: { sessionId },
        },
      },
      sessionId,
      httpStatus: 200,
    };
  }

  app.post('/mcp', handlePost);
  app.post('/mcp/:namespace', handlePost);

  return app;
}

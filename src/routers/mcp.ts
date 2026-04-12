import { Hono } from 'hono';
import type { Context } from 'hono';
import { validateBearerToken, type JwksClient } from '../auth.js';
import { ErrorCode, makeJsonRpcError } from '../errors.js';
import type { SessionStore } from '../session.js';
import type { Config } from '../config.js';
import type { McpTool } from '../tools/registry.js';

// ── Constants ─────────────────────────────────────────────────────────────────

const SUPPORTED_VERSION = '2025-03-26';
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

// ── createMcpRouter ───────────────────────────────────────────────────────────

export function createMcpRouter(
  config: Config,
  sessionStore: SessionStore,
  jwksClient: JwksClient,
  tools: McpTool[],
): Hono {
  const app = new Hono();

  // GET /mcp and /mcp/:namespace → 405
  app.get('/mcp', (c) => c.text('Method Not Allowed', 405));
  app.get('/mcp/:namespace', (c) => c.text('Method Not Allowed', 405));

  // ── Shared POST handler ───────────────────────────────────────────────────

  async function handlePost(c: Context): Promise<Response> {
    const urlNamespace = c.req.param('namespace') as string | undefined;

    // 1. CORS origin check
    const origin = c.req.header('origin');
    if (config.allowedOrigins && origin) {
      const allowed = config.allowedOrigins.split(',').map((o) => o.trim());
      if (!allowed.includes('*') && !allowed.includes(origin)) {
        return c.json({ error: 'forbidden' }, 403);
      }
    }

    // 2. Parse JSON body
    let rawBody: unknown;
    try {
      rawBody = await c.req.json();
    } catch {
      return c.json(makeJsonRpcError(null, ErrorCode.PARSE_ERROR, 'Parse error'), 400);
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
      return c.json({ error: 'unauthorized', message }, 401);
    }

    // 4. Batch vs single
    if (Array.isArray(rawBody)) {
      return handleBatch(rawBody, userId, urlNamespace, c.req.header('mcp-session-id'));
    }
    return handleSingle(rawBody, userId, urlNamespace, c.req.header('mcp-session-id'));
  }

  // ── Single message ────────────────────────────────────────────────────────

  function handleSingle(
    raw: unknown,
    userId: string,
    urlNamespace: string | undefined,
    sessionHeader: string | undefined,
  ): Response {
    const msg = parseMessage(raw);
    if (!msg) {
      return Response.json(
        makeJsonRpcError(null, ErrorCode.INVALID_REQUEST, 'Invalid JSON-RPC request'),
        { status: 400 },
      );
    }

    // Notification — no response
    if (!isRequest(msg)) {
      return new Response(null, { status: 202 });
    }

    const result = dispatchRequest(msg, userId, urlNamespace, sessionHeader);
    const headers: Record<string, string> = {};
    if (result.sessionId !== null) headers['Mcp-Session-Id'] = result.sessionId;
    return Response.json(result.response, { status: result.httpStatus, headers });
  }

  // ── Batch ─────────────────────────────────────────────────────────────────

  function handleBatch(
    items: unknown[],
    userId: string,
    urlNamespace: string | undefined,
    sessionHeader: string | undefined,
  ): Response {
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
      if (!isRequest(msg)) continue; // notifications produce no response entry

      const result = dispatchRequest(msg, userId, urlNamespace, sessionHeader);
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

  function dispatchRequest(
    req: JsonRpcRequest,
    userId: string,
    urlNamespace: string | undefined,
    sessionHeader: string | undefined,
  ): DispatchResult {
    const { id, method } = req;

    // initialize — creates a new session, no prior session needed
    if (method === 'initialize') {
      return handleInitialize(req, userId, urlNamespace);
    }

    // All other methods require a valid session
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

    // Namespace conflict check (only when request came via /mcp/:namespace)
    if (urlNamespace !== undefined && urlNamespace !== session.namespace) {
      return {
        response: makeJsonRpcError(id, ErrorCode.SESSION_NAMESPACE_CONFLICT, 'Namespace mismatch'),
        sessionId: null,
        httpStatus: 404,
      };
    }

    switch (method) {
      case 'tools/list':
        return {
          response: { jsonrpc: '2.0', id, result: { tools } },
          sessionId: null,
          httpStatus: 200,
        };

      default:
        return {
          response: makeJsonRpcError(id, ErrorCode.METHOD_NOT_FOUND, `Method not found: ${method}`),
          sessionId: null,
          httpStatus: 200,
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

    // Validate protocol version
    const clientVersion = params?.['protocolVersion'];
    if (clientVersion !== SUPPORTED_VERSION) {
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

    // Resolve namespace: params.meta.namespace → URL path → DEFAULT_NAMESPACE
    const metaNamespace = (() => {
      const meta = params?.['meta'];
      if (typeof meta === 'object' && meta !== null) {
        const ns = (meta as Record<string, unknown>)['namespace'];
        return typeof ns === 'string' ? ns : undefined;
      }
      return undefined;
    })();

    const namespace = metaNamespace ?? urlNamespace ?? config.defaultNamespace;

    // Create session
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

import { Hono } from "hono";
import { SignJWT, exportJWK, generateKeyPair } from "jose";
import type { KeyLike } from "jose";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { JwksClient } from "../src/auth.js";
import type { Config } from "../src/config.js";
import { ErrorCode } from "../src/errors.js";
import type { Neo4jClient } from "../src/neo4j-client.js";
import { createMcpRouter } from "../src/routers/mcp.js";
import { SessionStore } from "../src/session.js";
import { createResourceTools } from "../src/tools/resources.js";

// ── Stub Neo4jClient ──────────────────────────────────────────────────────────

function makeStubNeo4j(): Neo4jClient & {
  upsertUserProfileSpy: ReturnType<typeof vi.fn>;
} {
  const upsertUserProfileSpy = vi.fn().mockResolvedValue(undefined);
  return {
    upsertUserProfile: upsertUserProfileSpy,
    upsertUserProfileSpy,
  } as unknown as Neo4jClient & {
    upsertUserProfileSpy: ReturnType<typeof vi.fn>;
  };
}

// ── Fixtures ──────────────────────────────────────────────────────────────────

const ISSUER = "https://oidc.example.com";
const AUDIENCE = "graph-mcp-vault";
const KID = "test-key-1";
const JWKS_URI = `${ISSUER}/.well-known/jwks.json`;

let privateKey: KeyLike;
let jwksDoc: object;

const BASE_CONFIG: Config = {
  oidcIssuer: ISSUER,
  oidcAudience: AUDIENCE,
  jwksCacheTtl: 3600,
  jwksForceRefreshMinIntervalMs: 30_000,
  jwksFetchTimeoutMs: 5_000,
  jwksAllowStaleOnError: false,
  maxTokenLifetimeSeconds: 3600,
  maxRequestBodyBytes: 262144,
  metadataCacheTtl: 3600,
  neo4jUri: "bolt://localhost:7687",
  neo4jUser: "neo4j",
  neo4jPassword: "secret",
  host: "0.0.0.0",
  port: 8000,
  defaultNamespace: "default",
  logLevel: "info",
  allowedOrigins: "",
  oidcDiscoveryUrl: undefined,
  publicUrl: "http://localhost:8000",
  scopesAllowlist: undefined,
  maxVersionsLimit: 10,
};

beforeAll(async () => {
  const pair = await generateKeyPair("RS256");
  privateKey = pair.privateKey;
  const jwk = await exportJWK(pair.publicKey);
  jwksDoc = { keys: [{ ...jwk, kid: KID, use: "sig" }] };
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ── Helpers ───────────────────────────────────────────────────────────────────

function stubJwks(): void {
  vi.stubGlobal(
    "fetch",
    vi
      .fn()
      .mockResolvedValue({ ok: true, status: 200, json: async () => jwksDoc }),
  );
}

async function makeToken(sub = "user-123"): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({ sub })
    .setProtectedHeader({ alg: "RS256", kid: KID })
    .setIssuer(ISSUER)
    .setAudience(AUDIENCE)
    .setIssuedAt()
    .setExpirationTime(now + 3600)
    .sign(privateKey);
}

function buildApp(
  configOverride: Partial<Config> = {},
  neo4jOverride?: Neo4jClient,
): {
  app: Hono;
  sessionStore: SessionStore;
  neo4jClient: Neo4jClient;
} {
  const config = { ...BASE_CONFIG, ...configOverride };
  const sessionStore = new SessionStore();
  const jwksClient = new JwksClient(JWKS_URI, config.jwksCacheTtl * 1000);
  const neo4jClient = neo4jOverride ?? makeStubNeo4j();
  const app = new Hono();
  app.route(
    "/",
    createMcpRouter(config, sessionStore, jwksClient, [], neo4jClient, ""),
  );
  return { app, sessionStore, neo4jClient };
}

async function post(
  app: Hono,
  path: string,
  body: unknown,
  headers: Record<string, string> = {},
): Promise<Response> {
  return app.request(path, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

async function doInitialize(
  app: Hono,
  token: string,
  opts: { metaNamespace?: string; urlPath?: string } = {},
): Promise<{ sessionId: string; res: Response }> {
  const params: Record<string, unknown> = {
    protocolVersion: "2025-03-26",
    capabilities: {},
    clientInfo: { name: "test", version: "1.0" },
  };
  if (opts.metaNamespace !== undefined) {
    params.meta = { namespace: opts.metaNamespace };
  }
  const path = opts.urlPath ?? "/mcp";
  const res = await post(
    app,
    path,
    { jsonrpc: "2.0", id: 1, method: "initialize", params },
    {
      Authorization: `Bearer ${token}`,
    },
  );
  const sessionId = res.headers.get("mcp-session-id");
  if (!sessionId)
    throw new Error(`No Mcp-Session-Id in response (status ${res.status})`);
  return { sessionId, res };
}

// ── GET /mcp → 405 ────────────────────────────────────────────────────────────

describe("GET /mcp", () => {
  it("returns 405 Method Not Allowed", async () => {
    const { app } = buildApp();
    const res = await app.request("/mcp", { method: "GET" });
    expect(res.status).toBe(405);
  });

  it("returns 405 for GET /mcp/:namespace", async () => {
    const { app } = buildApp();
    const res = await app.request("/mcp/myns", { method: "GET" });
    expect(res.status).toBe(405);
  });
});

// ── Parse error ───────────────────────────────────────────────────────────────

describe("malformed JSON body", () => {
  it("returns HTTP 400 with PARSE_ERROR code", async () => {
    stubJwks();
    const token = await makeToken();
    const { app } = buildApp();

    const res = await app.request("/mcp", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: "{ not valid json",
    });

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe(ErrorCode.PARSE_ERROR);
  });
});

// ── Authentication ────────────────────────────────────────────────────────────

describe("authentication", () => {
  it("returns 401 when Authorization header is absent", async () => {
    const { app } = buildApp();
    const res = await post(app, "/mcp", {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {},
    });
    expect(res.status).toBe(401);
  });

  it("returns 401 when the token is expired", async () => {
    stubJwks();
    const expiredToken = await (async () => {
      const now = Math.floor(Date.now() / 1000);
      return new SignJWT({ sub: "user-x" })
        .setProtectedHeader({ alg: "RS256", kid: KID })
        .setIssuer(ISSUER)
        .setAudience(AUDIENCE)
        .setIssuedAt()
        .setExpirationTime(now - 60)
        .sign(privateKey);
    })();
    const { app } = buildApp();
    const res = await post(
      app,
      "/mcp",
      { jsonrpc: "2.0", id: 1, method: "initialize", params: {} },
      {
        Authorization: `Bearer ${expiredToken}`,
      },
    );
    expect(res.status).toBe(401);
  });
});

// ── Content-Type enforcement ──────────────────────────────────────────────────

describe("Content-Type enforcement", () => {
  it("returns 415 when Content-Type is missing", async () => {
    const { app } = buildApp();
    const res = await app.request("/mcp", {
      method: "POST",
      body: '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}',
    });
    expect(res.status).toBe(415);
  });

  it("returns 415 when Content-Type is text/plain", async () => {
    const { app } = buildApp();
    const res = await app.request("/mcp", {
      method: "POST",
      headers: { "Content-Type": "text/plain" },
      body: '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}',
    });
    expect(res.status).toBe(415);
  });

  it("returns 415 when Content-Type is application/x-www-form-urlencoded", async () => {
    const { app } = buildApp();
    const res = await app.request("/mcp", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: "jsonrpc=2.0&method=initialize",
    });
    expect(res.status).toBe(415);
  });
});

// ── Request body size limit ───────────────────────────────────────────────────

describe("request body size limit", () => {
  it("returns 413 when body exceeds MAX_REQUEST_BODY_BYTES", async () => {
    stubJwks();
    const token = await makeToken();
    const { app } = buildApp({ maxRequestBodyBytes: 100 });

    const res = await app.request("/mcp", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "ping",
        params: { padding: "x".repeat(200) },
      }),
    });

    expect(res.status).toBe(413);
  });

  it("returns 413 when UTF-8 bytes exceed limit but string length does not", async () => {
    stubJwks();
    const token = await makeToken();
    const payload = {
      jsonrpc: "2.0",
      id: 1,
      method: "ping",
      params: { padding: "€".repeat(100) },
    };
    const rawBody = JSON.stringify(payload);
    const stringLengthLimit = rawBody.length + 5;
    expect(Buffer.byteLength(rawBody, "utf8")).toBeGreaterThan(
      stringLengthLimit,
    );

    const { app } = buildApp({ maxRequestBodyBytes: stringLengthLimit });
    const res = await app.request("/mcp", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: rawBody,
    });

    expect(res.status).toBe(413);
  });

  it("returns 401, not 413, when token is missing even with an oversized body", async () => {
    const { app } = buildApp({ maxRequestBodyBytes: 10 });

    const res = await app.request("/mcp", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "x".repeat(200),
    });

    expect(res.status).toBe(401);
  });
});

// ── CORS origin check ─────────────────────────────────────────────────────────

describe("CORS origin check", () => {
  it("returns 403 when Origin is not in ALLOWED_ORIGINS", async () => {
    stubJwks();
    const token = await makeToken();
    const { app } = buildApp({ allowedOrigins: "https://trusted.example.com" });

    const res = await post(
      app,
      "/mcp",
      { jsonrpc: "2.0", id: 1, method: "initialize", params: {} },
      { Authorization: `Bearer ${token}`, Origin: "https://evil.example.com" },
    );

    expect(res.status).toBe(403);
  });

  it("allows requests when Origin matches ALLOWED_ORIGINS", async () => {
    stubJwks();
    const token = await makeToken();
    const { app } = buildApp({ allowedOrigins: "https://trusted.example.com" });

    const params = {
      protocolVersion: "2025-03-26",
      capabilities: {},
      clientInfo: { name: "test", version: "1.0" },
    };
    const res = await post(
      app,
      "/mcp",
      { jsonrpc: "2.0", id: 1, method: "initialize", params },
      {
        Authorization: `Bearer ${token}`,
        Origin: "https://trusted.example.com",
      },
    );

    expect(res.status).toBe(200);
    expect(res.headers.get("access-control-allow-origin")).toBe(
      "https://trusted.example.com",
    );
    expect(res.headers.get("access-control-expose-headers")).toBe(
      "Mcp-Session-Id",
    );
  });

  it("allows requests when ALLOWED_ORIGINS is wildcard *", async () => {
    stubJwks();
    const token = await makeToken();
    const { app } = buildApp({ allowedOrigins: "*" });

    const params = {
      protocolVersion: "2025-03-26",
      capabilities: {},
      clientInfo: { name: "test", version: "1.0" },
    };
    const res = await post(
      app,
      "/mcp",
      { jsonrpc: "2.0", id: 1, method: "initialize", params },
      { Authorization: `Bearer ${token}`, Origin: "https://any.example.com" },
    );

    expect(res.status).toBe(200);
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
  });

  it("allows requests when ALLOWED_ORIGINS is empty (no check)", async () => {
    stubJwks();
    const token = await makeToken();
    const { app } = buildApp({ allowedOrigins: "" });

    const params = {
      protocolVersion: "2025-03-26",
      capabilities: {},
      clientInfo: { name: "test", version: "1.0" },
    };
    const res = await post(
      app,
      "/mcp",
      { jsonrpc: "2.0", id: 1, method: "initialize", params },
      { Authorization: `Bearer ${token}`, Origin: "https://any.example.com" },
    );

    expect(res.status).toBe(200);
  });

  it("handles OPTIONS preflight for an allowed origin", async () => {
    const { app } = buildApp({ allowedOrigins: "https://trusted.example.com" });

    const res = await app.request("/mcp", {
      method: "OPTIONS",
      headers: {
        Origin: "https://trusted.example.com",
        "Access-Control-Request-Method": "POST",
      },
    });

    expect(res.status).toBe(204);
    expect(res.headers.get("access-control-allow-origin")).toBe(
      "https://trusted.example.com",
    );
    expect(res.headers.get("access-control-allow-methods")).toBe(
      "POST, OPTIONS",
    );
    expect(res.headers.get("access-control-allow-headers")).toContain(
      "Mcp-Session-Id",
    );
  });

  it("returns 403 for OPTIONS preflight from a disallowed origin", async () => {
    const { app } = buildApp({ allowedOrigins: "https://trusted.example.com" });

    const res = await app.request("/mcp", {
      method: "OPTIONS",
      headers: {
        Origin: "https://evil.example.com",
        "Access-Control-Request-Method": "POST",
      },
    });

    expect(res.status).toBe(403);
  });
});

// ── initialize ────────────────────────────────────────────────────────────────

describe("initialize", () => {
  it("returns HTTP 200 with protocolVersion in result", async () => {
    stubJwks();
    const token = await makeToken();
    const { app } = buildApp();

    const { res } = await doInitialize(app, token);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.result.protocolVersion).toBe("2025-03-26");
  });

  it("returns Mcp-Session-Id header", async () => {
    stubJwks();
    const token = await makeToken();
    const { app } = buildApp();

    const { sessionId } = await doInitialize(app, token);

    expect(sessionId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
  });

  it("includes sessionId in result.meta", async () => {
    stubJwks();
    const token = await makeToken();
    const { app } = buildApp();

    const { sessionId, res } = await doInitialize(app, token);
    const body = await res.json();

    expect(body.result.meta.sessionId).toBe(sessionId);
  });

  it("includes serverInfo in result", async () => {
    stubJwks();
    const token = await makeToken();
    const { app } = buildApp();

    const { res } = await doInitialize(app, token);
    const body = await res.json();

    expect(body.result.serverInfo.name).toBe("graph-mcp-vault");
  });

  it("includes the current server version in result", async () => {
    stubJwks();
    const token = await makeToken();
    const { app } = buildApp();

    const { res } = await doInitialize(app, token);
    const body = await res.json();

    expect(body.result.serverInfo.version).toBe("0.0.11");
  });

  it("includes capabilities.tools in result", async () => {
    stubJwks();
    const token = await makeToken();
    const { app } = buildApp();

    const { res } = await doInitialize(app, token);
    const body = await res.json();

    expect(body.result.capabilities).toHaveProperty("tools");
  });

  it("returns INVALID_REQUEST when protocolVersion is unsupported", async () => {
    stubJwks();
    const token = await makeToken();
    const { app } = buildApp();

    const res = await post(
      app,
      "/mcp",
      {
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "1999-01-01",
          capabilities: {},
          clientInfo: { name: "test", version: "1.0" },
        },
      },
      { Authorization: `Bearer ${token}` },
    );

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe(ErrorCode.INVALID_REQUEST);
    expect(body.error.data.supported).toContain("2025-03-26");
  });

  it("uses namespace from params.meta.namespace", async () => {
    stubJwks();
    const token = await makeToken();
    const { app, sessionStore } = buildApp();

    const { sessionId } = await doInitialize(app, token, {
      metaNamespace: "my-workspace",
    });

    const session = sessionStore.get(sessionId);
    expect(session?.namespace).toBe("my-workspace");
  });

  it("uses namespace from URL path when no meta.namespace", async () => {
    stubJwks();
    const token = await makeToken();
    const { app, sessionStore } = buildApp();

    const { sessionId } = await doInitialize(app, token, {
      urlPath: "/mcp/url-ns",
    });

    const session = sessionStore.get(sessionId);
    expect(session?.namespace).toBe("url-ns");
  });

  it("falls back to DEFAULT_NAMESPACE when no meta or URL namespace", async () => {
    stubJwks();
    const token = await makeToken();
    const { app, sessionStore } = buildApp({ defaultNamespace: "fallback-ns" });

    const { sessionId } = await doInitialize(app, token);

    const session = sessionStore.get(sessionId);
    expect(session?.namespace).toBe("fallback-ns");
  });

  it("meta.namespace takes priority over URL path namespace", async () => {
    stubJwks();
    const token = await makeToken();
    const { app, sessionStore } = buildApp();

    const { sessionId } = await doInitialize(app, token, {
      metaNamespace: "meta-ns",
      urlPath: "/mcp/url-ns",
    });

    const session = sessionStore.get(sessionId);
    expect(session?.namespace).toBe("meta-ns");
  });
});

// ── Session validation ────────────────────────────────────────────────────────

describe("session validation", () => {
  it("returns HTTP 400 INVALID_REQUEST when Mcp-Session-Id header is absent", async () => {
    stubJwks();
    const token = await makeToken();
    const { app } = buildApp();

    const res = await post(
      app,
      "/mcp",
      { jsonrpc: "2.0", id: 2, method: "tools/list" },
      { Authorization: `Bearer ${token}` },
    );

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe(ErrorCode.INVALID_REQUEST);
  });

  it("returns HTTP 404 SESSION_NOT_FOUND for an unknown session id", async () => {
    stubJwks();
    const token = await makeToken();
    const { app } = buildApp();

    const res = await post(
      app,
      "/mcp",
      { jsonrpc: "2.0", id: 2, method: "tools/list" },
      {
        Authorization: `Bearer ${token}`,
        "Mcp-Session-Id": "00000000-0000-0000-0000-000000000000",
      },
    );

    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error.code).toBe(ErrorCode.SESSION_NOT_FOUND);
  });

  it("returns HTTP 404 SESSION_NOT_FOUND when the session belongs to a different user", async () => {
    stubJwks();
    const ownerToken = await makeToken("owner-user");
    const otherUserToken = await makeToken("other-user");
    const { app } = buildApp();

    const { sessionId } = await doInitialize(app, ownerToken);

    const res = await post(
      app,
      "/mcp",
      { jsonrpc: "2.0", id: 2, method: "tools/list" },
      {
        Authorization: `Bearer ${otherUserToken}`,
        "Mcp-Session-Id": sessionId,
      },
    );

    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error.code).toBe(ErrorCode.SESSION_NOT_FOUND);
  });

  it("returns HTTP 404 SESSION_NOT_FOUND for an expired session", async () => {
    stubJwks();
    const token = await makeToken();
    const sessionStore = new SessionStore(1); // 1 ms TTL
    const jwksClient = new JwksClient(JWKS_URI, 3_600_000);
    const app = new Hono();
    app.route(
      "/",
      createMcpRouter(
        BASE_CONFIG,
        sessionStore,
        jwksClient,
        [],
        makeStubNeo4j(),
        "",
      ),
    );

    const { sessionId } = await doInitialize(app, token);
    await new Promise((r) => setTimeout(r, 20));

    const res = await post(
      app,
      "/mcp",
      { jsonrpc: "2.0", id: 2, method: "tools/list" },
      { Authorization: `Bearer ${token}`, "Mcp-Session-Id": sessionId },
    );

    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error.code).toBe(ErrorCode.SESSION_NOT_FOUND);
  });
});

// ── tools/list ────────────────────────────────────────────────────────────────

describe("tools/list", () => {
  it("returns HTTP 200 with an array of tools", async () => {
    stubJwks();
    const token = await makeToken();
    const { app } = buildApp();

    const { sessionId } = await doInitialize(app, token);

    const res = await post(
      app,
      "/mcp",
      { jsonrpc: "2.0", id: 2, method: "tools/list" },
      { Authorization: `Bearer ${token}`, "Mcp-Session-Id": sessionId },
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body.result.tools)).toBe(true);
  });

  it("includes relation and namespace knowledge tools in the tool list", async () => {
    stubJwks();
    const token = await makeToken();

    // Use a stub Neo4jClient — handlers are closures and won't be called for tools/list
    const tools = createResourceTools({} as Neo4jClient, 10);
    const config = { ...BASE_CONFIG };
    const sessionStore = new SessionStore();
    const jwksClient = new JwksClient(JWKS_URI, config.jwksCacheTtl * 1000);
    const app = new Hono();
    app.route(
      "/",
      createMcpRouter(
        config,
        sessionStore,
        jwksClient,
        tools,
        makeStubNeo4j(),
        "",
      ),
    );

    const { sessionId } = await doInitialize(app, token);

    const res = await post(
      app,
      "/mcp",
      { jsonrpc: "2.0", id: 2, method: "tools/list" },
      { Authorization: `Bearer ${token}`, "Mcp-Session-Id": sessionId },
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    const toolNames = (body.result.tools as Array<{ name: string }>).map(
      (t) => t.name,
    );
    expect(toolNames).toContain("knowledge_create_relation");
    expect(toolNames).toContain("knowledge_delete_relation");
    expect(toolNames).toContain("knowledge_list_relations");
    expect(toolNames).toContain("knowledge_list_namespaces");
  });
});

// ── Notifications ─────────────────────────────────────────────────────────────

describe("notifications", () => {
  it("returns HTTP 202 empty body for a standalone notification (no id)", async () => {
    stubJwks();
    const token = await makeToken();
    const { app } = buildApp();

    const res = await post(
      app,
      "/mcp",
      { jsonrpc: "2.0", method: "notifications/initialized" },
      { Authorization: `Bearer ${token}` },
    );

    expect(res.status).toBe(202);
    const text = await res.text();
    expect(text).toBe("");
  });

  it("returns HTTP 202 for notifications/initialized with a valid session", async () => {
    stubJwks();
    const token = await makeToken();
    const { app } = buildApp();

    const { sessionId } = await doInitialize(app, token);

    const res = await post(
      app,
      "/mcp",
      { jsonrpc: "2.0", method: "notifications/initialized" },
      { Authorization: `Bearer ${token}`, "Mcp-Session-Id": sessionId },
    );

    expect(res.status).toBe(202);
  });
});

// ── Unknown method ────────────────────────────────────────────────────────────

describe("unknown method", () => {
  it("returns HTTP 200 with METHOD_NOT_FOUND error in body", async () => {
    stubJwks();
    const token = await makeToken();
    const { app } = buildApp();

    const { sessionId } = await doInitialize(app, token);

    const res = await post(
      app,
      "/mcp",
      { jsonrpc: "2.0", id: 3, method: "bogus/method" },
      { Authorization: `Bearer ${token}`, "Mcp-Session-Id": sessionId },
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.error.code).toBe(ErrorCode.METHOD_NOT_FOUND);
  });
});

// ── Happy path ────────────────────────────────────────────────────────────────

describe("happy path", () => {
  it("initialize → notifications/initialized → tools/list all succeed", async () => {
    stubJwks();
    const token = await makeToken();
    const { app } = buildApp();

    // Step 1: initialize
    const { sessionId, res: initRes } = await doInitialize(app, token);
    expect(initRes.status).toBe(200);

    // Step 2: notifications/initialized
    const notifRes = await post(
      app,
      "/mcp",
      { jsonrpc: "2.0", method: "notifications/initialized" },
      { Authorization: `Bearer ${token}`, "Mcp-Session-Id": sessionId },
    );
    expect(notifRes.status).toBe(202);

    // Step 3: tools/list
    const listRes = await post(
      app,
      "/mcp",
      { jsonrpc: "2.0", id: 2, method: "tools/list" },
      { Authorization: `Bearer ${token}`, "Mcp-Session-Id": sessionId },
    );
    expect(listRes.status).toBe(200);
    const listBody = await listRes.json();
    expect(Array.isArray(listBody.result.tools)).toBe(true);
  });
});

// ── Batch ─────────────────────────────────────────────────────────────────────

describe("batch requests", () => {
  it("batch of 2 requests returns a JSON array with 2 results", async () => {
    stubJwks();
    const token = await makeToken();
    const { app } = buildApp();

    const { sessionId } = await doInitialize(app, token);

    const res = await post(
      app,
      "/mcp",
      [
        { jsonrpc: "2.0", id: 10, method: "tools/list" },
        { jsonrpc: "2.0", id: 11, method: "tools/list" },
      ],
      { Authorization: `Bearer ${token}`, "Mcp-Session-Id": sessionId },
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body)).toBe(true);
    expect(body).toHaveLength(2);
  });

  it("batch of 1 request + 1 notification returns array with 1 result", async () => {
    stubJwks();
    const token = await makeToken();
    const { app } = buildApp();

    const { sessionId } = await doInitialize(app, token);

    const res = await post(
      app,
      "/mcp",
      [
        { jsonrpc: "2.0", id: 20, method: "tools/list" },
        { jsonrpc: "2.0", method: "notifications/initialized" },
      ],
      { Authorization: `Bearer ${token}`, "Mcp-Session-Id": sessionId },
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body)).toBe(true);
    expect(body).toHaveLength(1);
  });

  it("batch of notifications only returns HTTP 202 empty", async () => {
    stubJwks();
    const token = await makeToken();
    const { app } = buildApp();

    const res = await post(
      app,
      "/mcp",
      [
        { jsonrpc: "2.0", method: "notifications/initialized" },
        { jsonrpc: "2.0", method: "notifications/progress" },
      ],
      { Authorization: `Bearer ${token}` },
    );

    expect(res.status).toBe(202);
    const text = await res.text();
    expect(text).toBe("");
  });

  it("each response id matches the corresponding request id", async () => {
    stubJwks();
    const token = await makeToken();
    const { app } = buildApp();

    const { sessionId } = await doInitialize(app, token);

    const res = await post(
      app,
      "/mcp",
      [
        { jsonrpc: "2.0", id: 42, method: "tools/list" },
        { jsonrpc: "2.0", id: "abc", method: "tools/list" },
      ],
      { Authorization: `Bearer ${token}`, "Mcp-Session-Id": sessionId },
    );

    const body = (await res.json()) as Array<{ id: unknown }>;
    const ids = body.map((r) => r.id);
    expect(ids).toContain(42);
    expect(ids).toContain("abc");
  });

  it("invalid JSON-RPC item in batch gets INVALID_REQUEST error; other items succeed", async () => {
    stubJwks();
    const token = await makeToken();
    const { app } = buildApp();

    const { sessionId } = await doInitialize(app, token);

    const res = await post(
      app,
      "/mcp",
      [
        { jsonrpc: "2.0", id: 50, method: "tools/list" },
        "not-an-object",
        { jsonrpc: "2.0", id: 51, method: "tools/list" },
      ],
      { Authorization: `Bearer ${token}`, "Mcp-Session-Id": sessionId },
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as Array<{
      id: unknown;
      result?: unknown;
      error?: { code: number };
    }>;
    expect(body).toHaveLength(3);

    const invalid = body.find((r) => r.id === null);
    expect(invalid?.error?.code).toBe(ErrorCode.INVALID_REQUEST);

    const valid50 = body.find((r) => r.id === 50);
    expect(valid50).toHaveProperty("result");

    const valid51 = body.find((r) => r.id === 51);
    expect(valid51).toHaveProperty("result");
  });

  it("batch with initialize returns Mcp-Session-Id header", async () => {
    stubJwks();
    const token = await makeToken();
    const { app } = buildApp();

    const res = await post(
      app,
      "/mcp",
      [
        {
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: {
            protocolVersion: "2025-03-26",
            capabilities: {},
            clientInfo: { name: "test", version: "1.0" },
          },
        },
      ],
      { Authorization: `Bearer ${token}` },
    );

    expect(res.status).toBe(200);
    expect(res.headers.get("mcp-session-id")).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
  });

  it("batch session errors return HTTP 200 (not 400/404) with error entries", async () => {
    stubJwks();
    const token = await makeToken();
    const { app } = buildApp();

    // Two requests with missing session header — each should get INVALID_REQUEST,
    // but the batch HTTP status must be 200, not 400.
    const res = await post(
      app,
      "/mcp",
      [
        { jsonrpc: "2.0", id: 60, method: "tools/list" },
        { jsonrpc: "2.0", id: 61, method: "tools/list" },
      ],
      { Authorization: `Bearer ${token}` }, // no Mcp-Session-Id
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as Array<{ error?: { code: number } }>;
    expect(body).toHaveLength(2);
    expect(body.every((r) => r.error?.code === ErrorCode.INVALID_REQUEST)).toBe(
      true,
    );
  });

  it("batch with unknown session id returns HTTP 200 with SESSION_NOT_FOUND per entry", async () => {
    stubJwks();
    const token = await makeToken();
    const { app } = buildApp();

    const res = await post(
      app,
      "/mcp",
      [
        { jsonrpc: "2.0", id: 70, method: "tools/list" },
        { jsonrpc: "2.0", id: 71, method: "tools/list" },
      ],
      {
        Authorization: `Bearer ${token}`,
        "Mcp-Session-Id": "00000000-0000-0000-0000-000000000000",
      },
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as Array<{ error?: { code: number } }>;
    expect(body).toHaveLength(2);
    expect(
      body.every((r) => r.error?.code === ErrorCode.SESSION_NOT_FOUND),
    ).toBe(true);
  });

  it("empty batch array returns HTTP 202 empty", async () => {
    stubJwks();
    const token = await makeToken();
    const { app } = buildApp();

    const res = await post(app, "/mcp", [], {
      Authorization: `Bearer ${token}`,
    });

    expect(res.status).toBe(202);
    const text = await res.text();
    expect(text).toBe("");
  });
});

// ── User profile upsert on initialize ─────────────────────────────────────────

describe("user profile upsert on initialize", () => {
  it("calls upsertUserProfile once per initialize with userId", async () => {
    stubJwks();
    const token = await makeToken("profile-user");
    const stub = makeStubNeo4j();
    const { app } = buildApp({}, stub);

    await doInitialize(app, token);

    expect(stub.upsertUserProfileSpy).toHaveBeenCalledTimes(1);
    expect(stub.upsertUserProfileSpy).toHaveBeenCalledWith(
      "profile-user",
      null,
      null,
    );
  });

  it("passes name and email from JWT claims to upsertUserProfile", async () => {
    // Build a token with name and email claims
    const nowSec = Math.floor(Date.now() / 1000);
    const tokenWithProfile = await new SignJWT({
      sub: "user-with-profile",
      name: "Alice Smith",
      email: "alice@example.com",
    })
      .setProtectedHeader({ alg: "RS256", kid: KID })
      .setIssuer(ISSUER)
      .setAudience(AUDIENCE)
      .setIssuedAt()
      .setExpirationTime(nowSec + 3600)
      .sign(privateKey);

    stubJwks();
    const stub = makeStubNeo4j();
    const { app } = buildApp({}, stub);

    await doInitialize(app, tokenWithProfile);

    expect(stub.upsertUserProfileSpy).toHaveBeenCalledWith(
      "user-with-profile",
      "Alice Smith",
      "alice@example.com",
    );
  });

  it("passes null for claims absent from the JWT", async () => {
    stubJwks();
    const token = await makeToken("no-profile-user");
    const stub = makeStubNeo4j();
    const { app } = buildApp({}, stub);

    await doInitialize(app, token);

    expect(stub.upsertUserProfileSpy).toHaveBeenCalledWith(
      "no-profile-user",
      null,
      null,
    );
  });

  it("does not call upsertUserProfile for non-initialize methods", async () => {
    stubJwks();
    const token = await makeToken();
    const stub = makeStubNeo4j();
    const { app } = buildApp({}, stub);

    const { sessionId } = await doInitialize(app, token);
    stub.upsertUserProfileSpy.mockClear();

    await post(
      app,
      "/mcp",
      { jsonrpc: "2.0", id: 2, method: "tools/list" },
      { Authorization: `Bearer ${token}`, "Mcp-Session-Id": sessionId },
    );

    expect(stub.upsertUserProfileSpy).not.toHaveBeenCalled();
  });
});

// ── parseQueryFlag / ?readonly / ?lock_namespace ──────────────────────────────

// Helper: build an app with one read tool and one write tool for testing
// session-level enforcement without needing a real Neo4j connection.
function buildAppWithStubTools() {
  const config = { ...BASE_CONFIG };
  const sessionStore = new SessionStore();
  const jwksClient = new JwksClient(JWKS_URI, config.jwksCacheTtl * 1000);
  const readTool = {
    descriptor: {
      name: "knowledge_list_entries",
      description: "list",
      inputSchema: {
        type: "object" as const,
        properties: { namespace: { type: "string" } },
      },
    },
    handler: vi.fn().mockResolvedValue({ resources: [] }),
  };
  const searchTool = {
    descriptor: {
      name: "knowledge_search_entries",
      description: "search",
      inputSchema: {
        type: "object" as const,
        properties: { query: { type: "string" }, namespace: { type: "string" } },
        required: ["query"],
      },
    },
    handler: vi.fn().mockResolvedValue({ resources: [] }),
  };
  const writeTool = {
    descriptor: {
      name: "knowledge_create_entry",
      description: "create",
      inputSchema: {
        type: "object" as const,
        properties: { namespace: { type: "string" }, title: { type: "string" } },
      },
    },
    handler: vi.fn().mockResolvedValue({ id: "new-id" }),
  };
  const app = new Hono();
  app.route(
    "/",
    createMcpRouter(
      config,
      sessionStore,
      jwksClient,
      [readTool, searchTool, writeTool],
      makeStubNeo4j(),
      "",
    ),
  );
  return { app, sessionStore, readTool, searchTool, writeTool };
}

async function callTool(
  app: Hono,
  token: string,
  sessionId: string,
  toolName: string,
  args: Record<string, unknown> = {},
  urlPath = "/mcp",
) {
  return post(
    app,
    urlPath,
    {
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: { name: toolName, arguments: args },
    },
    { Authorization: `Bearer ${token}`, "Mcp-Session-Id": sessionId },
  );
}

describe("?readonly query flag", () => {
  it("blocks write tools with PERMISSION_DENIED when ?readonly is set", async () => {
    stubJwks();
    const token = await makeToken();
    const { app, writeTool } = buildAppWithStubTools();

    const { sessionId } = await doInitialize(app, token, {
      urlPath: "/mcp/default?readonly",
    });
    const res = await callTool(app, token, sessionId, "knowledge_create_entry");

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.error.code).toBe(ErrorCode.PERMISSION_DENIED);
    expect(writeTool.handler).not.toHaveBeenCalled();
  });

  it("allows read tools when ?readonly is set", async () => {
    stubJwks();
    const token = await makeToken();
    const { app, readTool } = buildAppWithStubTools();

    const { sessionId } = await doInitialize(app, token, {
      urlPath: "/mcp/default?readonly",
    });
    const res = await callTool(app, token, sessionId, "knowledge_list_entries");

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.result.isError).toBe(false);
    expect(readTool.handler).toHaveBeenCalled();
  });

  it("does NOT activate readonly when ?readonly=false", async () => {
    stubJwks();
    const token = await makeToken();
    const { app, writeTool } = buildAppWithStubTools();

    const { sessionId } = await doInitialize(app, token, {
      urlPath: "/mcp/default?readonly=false",
    });
    const res = await callTool(app, token, sessionId, "knowledge_create_entry");

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.result.isError).toBe(false);
    expect(writeTool.handler).toHaveBeenCalled();
  });

  it("activates readonly when ?readonly=true", async () => {
    stubJwks();
    const token = await makeToken();
    const { app, writeTool } = buildAppWithStubTools();

    const { sessionId } = await doInitialize(app, token, {
      urlPath: "/mcp/default?readonly=true",
    });
    const res = await callTool(app, token, sessionId, "knowledge_create_entry");

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.error.code).toBe(ErrorCode.PERMISSION_DENIED);
    expect(writeTool.handler).not.toHaveBeenCalled();
  });
});

describe("?lock_namespace query flag", () => {
  it("blocks tool calls with a different namespace arg", async () => {
    stubJwks();
    const token = await makeToken();
    const { app } = buildAppWithStubTools();

    const { sessionId } = await doInitialize(app, token, {
      urlPath: "/mcp/homelab?lock_namespace",
    });
    const res = await callTool(app, token, sessionId, "knowledge_list_entries", {
      namespace: "other",
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.error.code).toBe(ErrorCode.PERMISSION_DENIED);
  });

  it("allows tool calls that omit namespace (injects session namespace)", async () => {
    stubJwks();
    const token = await makeToken();
    const { app, readTool } = buildAppWithStubTools();

    const { sessionId } = await doInitialize(app, token, {
      urlPath: "/mcp/homelab?lock_namespace",
    });
    const res = await callTool(app, token, sessionId, "knowledge_list_entries");

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.result.isError).toBe(false);
    // knowledge_list_entries is not in NAMESPACE_INJECT_TOOLS; args pass through unchanged
    expect(readTool.handler).toHaveBeenCalledWith(
      expect.not.objectContaining({ namespace: expect.anything() }),
      expect.anything(),
    );
  });

  it("allows tool calls that explicitly pass the locked namespace", async () => {
    stubJwks();
    const token = await makeToken();
    const { app, readTool } = buildAppWithStubTools();

    const { sessionId } = await doInitialize(app, token, {
      urlPath: "/mcp/homelab?lock_namespace",
    });
    const res = await callTool(app, token, sessionId, "knowledge_list_entries", {
      namespace: "homelab",
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.result.isError).toBe(false);
    expect(readTool.handler).toHaveBeenCalled();
  });

  it("does NOT activate lock when ?lock_namespace=false", async () => {
    stubJwks();
    const token = await makeToken();
    const { app, readTool } = buildAppWithStubTools();

    const { sessionId } = await doInitialize(app, token, {
      urlPath: "/mcp/homelab?lock_namespace=false",
    });
    const res = await callTool(app, token, sessionId, "knowledge_list_entries", {
      namespace: "other",
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.result.isError).toBe(false);
    expect(readTool.handler).toHaveBeenCalledWith(
      expect.objectContaining({ namespace: "other" }),
      expect.anything(),
    );
  });

  it("injects session namespace into knowledge_search_entries when omitted (NAMESPACE_INJECT_TOOLS)", async () => {
    stubJwks();
    const token = await makeToken();
    const { app, searchTool } = buildAppWithStubTools();

    const { sessionId } = await doInitialize(app, token, {
      urlPath: "/mcp/homelab?lock_namespace",
    });
    const res = await callTool(
      app,
      token,
      sessionId,
      "knowledge_search_entries",
      { query: "test" },
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.result.isError).toBe(false);
    expect(searchTool.handler).toHaveBeenCalledWith(
      expect.objectContaining({ namespace: "homelab", query: "test" }),
      expect.anything(),
    );
  });
});

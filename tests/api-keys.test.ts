import { randomUUID } from "node:crypto";
import { Hono } from "hono";
import { SignJWT, exportJWK, generateKeyPair } from "jose";
import type { KeyLike } from "jose";
import neo4j, { type Driver } from "neo4j-driver";
import {
  GenericContainer,
  type StartedTestContainer,
  Wait,
} from "testcontainers";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { JwksClient, generateApiKey } from "../src/auth.js";
import type { Config } from "../src/config.js";
import { ErrorCode } from "../src/errors.js";
import { Neo4jClient } from "../src/neo4j-client.js";
import { createMcpRouter } from "../src/routers/mcp.js";
import { initSchema } from "../src/schema.js";
import { SessionStore } from "../src/session.js";
import { createApiKeyTools } from "../src/tools/api-keys.js";

// ── Fixtures ──────────────────────────────────────────────────────────────────

const ISSUER = "https://oidc.example.com";
const AUDIENCE = "graph-mcp-vault";
const KID = "api-keys-test-key";
const JWKS_URI = `${ISSUER}/.well-known/jwks.json`;
const NEO4J_PASSWORD = "testpassword";

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
  neo4jPassword: NEO4J_PASSWORD,
  host: "0.0.0.0",
  port: 8000,
  defaultNamespace: "default",
  logLevel: "info",
  allowedOrigins: "",
  oidcDiscoveryUrl: undefined,
  publicUrl: "http://localhost:8000",
  scopesAllowlist: undefined,
  maxVersionsLimit: 10,
  apiKeysEnabled: true,
  apiKeysMaxPerUser: 20,
};

let container: StartedTestContainer;
let driver: Driver;
let neo4jClient: Neo4jClient;
let privateKey: KeyLike;
let userCounter = 0;

beforeAll(async () => {
  container = await new GenericContainer("neo4j:5-community")
    .withEnvironment({ NEO4J_AUTH: `neo4j/${NEO4J_PASSWORD}` })
    .withExposedPorts(7687)
    .withWaitStrategy(Wait.forLogMessage("Bolt enabled on"))
    .start();

  const boltPort = container.getMappedPort(7687);
  driver = neo4j.driver(
    `bolt://localhost:${boltPort}`,
    neo4j.auth.basic("neo4j", NEO4J_PASSWORD),
  );
  await initSchema(driver);
  neo4jClient = new Neo4jClient(driver);

  const pair = await generateKeyPair("RS256");
  privateKey = pair.privateKey;
  const jwk = await exportJWK(pair.publicKey);
  const jwksDoc = { keys: [{ ...jwk, kid: KID, use: "sig" }] };

  vi.stubGlobal(
    "fetch",
    vi
      .fn()
      .mockResolvedValue({ ok: true, status: 200, json: async () => jwksDoc }),
  );
}, 120_000);

afterAll(async () => {
  vi.unstubAllGlobals();
  await driver?.close();
  await container?.stop();
});

// ── Helpers ───────────────────────────────────────────────────────────────────

function uniqueUser(): string {
  userCounter += 1;
  return `api-keys-user-${userCounter}`;
}

function buildApp(configOverride: Partial<Config> = {}): Hono {
  const config = { ...BASE_CONFIG, ...configOverride };
  const sessionStore = new SessionStore();
  const jwksClient = new JwksClient(JWKS_URI, config.jwksCacheTtl * 1000);
  const tools = config.apiKeysEnabled
    ? createApiKeyTools(neo4jClient, config)
    : [];
  const app = new Hono();
  app.route(
    "/",
    createMcpRouter(config, sessionStore, jwksClient, tools, neo4jClient, ""),
  );
  return app;
}

async function makeToken(sub: string): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({ sub })
    .setProtectedHeader({ alg: "RS256", kid: KID })
    .setIssuer(ISSUER)
    .setAudience(AUDIENCE)
    .setIssuedAt()
    .setExpirationTime(now + 3600)
    .sign(privateKey);
}

async function openSession(
  app: Hono,
  authHeader: string,
  opts: { namespace?: string; urlPath?: string } = {},
): Promise<{
  sessionId: string;
  status: number;
  body: Record<string, unknown>;
}> {
  const path = opts.urlPath ?? "/mcp";
  const initParams: Record<string, unknown> = {
    protocolVersion: "2025-03-26",
    capabilities: {},
    clientInfo: { name: "test", version: "1.0" },
  };
  if (opts.namespace !== undefined) {
    initParams.meta = { namespace: opts.namespace };
  }
  const res = await app.request(path, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: authHeader },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 0,
      method: "initialize",
      params: initParams,
    }),
  });
  const body = (await res.json()) as Record<string, unknown>;
  const sessionId = res.headers.get("mcp-session-id") ?? "";
  return { sessionId, status: res.status, body };
}

async function callTool(
  app: Hono,
  authHeader: string,
  sessionId: string,
  toolName: string,
  args: Record<string, unknown>,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await app.request("/mcp", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: authHeader,
      "Mcp-Session-Id": sessionId,
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: toolName, arguments: args },
    }),
  });
  const body = (await res.json()) as Record<string, unknown>;
  return { status: res.status, body };
}

function toolResult(body: Record<string, unknown>): Record<string, unknown> {
  const result = (
    body as {
      result?: { content?: Array<{ text: string }>; isError?: boolean };
    }
  ).result;
  const text = result?.content?.[0]?.text ?? "{}";
  return JSON.parse(text) as Record<string, unknown>;
}

function isToolError(body: Record<string, unknown>): boolean {
  return (body as { result?: { isError?: boolean } }).result?.isError === true;
}

// ── tools/list includes API key tools ────────────────────────────────────────

describe("tools/list", () => {
  it("includes knowledge_create_api_key, knowledge_list_api_keys, knowledge_revoke_api_key", async () => {
    const app = buildApp();
    const sub = uniqueUser();
    const token = await makeToken(sub);
    const { sessionId } = await openSession(app, `Bearer ${token}`);

    const res = await app.request("/mcp", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
        "Mcp-Session-Id": sessionId,
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });

    const body = (await res.json()) as {
      result: { tools: Array<{ name: string }> };
    };
    const names = body.result.tools.map((t) => t.name);
    expect(names).toContain("knowledge_create_api_key");
    expect(names).toContain("knowledge_list_api_keys");
    expect(names).toContain("knowledge_revoke_api_key");
  });

  it("does not include API key tools when API_KEYS_ENABLED=false", async () => {
    const app = buildApp({ apiKeysEnabled: false });
    const sub = uniqueUser();
    const token = await makeToken(sub);
    const { sessionId } = await openSession(app, `Bearer ${token}`);

    const res = await app.request("/mcp", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
        "Mcp-Session-Id": sessionId,
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });

    const body = (await res.json()) as {
      result: { tools: Array<{ name: string }> };
    };
    const names = body.result.tools.map((t) => t.name);
    expect(names).not.toContain("knowledge_create_api_key");
    expect(names).not.toContain("knowledge_list_api_keys");
    expect(names).not.toContain("knowledge_revoke_api_key");
  });
});

// ── knowledge_create_api_key ──────────────────────────────────────────────────

describe("knowledge_create_api_key", () => {
  it("returns raw key and metadata; raw key can authenticate a session", async () => {
    const app = buildApp();
    const sub = uniqueUser();
    const token = await makeToken(sub);
    const { sessionId } = await openSession(app, `Bearer ${token}`);

    const { body } = await callTool(
      app,
      `Bearer ${token}`,
      sessionId,
      "knowledge_create_api_key",
      { name: "ci-key" },
    );

    expect(isToolError(body)).toBe(false);
    const result = toolResult(body);
    expect(typeof result.id).toBe("string");
    expect(result.name).toBe("ci-key");
    expect(typeof result.key).toBe("string");
    expect((result.key as string).startsWith("gmv_")).toBe(true);
    expect(result.key as string).toHaveLength(68);
    expect(result.key_prefix).toBe((result.key as string).slice(0, 12));
    expect(result.namespaces).toBeNull();
    expect(result.expires_at).toBeNull();

    // Raw key can authenticate a new session
    const { sessionId: apiKeySessionId, status } = await openSession(
      app,
      `Bearer ${result.key as string}`,
    );
    expect(status).toBe(200);
    expect(apiKeySessionId).toBeTruthy();
  });

  it("tool is not callable when API_KEYS_ENABLED=false", async () => {
    const app = buildApp({ apiKeysEnabled: false });
    const sub = uniqueUser();
    const token = await makeToken(sub);
    const { sessionId } = await openSession(app, `Bearer ${token}`);

    const { body } = await callTool(
      app,
      `Bearer ${token}`,
      sessionId,
      "knowledge_create_api_key",
      { name: "disabled-key" },
    );

    // Tool is not registered when disabled — router returns METHOD_NOT_FOUND
    const error = (body as { error?: { code: number } }).error;
    expect(error?.code).toBe(ErrorCode.METHOD_NOT_FOUND);
  });

  it("returns INVALID_PARAMS when user has reached API_KEYS_MAX_PER_USER active keys", async () => {
    const app = buildApp({ apiKeysMaxPerUser: 2 });
    const sub = uniqueUser();
    const token = await makeToken(sub);
    const { sessionId } = await openSession(app, `Bearer ${token}`);

    for (let i = 0; i < 2; i++) {
      await callTool(
        app,
        `Bearer ${token}`,
        sessionId,
        "knowledge_create_api_key",
        {
          name: `key-${i}`,
        },
      );
    }

    const { body } = await callTool(
      app,
      `Bearer ${token}`,
      sessionId,
      "knowledge_create_api_key",
      { name: "one-too-many" },
    );

    expect(isToolError(body)).toBe(true);
    const result = toolResult(body);
    expect(result.code).toBe(ErrorCode.INVALID_PARAMS);
    expect((result.message as string).toLowerCase()).toContain("maximum");
  });

  it("does not count expired keys toward the active-key limit", async () => {
    const app = buildApp({ apiKeysMaxPerUser: 1 });
    const sub = uniqueUser();

    // Create an already-expired key directly in Neo4j
    const { hash, prefix } = generateApiKey();
    await neo4jClient.createApiKey({
      id: randomUUID(),
      userId: sub,
      name: "already-expired",
      keyHash: hash,
      keyPrefix: prefix,
      namespaces: null,
      expiresAt: "2000-01-01T00:00:00.000Z",
    });

    // User should still be able to create one more key via the tool (limit = 1,
    // the expired key must not count)
    const token = await makeToken(sub);
    const { sessionId } = await openSession(app, `Bearer ${token}`);
    const { body } = await callTool(
      app,
      `Bearer ${token}`,
      sessionId,
      "knowledge_create_api_key",
      { name: "valid-key" },
    );
    expect(isToolError(body)).toBe(false);
    expect(toolResult(body).name).toBe("valid-key");
  });

  it("restricts session namespace when namespaces allow-list is provided", async () => {
    const app = buildApp();
    const sub = uniqueUser();
    const token = await makeToken(sub);
    const { sessionId } = await openSession(app, `Bearer ${token}`, {
      namespace: "homelab",
    });

    const { body } = await callTool(
      app,
      `Bearer ${token}`,
      sessionId,
      "knowledge_create_api_key",
      { name: "ns-key", namespaces: ["homelab"] },
    );

    expect(isToolError(body)).toBe(false);
    const result = toolResult(body);
    expect(result.namespaces).toEqual(["homelab"]);

    // Key can open session in allowed namespace
    const { status: okStatus } = await openSession(
      app,
      `Bearer ${result.key as string}`,
      { urlPath: "/mcp/homelab" },
    );
    expect(okStatus).toBe(200);

    // Key cannot open session in a different namespace
    const { status: denyStatus } = await openSession(
      app,
      `Bearer ${result.key as string}`,
      { urlPath: "/mcp/work" },
    );
    expect(denyStatus).toBe(401);
  });

  it("sets expires_at approximately expires_in_days from now", async () => {
    const app = buildApp();
    const sub = uniqueUser();
    const token = await makeToken(sub);
    const before = Date.now();
    const { sessionId } = await openSession(app, `Bearer ${token}`);

    const { body } = await callTool(
      app,
      `Bearer ${token}`,
      sessionId,
      "knowledge_create_api_key",
      { name: "expiring-key", expires_in_days: 1 },
    );

    expect(isToolError(body)).toBe(false);
    const result = toolResult(body);
    expect(typeof result.expires_at).toBe("string");
    const expiresMs = Date.parse(result.expires_at as string);
    const expectedMs = before + 24 * 60 * 60 * 1000;
    // Allow ±5 seconds of clock drift
    expect(expiresMs).toBeGreaterThanOrEqual(expectedMs - 5_000);
    expect(expiresMs).toBeLessThanOrEqual(expectedMs + 5_000);
  });
});

// ── knowledge_list_api_keys ───────────────────────────────────────────────────

describe("knowledge_list_api_keys", () => {
  it("returns key metadata without key or key_hash fields", async () => {
    const app = buildApp();
    const sub = uniqueUser();
    const token = await makeToken(sub);
    const { sessionId } = await openSession(app, `Bearer ${token}`);

    await callTool(
      app,
      `Bearer ${token}`,
      sessionId,
      "knowledge_create_api_key",
      {
        name: "listed-key",
      },
    );

    const { body } = await callTool(
      app,
      `Bearer ${token}`,
      sessionId,
      "knowledge_list_api_keys",
      {},
    );

    expect(isToolError(body)).toBe(false);
    const result = toolResult(body);
    expect(Array.isArray(result.api_keys)).toBe(true);
    const keys = result.api_keys as Record<string, unknown>[];
    expect(keys.length).toBeGreaterThanOrEqual(1);
    const found = keys.find((k) => k.name === "listed-key");
    expect(found).toBeDefined();
    expect("key" in (found ?? {})).toBe(false);
    expect("key_hash" in (found ?? {})).toBe(false);
    expect(typeof found?.key_prefix).toBe("string");
    expect(typeof found?.id).toBe("string");
  });

  it("shows revoked keys with revoked: true", async () => {
    const app = buildApp();
    const sub = uniqueUser();
    const token = await makeToken(sub);
    const { sessionId } = await openSession(app, `Bearer ${token}`);

    const { body: createBody } = await callTool(
      app,
      `Bearer ${token}`,
      sessionId,
      "knowledge_create_api_key",
      { name: "to-be-revoked" },
    );
    const created = toolResult(createBody);

    await callTool(
      app,
      `Bearer ${token}`,
      sessionId,
      "knowledge_revoke_api_key",
      {
        key_id: created.id as string,
      },
    );

    const { body: listBody } = await callTool(
      app,
      `Bearer ${token}`,
      sessionId,
      "knowledge_list_api_keys",
      {},
    );
    const listResult = toolResult(listBody);
    const keys = listResult.api_keys as Record<string, unknown>[];
    const revoked = keys.find((k) => k.id === created.id);
    expect(revoked).toBeDefined();
    expect(revoked?.revoked).toBe(true);
  });

  it("tool is not callable when API_KEYS_ENABLED=false", async () => {
    const app = buildApp({ apiKeysEnabled: false });
    const sub = uniqueUser();
    const token = await makeToken(sub);
    const { sessionId } = await openSession(app, `Bearer ${token}`);

    const { body } = await callTool(
      app,
      `Bearer ${token}`,
      sessionId,
      "knowledge_list_api_keys",
      {},
    );

    // Tool is not registered when disabled — router returns METHOD_NOT_FOUND
    const error = (body as { error?: { code: number } }).error;
    expect(error?.code).toBe(ErrorCode.METHOD_NOT_FOUND);
  });
});

// ── knowledge_revoke_api_key ──────────────────────────────────────────────────

describe("knowledge_revoke_api_key", () => {
  it("revokes a key so subsequent auth with it returns 401", async () => {
    const app = buildApp();
    const sub = uniqueUser();
    const token = await makeToken(sub);
    const { sessionId } = await openSession(app, `Bearer ${token}`);

    const { body: createBody } = await callTool(
      app,
      `Bearer ${token}`,
      sessionId,
      "knowledge_create_api_key",
      { name: "revoke-me" },
    );
    const created = toolResult(createBody);
    const rawKey = created.key as string;

    // Key works before revocation
    const { status: beforeStatus } = await openSession(app, `Bearer ${rawKey}`);
    expect(beforeStatus).toBe(200);

    // Revoke the key
    const { body: revokeBody } = await callTool(
      app,
      `Bearer ${token}`,
      sessionId,
      "knowledge_revoke_api_key",
      { key_id: created.id as string },
    );
    expect(isToolError(revokeBody)).toBe(false);
    expect(toolResult(revokeBody)).toEqual({ revoked: true });

    // Key no longer works
    const { status: afterStatus } = await openSession(app, `Bearer ${rawKey}`);
    expect(afterStatus).toBe(401);
  });

  it("returns RESOURCE_NOT_FOUND for a key owned by a different user", async () => {
    const app = buildApp();
    const sub1 = uniqueUser();
    const sub2 = uniqueUser();
    const token1 = await makeToken(sub1);
    const token2 = await makeToken(sub2);

    // User 1 creates a key
    const { sessionId: sid1 } = await openSession(app, `Bearer ${token1}`);
    const { body: createBody } = await callTool(
      app,
      `Bearer ${token1}`,
      sid1,
      "knowledge_create_api_key",
      { name: "owner-key" },
    );
    const created = toolResult(createBody);

    // User 2 tries to revoke user 1's key
    const { sessionId: sid2 } = await openSession(app, `Bearer ${token2}`);
    const { body: revokeBody } = await callTool(
      app,
      `Bearer ${token2}`,
      sid2,
      "knowledge_revoke_api_key",
      { key_id: created.id as string },
    );

    expect(isToolError(revokeBody)).toBe(true);
    const result = toolResult(revokeBody);
    expect(result.code).toBe(ErrorCode.RESOURCE_NOT_FOUND);
  });

  it("is idempotent: revoking an already-revoked key returns { revoked: true }", async () => {
    const app = buildApp();
    const sub = uniqueUser();
    const token = await makeToken(sub);
    const { sessionId } = await openSession(app, `Bearer ${token}`);

    const { body: createBody } = await callTool(
      app,
      `Bearer ${token}`,
      sessionId,
      "knowledge_create_api_key",
      { name: "idempotent-revoke" },
    );
    const created = toolResult(createBody);

    await callTool(
      app,
      `Bearer ${token}`,
      sessionId,
      "knowledge_revoke_api_key",
      {
        key_id: created.id as string,
      },
    );

    // Revoke again
    const { body: secondBody } = await callTool(
      app,
      `Bearer ${token}`,
      sessionId,
      "knowledge_revoke_api_key",
      { key_id: created.id as string },
    );

    expect(isToolError(secondBody)).toBe(false);
    expect(toolResult(secondBody)).toEqual({ revoked: true });
  });

  it("tool is not callable when API_KEYS_ENABLED=false", async () => {
    const app = buildApp({ apiKeysEnabled: false });
    const sub = uniqueUser();
    const token = await makeToken(sub);
    const { sessionId } = await openSession(app, `Bearer ${token}`);

    const { body } = await callTool(
      app,
      `Bearer ${token}`,
      sessionId,
      "knowledge_revoke_api_key",
      { key_id: "some-id" },
    );

    // Tool is not registered when disabled — router returns METHOD_NOT_FOUND
    const error = (body as { error?: { code: number } }).error;
    expect(error?.code).toBe(ErrorCode.METHOD_NOT_FOUND);
  });
});

// ── API key middleware ─────────────────────────────────────────────────────────

describe("API key middleware", () => {
  it("accepts a valid API key and opens a session as the correct userId", async () => {
    const app = buildApp();
    const sub = uniqueUser();
    const token = await makeToken(sub);
    const { sessionId } = await openSession(app, `Bearer ${token}`);

    const { body: createBody } = await callTool(
      app,
      `Bearer ${token}`,
      sessionId,
      "knowledge_create_api_key",
      { name: "middleware-key" },
    );
    const rawKey = toolResult(createBody).key as string;

    const { status, sessionId: apiKeySession } = await openSession(
      app,
      `Bearer ${rawKey}`,
    );
    expect(status).toBe(200);
    expect(apiKeySession).toBeTruthy();
  });

  it("returns 401 for a revoked API key", async () => {
    const app = buildApp();
    const sub = uniqueUser();
    const token = await makeToken(sub);
    const { sessionId } = await openSession(app, `Bearer ${token}`);

    const { body: createBody } = await callTool(
      app,
      `Bearer ${token}`,
      sessionId,
      "knowledge_create_api_key",
      { name: "revoked-middleware-key" },
    );
    const created = toolResult(createBody);

    await callTool(
      app,
      `Bearer ${token}`,
      sessionId,
      "knowledge_revoke_api_key",
      {
        key_id: created.id as string,
      },
    );

    const { status } = await openSession(
      app,
      `Bearer ${created.key as string}`,
    );
    expect(status).toBe(401);
  });

  it("returns 401 for an expired API key", async () => {
    const app = buildApp();
    const sub = uniqueUser();

    // Create a key directly in Neo4j with a past expiry
    const { raw, hash, prefix } = generateApiKey();
    await neo4jClient.createApiKey({
      id: randomUUID(),
      userId: sub,
      name: "expired-key",
      keyHash: hash,
      keyPrefix: prefix,
      namespaces: null,
      expiresAt: "2000-01-01T00:00:00.000Z",
    });

    const { status } = await openSession(app, `Bearer ${raw}`);
    expect(status).toBe(401);
  });

  it("returns 401 when API_KEYS_ENABLED=false and a gmv_ token is presented", async () => {
    const app = buildApp({ apiKeysEnabled: false });
    // Use a syntactically valid gmv_ token (64 hex chars after gmv_)
    const fakeKey = `gmv_${"a".repeat(64)}`;

    const { status } = await openSession(app, `Bearer ${fakeKey}`);
    expect(status).toBe(401);
  });

  it("allows a namespace-restricted key to open a session in the allowed namespace", async () => {
    const app = buildApp();
    const sub = uniqueUser();
    const token = await makeToken(sub);
    const { sessionId } = await openSession(app, `Bearer ${token}`, {
      namespace: "homelab",
    });

    const { body } = await callTool(
      app,
      `Bearer ${token}`,
      sessionId,
      "knowledge_create_api_key",
      { name: "ns-restricted", namespaces: ["homelab"] },
    );
    const rawKey = toolResult(body).key as string;

    const { status } = await openSession(app, `Bearer ${rawKey}`, {
      urlPath: "/mcp/homelab",
    });
    expect(status).toBe(200);
  });

  it("denies a namespace-restricted key from opening a session in a different namespace", async () => {
    const app = buildApp();
    const sub = uniqueUser();
    const token = await makeToken(sub);
    const { sessionId } = await openSession(app, `Bearer ${token}`, {
      namespace: "homelab",
    });

    const { body } = await callTool(
      app,
      `Bearer ${token}`,
      sessionId,
      "knowledge_create_api_key",
      { name: "ns-denied", namespaces: ["homelab"] },
    );
    const rawKey = toolResult(body).key as string;

    const { status } = await openSession(app, `Bearer ${rawKey}`, {
      urlPath: "/mcp/work",
    });
    expect(status).toBe(401);
  });

  it("locks the session namespace for namespace-restricted keys", async () => {
    const app = buildApp();
    const sub = uniqueUser();
    const token = await makeToken(sub);
    const { sessionId } = await openSession(app, `Bearer ${token}`, {
      namespace: "homelab",
    });

    // Create a namespace-restricted API key
    const { body: createBody } = await callTool(
      app,
      `Bearer ${token}`,
      sessionId,
      "knowledge_create_api_key",
      { name: "locked-ns-key", namespaces: ["homelab"] },
    );
    const rawKey = toolResult(createBody).key as string;

    // Open a session in the allowed namespace
    const { sessionId: apiKeySid, status } = await openSession(
      app,
      `Bearer ${rawKey}`,
      { urlPath: "/mcp/homelab" },
    );
    expect(status).toBe(200);

    // Tool calls that pass a different namespace argument are blocked even after
    // initialization — the session namespace is locked.
    // Pass namespace as an extra arg to knowledge_create_api_key (the router
    // enforces lockedNamespace before passing args to the handler).
    const res = await app.request("/mcp", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${rawKey}`,
        "Mcp-Session-Id": apiKeySid,
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: {
          name: "knowledge_create_api_key",
          arguments: { name: "escape-attempt", namespace: "work" },
        },
      }),
    });
    const toolBody = (await res.json()) as Record<string, unknown>;
    // The router-level lockedNamespace guard fires before the tool handler —
    // the response is a JSON-RPC error (not a tool result), so we inspect error.
    const rpcError = (toolBody as { error?: { code: number } }).error;
    expect(rpcError?.code).toBe(ErrorCode.PERMISSION_DENIED);
  });
});

// ── knowledge_create_api_key privilege escalation prevention ──────────────────

describe("knowledge_create_api_key privilege escalation prevention", () => {
  it("caps new key to caller's namespace scope when namespaces not specified", async () => {
    const app = buildApp();
    const sub = uniqueUser();
    const token = await makeToken(sub);

    // Create a namespace-restricted key via JWT
    const { sessionId: jwtSid } = await openSession(app, `Bearer ${token}`, {
      namespace: "homelab",
    });
    const { body: firstKeyBody } = await callTool(
      app,
      `Bearer ${token}`,
      jwtSid,
      "knowledge_create_api_key",
      { name: "restricted-parent", namespaces: ["homelab"] },
    );
    const parentKey = toolResult(firstKeyBody).key as string;

    // Open a session with the restricted key and try to create an unrestricted child
    const { sessionId: apiSid } = await openSession(
      app,
      `Bearer ${parentKey}`,
      { urlPath: "/mcp/homelab" },
    );
    const { body: childKeyBody } = await callTool(
      app,
      `Bearer ${parentKey}`,
      apiSid,
      "knowledge_create_api_key",
      { name: "child-key" }, // no namespaces → would be unrestricted without the fix
    );
    expect(isToolError(childKeyBody)).toBe(false);
    const childKey = toolResult(childKeyBody);
    // Child key inherits parent's scope — not unrestricted
    expect(childKey.namespaces).toEqual(["homelab"]);
  });

  it("returns INVALID_PARAMS when namespaces exceed caller's allowed scope", async () => {
    const app = buildApp();
    const sub = uniqueUser();
    const token = await makeToken(sub);

    // Create a restricted parent key
    const { sessionId: jwtSid } = await openSession(app, `Bearer ${token}`, {
      namespace: "homelab",
    });
    const { body: parentKeyBody } = await callTool(
      app,
      `Bearer ${token}`,
      jwtSid,
      "knowledge_create_api_key",
      { name: "scope-parent", namespaces: ["homelab"] },
    );
    const parentKey = toolResult(parentKeyBody).key as string;

    // Try to create a child key with a namespace outside the parent's scope
    const { sessionId: apiSid } = await openSession(
      app,
      `Bearer ${parentKey}`,
      { urlPath: "/mcp/homelab" },
    );
    const { body: childKeyBody } = await callTool(
      app,
      `Bearer ${parentKey}`,
      apiSid,
      "knowledge_create_api_key",
      { name: "escalation-attempt", namespaces: ["homelab", "work"] },
    );
    expect(isToolError(childKeyBody)).toBe(true);
    const result = toolResult(childKeyBody);
    expect(result.code).toBe(ErrorCode.INVALID_PARAMS);
    expect((result.message as string).toLowerCase()).toContain("scope");
  });

  it("allows a JWT caller to create a key with any namespaces", async () => {
    const app = buildApp();
    const sub = uniqueUser();
    const token = await makeToken(sub);

    const { sessionId } = await openSession(app, `Bearer ${token}`);
    const { body } = await callTool(
      app,
      `Bearer ${token}`,
      sessionId,
      "knowledge_create_api_key",
      { name: "unrestricted-jwt-key" }, // no namespaces restriction
    );
    expect(isToolError(body)).toBe(false);
    expect(toolResult(body).namespaces).toBeNull();
  });

  it("rejects invalid namespace format in namespaces list", async () => {
    const app = buildApp();
    const sub = uniqueUser();
    const token = await makeToken(sub);

    const { sessionId } = await openSession(app, `Bearer ${token}`);
    const { body } = await callTool(
      app,
      `Bearer ${token}`,
      sessionId,
      "knowledge_create_api_key",
      { name: "bad-ns-key", namespaces: ["UPPER_CASE", "invalid ns!"] },
    );
    expect(isToolError(body)).toBe(true);
    expect(toolResult(body).code).toBe(ErrorCode.INVALID_PARAMS);
  });
});

// ── Namespace-restricted key list/revoke scope enforcement ────────────────────

describe("namespace-restricted API key list and revoke scope enforcement", () => {
  it("cannot list unrestricted same-user keys via a namespace-restricted API key", async () => {
    const app = buildApp();
    const sub = uniqueUser();
    const token = await makeToken(sub);
    const { sessionId: jwtSid } = await openSession(app, `Bearer ${token}`);

    // Create an unrestricted key (via JWT)
    const { body: unrestrictedBody } = await callTool(
      app,
      `Bearer ${token}`,
      jwtSid,
      "knowledge_create_api_key",
      { name: "unrestricted-key" },
    );
    const unrestrictedId = toolResult(unrestrictedBody).id as string;

    // Create a namespace-restricted key
    const { sessionId: jwtSid2 } = await openSession(app, `Bearer ${token}`, {
      namespace: "homelab",
    });
    const { body: restrictedBody } = await callTool(
      app,
      `Bearer ${token}`,
      jwtSid2,
      "knowledge_create_api_key",
      { name: "homelab-key", namespaces: ["homelab"] },
    );
    const restrictedKey = toolResult(restrictedBody).key as string;

    // List via restricted key — unrestricted key must not appear
    const { sessionId: apiSid } = await openSession(
      app,
      `Bearer ${restrictedKey}`,
      { urlPath: "/mcp/homelab" },
    );
    const { body: listBody } = await callTool(
      app,
      `Bearer ${restrictedKey}`,
      apiSid,
      "knowledge_list_api_keys",
      {},
    );
    expect(isToolError(listBody)).toBe(false);
    const keys = toolResult(listBody).api_keys as Record<string, unknown>[];
    expect(keys.find((k) => k.id === unrestrictedId)).toBeUndefined();
  });

  it("cannot list keys for other namespaces via a namespace-restricted API key", async () => {
    const app = buildApp();
    const sub = uniqueUser();
    const token = await makeToken(sub);
    const { sessionId: jwtSid } = await openSession(app, `Bearer ${token}`, {
      namespace: "work",
    });

    // Create a key for "work" namespace
    const { body: workKeyBody } = await callTool(
      app,
      `Bearer ${token}`,
      jwtSid,
      "knowledge_create_api_key",
      { name: "work-key", namespaces: ["work"] },
    );
    const workKeyId = toolResult(workKeyBody).id as string;

    // Create a key for "homelab" namespace and use it to list
    const { sessionId: jwtSid2 } = await openSession(app, `Bearer ${token}`, {
      namespace: "homelab",
    });
    const { body: homelabKeyBody } = await callTool(
      app,
      `Bearer ${token}`,
      jwtSid2,
      "knowledge_create_api_key",
      { name: "homelab-list-key", namespaces: ["homelab"] },
    );
    const homelabKey = toolResult(homelabKeyBody).key as string;

    const { sessionId: apiSid } = await openSession(
      app,
      `Bearer ${homelabKey}`,
      { urlPath: "/mcp/homelab" },
    );
    const { body: listBody } = await callTool(
      app,
      `Bearer ${homelabKey}`,
      apiSid,
      "knowledge_list_api_keys",
      {},
    );
    expect(isToolError(listBody)).toBe(false);
    const keys = toolResult(listBody).api_keys as Record<string, unknown>[];
    // "work" key is outside homelab scope — must not appear
    expect(keys.find((k) => k.id === workKeyId)).toBeUndefined();
  });

  it("can list own in-scope keys via a namespace-restricted API key", async () => {
    const app = buildApp();
    const sub = uniqueUser();
    const token = await makeToken(sub);
    const { sessionId: jwtSid } = await openSession(app, `Bearer ${token}`, {
      namespace: "homelab",
    });

    // Create a homelab-scoped parent key
    const { body: parentBody } = await callTool(
      app,
      `Bearer ${token}`,
      jwtSid,
      "knowledge_create_api_key",
      { name: "parent-homelab", namespaces: ["homelab"] },
    );
    const parentKey = toolResult(parentBody).key as string;
    const parentId = toolResult(parentBody).id as string;

    // Use parent key to create a child homelab key
    const { sessionId: apiSid } = await openSession(
      app,
      `Bearer ${parentKey}`,
      { urlPath: "/mcp/homelab" },
    );
    const { body: childBody } = await callTool(
      app,
      `Bearer ${parentKey}`,
      apiSid,
      "knowledge_create_api_key",
      { name: "child-homelab" },
    );
    const childId = toolResult(childBody).id as string;

    // List via the parent key — child key should be visible, parent key too
    const { body: listBody } = await callTool(
      app,
      `Bearer ${parentKey}`,
      apiSid,
      "knowledge_list_api_keys",
      {},
    );
    expect(isToolError(listBody)).toBe(false);
    const keys = toolResult(listBody).api_keys as Record<string, unknown>[];
    expect(keys.find((k) => k.id === childId)).toBeDefined();
    expect(keys.find((k) => k.id === parentId)).toBeDefined();
  });

  it("cannot revoke an unrestricted same-user key via a namespace-restricted API key", async () => {
    const app = buildApp();
    const sub = uniqueUser();
    const token = await makeToken(sub);
    const { sessionId: jwtSid } = await openSession(app, `Bearer ${token}`);

    // Create unrestricted key via JWT
    const { body: unrestrictedBody } = await callTool(
      app,
      `Bearer ${token}`,
      jwtSid,
      "knowledge_create_api_key",
      { name: "unrestricted-to-protect" },
    );
    const unrestrictedId = toolResult(unrestrictedBody).id as string;

    // Create homelab-restricted key
    const { sessionId: jwtSid2 } = await openSession(app, `Bearer ${token}`, {
      namespace: "homelab",
    });
    const { body: restrictedBody } = await callTool(
      app,
      `Bearer ${token}`,
      jwtSid2,
      "knowledge_create_api_key",
      { name: "attacker-key", namespaces: ["homelab"] },
    );
    const attackerKey = toolResult(restrictedBody).key as string;

    // Attempt to revoke the unrestricted key using the restricted key
    const { sessionId: apiSid } = await openSession(
      app,
      `Bearer ${attackerKey}`,
      { urlPath: "/mcp/homelab" },
    );
    const { body: revokeBody } = await callTool(
      app,
      `Bearer ${attackerKey}`,
      apiSid,
      "knowledge_revoke_api_key",
      { key_id: unrestrictedId },
    );
    expect(isToolError(revokeBody)).toBe(true);
    expect(toolResult(revokeBody).code).toBe(ErrorCode.PERMISSION_DENIED);
  });

  it("cannot revoke a key for a different namespace via a namespace-restricted API key", async () => {
    const app = buildApp();
    const sub = uniqueUser();
    const token = await makeToken(sub);

    // Create work-scoped key via JWT
    const { sessionId: jwtSid1 } = await openSession(app, `Bearer ${token}`, {
      namespace: "work",
    });
    const { body: workKeyBody } = await callTool(
      app,
      `Bearer ${token}`,
      jwtSid1,
      "knowledge_create_api_key",
      { name: "work-key-to-protect", namespaces: ["work"] },
    );
    const workKeyId = toolResult(workKeyBody).id as string;

    // Create homelab-scoped key
    const { sessionId: jwtSid2 } = await openSession(app, `Bearer ${token}`, {
      namespace: "homelab",
    });
    const { body: homelabBody } = await callTool(
      app,
      `Bearer ${token}`,
      jwtSid2,
      "knowledge_create_api_key",
      { name: "homelab-attacker", namespaces: ["homelab"] },
    );
    const homelabKey = toolResult(homelabBody).key as string;

    // Attempt to revoke the work key using the homelab key
    const { sessionId: apiSid } = await openSession(
      app,
      `Bearer ${homelabKey}`,
      { urlPath: "/mcp/homelab" },
    );
    const { body: revokeBody } = await callTool(
      app,
      `Bearer ${homelabKey}`,
      apiSid,
      "knowledge_revoke_api_key",
      { key_id: workKeyId },
    );
    expect(isToolError(revokeBody)).toBe(true);
    expect(toolResult(revokeBody).code).toBe(ErrorCode.PERMISSION_DENIED);
  });

  it("can revoke an in-scope child key via a namespace-restricted API key", async () => {
    const app = buildApp();
    const sub = uniqueUser();
    const token = await makeToken(sub);
    const { sessionId: jwtSid } = await openSession(app, `Bearer ${token}`, {
      namespace: "homelab",
    });

    // Create parent homelab key via JWT
    const { body: parentBody } = await callTool(
      app,
      `Bearer ${token}`,
      jwtSid,
      "knowledge_create_api_key",
      { name: "parent-for-revoke", namespaces: ["homelab"] },
    );
    const parentKey = toolResult(parentBody).key as string;

    // Use parent to create child
    const { sessionId: apiSid } = await openSession(
      app,
      `Bearer ${parentKey}`,
      { urlPath: "/mcp/homelab" },
    );
    const { body: childBody } = await callTool(
      app,
      `Bearer ${parentKey}`,
      apiSid,
      "knowledge_create_api_key",
      { name: "child-to-revoke" },
    );
    const childId = toolResult(childBody).id as string;

    // Revoke child key using parent — should succeed
    const { body: revokeBody } = await callTool(
      app,
      `Bearer ${parentKey}`,
      apiSid,
      "knowledge_revoke_api_key",
      { key_id: childId },
    );
    expect(isToolError(revokeBody)).toBe(false);
    expect(toolResult(revokeBody)).toEqual({ revoked: true });
  });
});

// ── createApiKeyWithLimit concurrency ─────────────────────────────────────────

describe("createApiKeyWithLimit serialization", () => {
  // Smoke test: Promise.all in Node.js does not guarantee overlapping DB
  // transactions, so this may run sequentially. The hard serialization
  // guarantee is the read-modify-write on u.api_key_version in
  // neo4j-client.ts createApiKeyWithLimit, which forces Neo4j to detect
  // write conflicts and retry the losing transaction with an up-to-date count.
  it("allows only one creation when two concurrent calls race with maxPerUser: 1", async () => {
    const userId = uniqueUser();
    const { hash: hash1, prefix: prefix1 } = generateApiKey();
    const { hash: hash2, prefix: prefix2 } = generateApiKey();

    const [result1, result2] = await Promise.all([
      neo4jClient.createApiKeyWithLimit({
        id: randomUUID(),
        userId,
        name: "concurrent-key-1",
        keyHash: hash1,
        keyPrefix: prefix1,
        namespaces: null,
        expiresAt: null,
        maxPerUser: 1,
      }),
      neo4jClient.createApiKeyWithLimit({
        id: randomUUID(),
        userId,
        name: "concurrent-key-2",
        keyHash: hash2,
        keyPrefix: prefix2,
        namespaces: null,
        expiresAt: null,
        maxPerUser: 1,
      }),
    ]);

    const created = [result1, result2].filter((r) => r !== null);
    expect(created).toHaveLength(1);
  });
});

// ── Session credential binding ────────────────────────────────────────────────

describe("session credential binding", () => {
  it("rejects an API-key request that tries to use a JWT-created session", async () => {
    const app = buildApp();
    const sub = uniqueUser();
    const token = await makeToken(sub);

    // Open an unrestricted JWT session
    const { sessionId: jwtSid } = await openSession(app, `Bearer ${token}`);

    // Create a homelab-restricted API key via that JWT session
    const { body: keyBody } = await callTool(
      app,
      `Bearer ${token}`,
      jwtSid,
      "knowledge_create_api_key",
      { name: "restricted-key", namespaces: ["homelab"] },
    );
    const restrictedKey = toolResult(keyBody).key as string;

    // Attempt to call a tool using the restricted API key BUT the JWT session id
    const res = await app.request("/mcp", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${restrictedKey}`,
        "Mcp-Session-Id": jwtSid,
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/list",
        params: {},
      }),
    });

    // The router must reject: session was created by JWT, not by this API key
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error?: { code: number } };
    expect(body.error?.code).toBe(ErrorCode.SESSION_NOT_FOUND);
  });

  it("allows an API-key request that uses its own session", async () => {
    const app = buildApp();
    const sub = uniqueUser();
    const token = await makeToken(sub);
    const { sessionId: jwtSid } = await openSession(app, `Bearer ${token}`);

    // Create a restricted API key
    const { body: keyBody } = await callTool(
      app,
      `Bearer ${token}`,
      jwtSid,
      "knowledge_create_api_key",
      { name: "own-session-key", namespaces: ["homelab"] },
    );
    const restrictedKey = toolResult(keyBody).key as string;

    // Open a session with the API key itself, then use that session
    const { sessionId: apiSid, status } = await openSession(
      app,
      `Bearer ${restrictedKey}`,
      { urlPath: "/mcp/homelab" },
    );
    expect(status).toBe(200);

    const res = await app.request("/mcp", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${restrictedKey}`,
        "Mcp-Session-Id": apiSid,
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/list",
        params: {},
      }),
    });

    expect(res.status).toBe(200);
  });
});

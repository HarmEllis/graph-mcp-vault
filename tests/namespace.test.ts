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
import { JwksClient } from "../src/auth.js";
import type { Config } from "../src/config.js";
import { ErrorCode } from "../src/errors.js";
import { Neo4jClient } from "../src/neo4j-client.js";
import { createMcpRouter } from "../src/routers/mcp.js";
import { initSchema } from "../src/schema.js";
import { SessionStore } from "../src/session.js";
import { createResourceTools } from "../src/tools/resources.js";

// ── Fixtures ──────────────────────────────────────────────────────────────────

const ISSUER = "https://oidc.example.com";
const AUDIENCE = "graph-mcp-vault";
const KID = "ns-test-key";
const JWKS_URI = `${ISSUER}/.well-known/jwks.json`;
const NEO4J_PASSWORD = "testpassword";

const BASE_CONFIG: Config = {
  oidcIssuer: ISSUER,
  oidcAudience: AUDIENCE,
  jwksCacheTtl: 3600,
  metadataCacheTtl: 3600,
  neo4jUri: "bolt://localhost:7687",
  neo4jUser: "neo4j",
  neo4jPassword: NEO4J_PASSWORD,
  host: "0.0.0.0",
  port: 8000,
  defaultNamespace: "test-default",
  logLevel: "info",
  allowedOrigins: "",
  oidcDiscoveryUrl: undefined,
  publicUrl: "http://localhost:8000",
  scopesAllowlist: undefined,
  injectMissingScope: false,
};

let container: StartedTestContainer;
let driver: Driver;
let neo4jClient: Neo4jClient;
let app: Hono;
let sessionStore: SessionStore;
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

  sessionStore = new SessionStore();
  const jwksClient = new JwksClient(JWKS_URI, BASE_CONFIG.jwksCacheTtl * 1000);
  app = new Hono();
  app.route(
    "/",
    createMcpRouter(
      BASE_CONFIG,
      sessionStore,
      jwksClient,
      createResourceTools(neo4jClient),
      neo4jClient,
      "",
    ),
  );
}, 120_000);

afterAll(async () => {
  vi.unstubAllGlobals();
  await driver?.close();
  await container?.stop();
});

// ── Helpers ───────────────────────────────────────────────────────────────────

function uid(label: string): string {
  userCounter += 1;
  return `ns-${label}-${userCounter}`;
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

/**
 * Opens an MCP session. `metaNamespace` sets params.meta.namespace;
 * `urlPath` lets tests use /mcp/:namespace routes.
 */
async function openSession(
  sub: string,
  opts: { metaNamespace?: string; urlPath?: string } = {},
): Promise<string> {
  const token = await makeToken(sub);
  const params: Record<string, unknown> = {
    protocolVersion: "2025-03-26",
    capabilities: {},
    clientInfo: { name: "test", version: "1.0" },
  };
  if (opts.metaNamespace !== undefined) {
    params.meta = { namespace: opts.metaNamespace };
  }
  const path = opts.urlPath ?? "/mcp";
  const res = await app.request(path, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 0,
      method: "initialize",
      params,
    }),
  });
  const sid = res.headers.get("mcp-session-id");
  if (!sid) throw new Error(`initialize failed: status=${res.status}`);
  return sid;
}

// ── MCP content format helpers ────────────────────────────────────────────────

interface McpContentItem {
  type: string;
  text: string;
}

function parseToolSuccess(
  body: Record<string, unknown>,
): Record<string, unknown> {
  const result = body.result as Record<string, unknown>;
  const content = result.content as McpContentItem[];
  return JSON.parse(content[0]?.text ?? "") as Record<string, unknown>;
}

async function callTool(
  name: string,
  args: Record<string, unknown>,
  sub: string,
  sessionId: string,
  urlPath = "/mcp",
): Promise<{ status: number; body: Record<string, unknown> }> {
  const token = await makeToken(sub);
  const res = await app.request(urlPath, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
      "Mcp-Session-Id": sessionId,
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name, arguments: args },
    }),
  });
  return {
    status: res.status,
    body: (await res.json()) as Record<string, unknown>,
  };
}

async function postMcp(
  method: string,
  params: Record<string, unknown>,
  sub: string,
  sessionId: string,
  urlPath = "/mcp",
): Promise<{ status: number; body: Record<string, unknown> }> {
  const token = await makeToken(sub);
  const res = await app.request(urlPath, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
      "Mcp-Session-Id": sessionId,
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 2, method, params }),
  });
  return {
    status: res.status,
    body: (await res.json()) as Record<string, unknown>,
  };
}

// ── Namespace resolution ──────────────────────────────────────────────────────

describe("namespace resolution", () => {
  it("params.meta.namespace is stored on the session", async () => {
    const sub = uid("meta-ns");
    const sid = await openSession(sub, { metaNamespace: "my-workspace" });
    const session = sessionStore.get(sid);
    expect(session?.namespace).toBe("my-workspace");
  });

  it("URL path namespace is stored on the session when no meta.namespace", async () => {
    const sub = uid("url-ns");
    const sid = await openSession(sub, { urlPath: "/mcp/url-workspace" });
    const session = sessionStore.get(sid);
    expect(session?.namespace).toBe("url-workspace");
  });

  it("falls back to DEFAULT_NAMESPACE when neither meta nor URL namespace is given", async () => {
    const sub = uid("default-ns");
    const sid = await openSession(sub);
    const session = sessionStore.get(sid);
    expect(session?.namespace).toBe(BASE_CONFIG.defaultNamespace);
  });

  it("meta.namespace takes priority over URL path namespace", async () => {
    const sub = uid("priority-ns");
    const sid = await openSession(sub, {
      metaNamespace: "meta-wins",
      urlPath: "/mcp/url-loses",
    });
    const session = sessionStore.get(sid);
    expect(session?.namespace).toBe("meta-wins");
  });
});

// ── Namespace isolation ───────────────────────────────────────────────────────

describe("namespace isolation", () => {
  it("knowledge_create_entry uses the session namespace when no arg namespace is given", async () => {
    const sub = uid("create-ns-default");
    const sid = await openSession(sub, { metaNamespace: "iso-ns-a" });

    const { body } = await callTool(
      "knowledge_create_entry",
      { entry_type: "note", title: "In A", content: "" },
      sub,
      sid,
    );
    const id = parseToolSuccess(body).id as string;
    const resource = await neo4jClient.getResource(id);
    expect(resource?.namespace).toBe("iso-ns-a");
  });

  it("knowledge_list_entries defaults to session namespace — resources from another namespace are not returned", async () => {
    const sub = uid("iso-list");

    // Create a resource in ns-a
    const sidA = await openSession(sub, { metaNamespace: "iso-list-ns-a" });
    const { body: cb } = await callTool(
      "knowledge_create_entry",
      { entry_type: "note", title: "Only In A", content: "" },
      sub,
      sidA,
    );
    const idInA = parseToolSuccess(cb).id as string;

    // Open a session in ns-b and list entries (no namespace arg → defaults to ns-b)
    const sidB = await openSession(sub, { metaNamespace: "iso-list-ns-b" });
    const { body: lb } = await callTool(
      "knowledge_list_entries",
      {},
      sub,
      sidB,
    );
    const resources = parseToolSuccess(lb).resources as Array<
      Record<string, unknown>
    >;

    expect(resources.every((r) => r.namespace === "iso-list-ns-b")).toBe(true);
    expect(resources.some((r) => r.id === idInA)).toBe(false);
  });

  it("knowledge_list_entries with explicit namespace arg can cross namespaces", async () => {
    const sub = uid("iso-cross");

    const sidA = await openSession(sub, { metaNamespace: "iso-cross-ns-a" });
    const { body: cb } = await callTool(
      "knowledge_create_entry",
      { entry_type: "note", title: "Cross NS", content: "" },
      sub,
      sidA,
    );
    const idInA = parseToolSuccess(cb).id as string;

    // list from a ns-b session but explicitly request ns-a
    const sidB = await openSession(sub, { metaNamespace: "iso-cross-ns-b" });
    const { body: lb } = await callTool(
      "knowledge_list_entries",
      { namespace: "iso-cross-ns-a" },
      sub,
      sidB,
    );
    const resources = parseToolSuccess(lb).resources as Array<
      Record<string, unknown>
    >;

    expect(resources.some((r) => r.id === idInA)).toBe(true);
  });

  it("URL-path namespace session scopes knowledge_list_entries to that namespace", async () => {
    const sub = uid("url-iso");

    const sid = await openSession(sub, { urlPath: "/mcp/url-iso-ns" });
    await callTool(
      "knowledge_create_entry",
      { entry_type: "note", title: "URL NS Resource", content: "" },
      sub,
      sid,
    );

    // List without namespace arg → should only return resources in url-iso-ns
    const { body } = await callTool("knowledge_list_entries", {}, sub, sid);
    const resources = parseToolSuccess(body).resources as Array<
      Record<string, unknown>
    >;
    expect(resources.every((r) => r.namespace === "url-iso-ns")).toBe(true);
  });

  it("DEFAULT_NAMESPACE session scopes knowledge_list_entries to the default namespace", async () => {
    const sub = uid("default-iso");
    const sid = await openSession(sub); // no namespace → uses 'test-default'
    await callTool(
      "knowledge_create_entry",
      { entry_type: "note", title: "Default NS Resource", content: "" },
      sub,
      sid,
    );

    const { body } = await callTool("knowledge_list_entries", {}, sub, sid);
    const resources = parseToolSuccess(body).resources as Array<
      Record<string, unknown>
    >;
    expect(
      resources.every((r) => r.namespace === BASE_CONFIG.defaultNamespace),
    ).toBe(true);
  });
});

// ── SESSION_NAMESPACE_CONFLICT ────────────────────────────────────────────────

describe("SESSION_NAMESPACE_CONFLICT", () => {
  it("returns HTTP 404 when the URL namespace differs from the session namespace", async () => {
    const sub = uid("conflict");

    // Open session on ns-x via URL path
    const sid = await openSession(sub, { urlPath: "/mcp/conflict-ns-x" });

    // Send a request to /mcp/conflict-ns-y with the ns-x session id
    const { status, body } = await postMcp(
      "tools/list",
      {},
      sub,
      sid,
      "/mcp/conflict-ns-y",
    );

    expect(status).toBe(404);
    expect((body.error as Record<string, unknown>).code).toBe(
      ErrorCode.SESSION_NAMESPACE_CONFLICT,
    );
  });

  it("returns HTTP 404 for a tool call with a conflicting URL namespace", async () => {
    const sub = uid("conflict-tool");

    const sid = await openSession(sub, { urlPath: "/mcp/tool-ns-x" });

    const { status, body } = await callTool(
      "knowledge_list_entries",
      {},
      sub,
      sid,
      "/mcp/tool-ns-y", // ← mismatched URL namespace
    );

    expect(status).toBe(404);
    expect((body.error as Record<string, unknown>).code).toBe(
      ErrorCode.SESSION_NAMESPACE_CONFLICT,
    );
  });

  it("does not conflict when the URL namespace matches the session namespace", async () => {
    const sub = uid("no-conflict");
    const sid = await openSession(sub, { urlPath: "/mcp/match-ns" });

    const { status } = await postMcp(
      "tools/list",
      {},
      sub,
      sid,
      "/mcp/match-ns",
    );

    expect(status).toBe(200);
  });

  it("does not conflict when using the base /mcp route (no URL namespace)", async () => {
    const sub = uid("no-conflict-base");
    const sid = await openSession(sub, { metaNamespace: "some-ns" });

    // Calling /mcp (no URL namespace) should never conflict
    const { status } = await postMcp("tools/list", {}, sub, sid, "/mcp");

    expect(status).toBe(200);
  });
});

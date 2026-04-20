import { Hono } from "hono";
import { SignJWT, exportJWK, generateKeyPair } from "jose";
import type { KeyLike } from "jose";
import neo4j, { type Driver } from "neo4j-driver";
import {
  GenericContainer,
  type StartedTestContainer,
  Wait,
} from "testcontainers";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { JwksClient } from "../src/auth.js";
import type { Config } from "../src/config.js";
import { ErrorCode } from "../src/errors.js";
import { Neo4jClient } from "../src/neo4j-client.js";
import { createMcpRouter } from "../src/routers/mcp.js";
import { initSchema } from "../src/schema.js";
import { SessionStore } from "../src/session.js";
import { createNamespaceConfigTools } from "../src/tools/namespace-config.js";
import { createResourceTools } from "../src/tools/resources.js";
import { createUserTools } from "../src/tools/users.js";

// ── Fixtures ──────────────────────────────────────────────────────────────────

const ISSUER = "https://oidc.example.com";
const AUDIENCE = "graph-mcp-vault";
const KID = "tools-test-key";
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
};

let container: StartedTestContainer;
let driver: Driver;
let neo4jClient: Neo4jClient;
let app: Hono;
let privateKey: KeyLike;
let userCounter = 0;

beforeAll(async () => {
  // Start Neo4j
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

  // RSA key pair
  const pair = await generateKeyPair("RS256");
  privateKey = pair.privateKey;
  const jwk = await exportJWK(pair.publicKey);
  const jwksDoc = { keys: [{ ...jwk, kid: KID, use: "sig" }] };

  // Stub fetch globally for the duration of this suite
  vi.stubGlobal(
    "fetch",
    vi
      .fn()
      .mockResolvedValue({ ok: true, status: 200, json: async () => jwksDoc }),
  );

  // Build app
  const sessionStore = new SessionStore();
  const jwksClient = new JwksClient(JWKS_URI, BASE_CONFIG.jwksCacheTtl * 1000);
  const tools = [
    ...createResourceTools(neo4jClient, 10),
    ...createUserTools(neo4jClient),
    ...createNamespaceConfigTools(neo4jClient),
  ];
  app = new Hono();
  app.route(
    "/",
    createMcpRouter(
      BASE_CONFIG,
      sessionStore,
      jwksClient,
      tools,
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

function uniqueUser(label: string): string {
  userCounter += 1;
  return `tools-${label}-${userCounter}`;
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
  sub: string,
  namespace = "default",
): Promise<string> {
  const token = await makeToken(sub);
  const res = await app.request("/mcp", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 0,
      method: "initialize",
      params: {
        protocolVersion: "2025-03-26",
        capabilities: {},
        clientInfo: { name: "test", version: "1.0" },
        meta: { namespace },
      },
    }),
  });
  const sid = res.headers.get("mcp-session-id");
  if (!sid) throw new Error(`initialize failed (status ${res.status})`);
  return sid;
}

async function callTool(
  toolName: string,
  args: Record<string, unknown>,
  sub: string,
  sessionId: string,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const token = await makeToken(sub);
  const res = await app.request("/mcp", {
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
      params: { name: toolName, arguments: args },
    }),
  });
  const body = (await res.json()) as Record<string, unknown>;
  return { status: res.status, body };
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

function parseToolError(body: Record<string, unknown>): {
  code: number;
  message: string;
} {
  const result = body.result as Record<string, unknown>;
  const content = result.content as McpContentItem[];
  return JSON.parse(content[0]?.text ?? "") as {
    code: number;
    message: string;
  };
}

async function createEntry(
  sub: string,
  sid: string,
  params?: {
    title?: string;
    content?: string;
    namespace?: string;
    entry_type?: string;
  },
): Promise<string> {
  const { body } = await callTool(
    "knowledge_create_entry",
    {
      entry_type: params?.entry_type ?? "note",
      title: params?.title ?? "Entry",
      content: params?.content ?? "",
      ...(params?.namespace !== undefined
        ? { namespace: params.namespace }
        : {}),
    },
    sub,
    sid,
  );
  return parseToolSuccess(body).id as string;
}

// ── tools/call MCP content format ─────────────────────────────────────────────

describe("tools/call MCP content format", () => {
  it('wraps success result in content array with type "text"', async () => {
    const sub = uniqueUser("content-format");
    const sid = await openSession(sub);
    const { body } = await callTool(
      "knowledge_create_entry",
      { entry_type: "note", title: "Format Test", content: "test" },
      sub,
      sid,
    );

    const result = body.result as Record<string, unknown>;
    expect(result.isError).toBe(false);
    expect(Array.isArray(result.content)).toBe(true);
    const content = result.content as McpContentItem[];
    expect(content[0]?.type).toBe("text");
    expect(typeof content[0]?.text).toBe("string");
  });

  it("knowledge_list_entries returns explicit content for empty list", async () => {
    const sub = uniqueUser("list-empty-content");
    const sid = await openSession(sub);
    const { status, body } = await callTool(
      "knowledge_list_entries",
      {},
      sub,
      sid,
    );

    expect(status).toBe(200);
    const result = body.result as Record<string, unknown>;
    expect(result.isError).toBe(false);
    const content = result.content as McpContentItem[];
    expect(content[0]?.type).toBe("text");
    const data = JSON.parse(content[0]?.text ?? "") as Record<string, unknown>;
    expect(data.resources).toEqual([]);
  });

  it("tool errors have isError true with code and message in content text", async () => {
    const sub = uniqueUser("error-content");
    const sid = await openSession(sub);
    const { body } = await callTool(
      "knowledge_get_entry",
      { entry_id: "00000000-0000-0000-0000-000000000000" },
      sub,
      sid,
    );

    const result = body.result as Record<string, unknown>;
    expect(result.isError).toBe(true);
    const content = result.content as McpContentItem[];
    const errData = JSON.parse(content[0]?.text ?? "") as {
      code: number;
      message: string;
    };
    expect(errData.code).toBe(ErrorCode.RESOURCE_NOT_FOUND);
  });
});

// ── knowledge_create_entry ────────────────────────────────────────────────────

describe("knowledge_create_entry", () => {
  it("returns id and created_at on success", async () => {
    const sub = uniqueUser("create");
    const sid = await openSession(sub);
    const { status, body } = await callTool(
      "knowledge_create_entry",
      { entry_type: "note", title: "Hello", content: "World" },
      sub,
      sid,
    );

    expect(status).toBe(200);
    const data = parseToolSuccess(body);
    expect(typeof data.id).toBe("string");
    expect(typeof data.created_at).toBe("string");
  });

  it("uses namespace from args when provided", async () => {
    const sub = uniqueUser("create-ns");
    const sid = await openSession(sub, "default");
    const { body } = await callTool(
      "knowledge_create_entry",
      {
        entry_type: "note",
        title: "NS Test",
        content: "",
        namespace: "custom-ns",
      },
      sub,
      sid,
    );

    const id = parseToolSuccess(body).id as string;

    const resource = await neo4jClient.getResource(id);
    expect(resource?.namespace).toBe("custom-ns");
  });

  it("returns INVALID_PARAMS when required args are missing", async () => {
    const sub = uniqueUser("create-bad");
    const sid = await openSession(sub);
    const { body } = await callTool(
      "knowledge_create_entry",
      { entry_type: "note" },
      sub,
      sid,
    );

    expect(parseToolError(body).code).toBe(ErrorCode.INVALID_PARAMS);
  });

  it("stores optional metadata fields", async () => {
    const sub = uniqueUser("create-meta");
    const sid = await openSession(sub);
    const { body } = await callTool(
      "knowledge_create_entry",
      {
        entry_type: "note",
        title: "With Metadata",
        content: "body",
        topic: "engineering",
        tags: ["neo4j", "test"],
        summary: "A short summary",
        source: "https://example.com/doc",
        last_verified_at: "2026-04-14T00:00:00.000Z",
      },
      sub,
      sid,
    );
    const id = parseToolSuccess(body).id as string;
    const resource = await neo4jClient.getResource(id);
    expect(resource?.topic).toBe("engineering");
    expect(resource?.tags).toEqual(["neo4j", "test"]);
    expect(resource?.summary).toBe("A short summary");
    expect(resource?.source).toBe("https://example.com/doc");
    expect(resource?.last_verified_at).toBe("2026-04-14T00:00:00.000Z");
  });

  it("rejects tags with invalid format", async () => {
    const sub = uniqueUser("create-bad-tags");
    const sid = await openSession(sub);
    // Empty string in tags is invalid (min(1))
    const { body } = await callTool(
      "knowledge_create_entry",
      { entry_type: "note", title: "T", content: "c", tags: [""] },
      sub,
      sid,
    );
    expect(parseToolError(body).code).toBe(ErrorCode.INVALID_PARAMS);
  });
});

// ── knowledge_get_entry ───────────────────────────────────────────────────────

describe("knowledge_get_entry", () => {
  it('returns the entry and role "owner" for the creator', async () => {
    const sub = uniqueUser("get-owner");
    const sid = await openSession(sub);
    const { body: createBody } = await callTool(
      "knowledge_create_entry",
      { entry_type: "note", title: "My Resource", content: "some content" },
      sub,
      sid,
    );
    const id = parseToolSuccess(createBody).id as string;

    const { status, body } = await callTool(
      "knowledge_get_entry",
      { entry_id: id },
      sub,
      sid,
    );

    expect(status).toBe(200);
    const data = parseToolSuccess(body);
    expect(data.id).toBe(id);
    expect(data.title).toBe("My Resource");
    expect(data.content).toBe("some content");
    expect(data.role).toBe("owner");
  });

  it("returns RESOURCE_NOT_FOUND for a non-existent id", async () => {
    const sub = uniqueUser("get-missing");
    const sid = await openSession(sub);
    const { body } = await callTool(
      "knowledge_get_entry",
      { entry_id: "00000000-0000-0000-0000-000000000000" },
      sub,
      sid,
    );

    expect(parseToolError(body).code).toBe(ErrorCode.RESOURCE_NOT_FOUND);
  });

  it("returns PERMISSION_DENIED when the user has no access", async () => {
    const owner = uniqueUser("get-noac-owner");
    const stranger = uniqueUser("get-noac-stranger");
    const ownerSid = await openSession(owner);
    const strangerSid = await openSession(stranger);

    const { body: cb } = await callTool(
      "knowledge_create_entry",
      { entry_type: "note", title: "Private", content: "" },
      owner,
      ownerSid,
    );
    const id = parseToolSuccess(cb).id as string;

    const { body } = await callTool(
      "knowledge_get_entry",
      { entry_id: id },
      stranger,
      strangerSid,
    );
    expect(parseToolError(body).code).toBe(ErrorCode.PERMISSION_DENIED);
  });
});

// ── knowledge_list_entries ────────────────────────────────────────────────────

describe("knowledge_list_entries", () => {
  it("returns resources owned by the user", async () => {
    const sub = uniqueUser("list-owner");
    const sid = await openSession(sub);
    await callTool(
      "knowledge_create_entry",
      { entry_type: "note", title: "R1", content: "" },
      sub,
      sid,
    );
    await callTool(
      "knowledge_create_entry",
      { entry_type: "note", title: "R2", content: "" },
      sub,
      sid,
    );

    const { status, body } = await callTool(
      "knowledge_list_entries",
      {},
      sub,
      sid,
    );

    expect(status).toBe(200);
    const resources = parseToolSuccess(body).resources as unknown[];
    expect(resources.length).toBeGreaterThanOrEqual(2);
  });

  it("filters resources by entry_type", async () => {
    const sub = uniqueUser("list-type");
    const sid = await openSession(sub);
    await callTool(
      "knowledge_create_entry",
      { entry_type: "note", title: "Note", content: "" },
      sub,
      sid,
    );
    await callTool(
      "knowledge_create_entry",
      { entry_type: "task", title: "Task", content: "" },
      sub,
      sid,
    );

    const { body } = await callTool(
      "knowledge_list_entries",
      { entry_type: "note" },
      sub,
      sid,
    );
    const resources = parseToolSuccess(body).resources as Array<
      Record<string, unknown>
    >;

    expect(resources.every((r) => r.entry_type === "note")).toBe(true);
  });

  it("respects limit and skip for pagination", async () => {
    const sub = uniqueUser("list-page");
    const sid = await openSession(sub);
    for (let i = 0; i < 5; i++) {
      await callTool(
        "knowledge_create_entry",
        { entry_type: "note", title: `Page Item ${i}`, content: "" },
        sub,
        sid,
      );
    }

    const { body: b1 } = await callTool(
      "knowledge_list_entries",
      { limit: 2, skip: 0 },
      sub,
      sid,
    );
    const { body: b2 } = await callTool(
      "knowledge_list_entries",
      { limit: 2, skip: 2 },
      sub,
      sid,
    );

    const r1 = parseToolSuccess(b1).resources as unknown[];
    const r2 = parseToolSuccess(b2).resources as unknown[];
    expect(r1).toHaveLength(2);
    expect(r2).toHaveLength(2);
  });
});

// ── knowledge_update_entry ────────────────────────────────────────────────────

describe("knowledge_update_entry", () => {
  it("owner can update title and content", async () => {
    const sub = uniqueUser("update-owner");
    const sid = await openSession(sub);
    const { body: cb } = await callTool(
      "knowledge_create_entry",
      { entry_type: "note", title: "Old", content: "Old content" },
      sub,
      sid,
    );
    const id = parseToolSuccess(cb).id as string;

    const { status } = await callTool(
      "knowledge_update_entry",
      { entry_id: id, title: "New", content: "New content" },
      sub,
      sid,
    );
    expect(status).toBe(200);

    const { body: gb } = await callTool(
      "knowledge_get_entry",
      { entry_id: id },
      sub,
      sid,
    );
    const data = parseToolSuccess(gb);
    expect(data.title).toBe("New");
    expect(data.content).toBe("New content");
  });

  it("owner can update metadata fields", async () => {
    const sub = uniqueUser("update-meta");
    const sid = await openSession(sub);
    const { body: cb } = await callTool(
      "knowledge_create_entry",
      { entry_type: "note", title: "Before", content: "" },
      sub,
      sid,
    );
    const id = parseToolSuccess(cb).id as string;

    await callTool(
      "knowledge_update_entry",
      {
        entry_id: id,
        summary: "Updated summary",
        tags: ["updated"],
        topic: "new-topic",
      },
      sub,
      sid,
    );

    const resource = await neo4jClient.getResource(id);
    expect(resource?.summary).toBe("Updated summary");
    expect(resource?.tags).toEqual(["updated"]);
    expect(resource?.topic).toBe("new-topic");
  });

  it("editor can update", async () => {
    const owner = uniqueUser("update-ed-owner");
    const editor = uniqueUser("update-ed-editor");
    const ownerSid = await openSession(owner);
    const editorSid = await openSession(editor);

    const { body: cb } = await callTool(
      "knowledge_create_entry",
      { entry_type: "note", title: "Editable", content: "v1" },
      owner,
      ownerSid,
    );
    const id = parseToolSuccess(cb).id as string;

    await neo4jClient.shareResource(id, editor, "editor");

    const { status } = await callTool(
      "knowledge_update_entry",
      { entry_id: id, title: "Updated by editor" },
      editor,
      editorSid,
    );
    expect(status).toBe(200);
  });

  it("viewer cannot update — returns PERMISSION_DENIED", async () => {
    const owner = uniqueUser("update-view-owner");
    const viewer = uniqueUser("update-view-viewer");
    const ownerSid = await openSession(owner);
    const viewerSid = await openSession(viewer);

    const { body: cb } = await callTool(
      "knowledge_create_entry",
      { entry_type: "note", title: "Read-only", content: "" },
      owner,
      ownerSid,
    );
    const id = parseToolSuccess(cb).id as string;

    await neo4jClient.shareResource(id, viewer, "viewer");

    const { body } = await callTool(
      "knowledge_update_entry",
      { entry_id: id, title: "Hacked" },
      viewer,
      viewerSid,
    );
    expect(parseToolError(body).code).toBe(ErrorCode.PERMISSION_DENIED);
  });
});

// ── knowledge_delete_entry ────────────────────────────────────────────────────

describe("knowledge_delete_entry", () => {
  it("owner can delete — resource is gone afterward", async () => {
    const sub = uniqueUser("delete-owner");
    const sid = await openSession(sub);
    const { body: cb } = await callTool(
      "knowledge_create_entry",
      { entry_type: "note", title: "Deletable", content: "" },
      sub,
      sid,
    );
    const id = parseToolSuccess(cb).id as string;

    const { status } = await callTool(
      "knowledge_delete_entry",
      { entry_id: id },
      sub,
      sid,
    );
    expect(status).toBe(200);

    const { body: gb } = await callTool(
      "knowledge_get_entry",
      { entry_id: id },
      sub,
      sid,
    );
    expect(parseToolError(gb).code).toBe(ErrorCode.RESOURCE_NOT_FOUND);
  });

  it("viewer cannot delete — returns PERMISSION_DENIED", async () => {
    const owner = uniqueUser("delete-view-owner");
    const viewer = uniqueUser("delete-view-viewer");
    const ownerSid = await openSession(owner);
    const viewerSid = await openSession(viewer);

    const { body: cb } = await callTool(
      "knowledge_create_entry",
      { entry_type: "note", title: "Protected", content: "" },
      owner,
      ownerSid,
    );
    const id = parseToolSuccess(cb).id as string;
    await neo4jClient.shareResource(id, viewer, "viewer");

    const { body } = await callTool(
      "knowledge_delete_entry",
      { entry_id: id },
      viewer,
      viewerSid,
    );
    expect(parseToolError(body).code).toBe(ErrorCode.PERMISSION_DENIED);
  });

  it("editor cannot delete — returns PERMISSION_DENIED", async () => {
    const owner = uniqueUser("delete-ed-owner");
    const editor = uniqueUser("delete-ed-editor");
    const ownerSid = await openSession(owner);
    const editorSid = await openSession(editor);

    const { body: cb } = await callTool(
      "knowledge_create_entry",
      { entry_type: "note", title: "Editor Target", content: "" },
      owner,
      ownerSid,
    );
    const id = parseToolSuccess(cb).id as string;
    await neo4jClient.shareResource(id, editor, "editor");

    const { body } = await callTool(
      "knowledge_delete_entry",
      { entry_id: id },
      editor,
      editorSid,
    );
    expect(parseToolError(body).code).toBe(ErrorCode.PERMISSION_DENIED);
  });

  it("delete removes all sharing relationships", async () => {
    const owner = uniqueUser("delete-rel-owner");
    const viewer = uniqueUser("delete-rel-viewer");
    const ownerSid = await openSession(owner);

    const { body: cb } = await callTool(
      "knowledge_create_entry",
      { entry_type: "note", title: "Shared Then Deleted", content: "" },
      owner,
      ownerSid,
    );
    const id = parseToolSuccess(cb).id as string;
    await neo4jClient.shareResource(id, viewer, "viewer");

    await callTool("knowledge_delete_entry", { entry_id: id }, owner, ownerSid);

    const resource = await neo4jClient.getResource(id);
    expect(resource).toBeNull();
  });
});

// ── knowledge_search_entries ──────────────────────────────────────────────────

describe("knowledge_search_entries", () => {
  it("returns resources matching the search query", async () => {
    const sub = uniqueUser("search-basic");
    const sid = await openSession(sub);
    await callTool(
      "knowledge_create_entry",
      {
        entry_type: "note",
        title: "Gravitational Wave",
        content: "LIGO detection",
      },
      sub,
      sid,
    );
    await callTool(
      "knowledge_create_entry",
      {
        entry_type: "note",
        title: "Recipe Book",
        content: "cooking instructions",
      },
      sub,
      sid,
    );

    const { status, body } = await callTool(
      "knowledge_search_entries",
      { query: "Gravitational" },
      sub,
      sid,
    );

    expect(status).toBe(200);
    const resources = parseToolSuccess(body).resources as Array<
      Record<string, unknown>
    >;
    expect(resources.some((r) => r.title === "Gravitational Wave")).toBe(true);
    expect(resources.every((r) => r.title !== "Recipe Book")).toBe(true);
  });

  it("returns INVALID_PARAMS when query is missing", async () => {
    const sub = uniqueUser("search-no-query");
    const sid = await openSession(sub);
    const { body } = await callTool("knowledge_search_entries", {}, sub, sid);
    expect(parseToolError(body).code).toBe(ErrorCode.INVALID_PARAMS);
  });

  it("explicit namespace scoping restricts results to that namespace", async () => {
    const sub = uniqueUser("search-ns");
    const sidA = await openSession(sub, "ns-search-x");
    const sidB = await openSession(sub, "ns-search-y");

    const tag = Date.now().toString();
    await callTool(
      "knowledge_create_entry",
      { entry_type: "note", title: `Quark${tag}`, content: "in x" },
      sub,
      sidA,
    );
    await callTool(
      "knowledge_create_entry",
      { entry_type: "note", title: `Quark${tag}`, content: "in y" },
      sub,
      sidB,
    );

    const { body } = await callTool(
      "knowledge_search_entries",
      { query: `Quark${tag}`, namespace: "ns-search-x" },
      sub,
      sidA,
    );
    const resources = parseToolSuccess(body).resources as Array<
      Record<string, unknown>
    >;

    expect(resources.every((r) => r.namespace === "ns-search-x")).toBe(true);
  });

  it("permission filtering: user cannot see resources they have no access to", async () => {
    const owner = uniqueUser("search-perm-owner");
    const stranger = uniqueUser("search-perm-stranger");
    const ownerSid = await openSession(owner);
    const strangerSid = await openSession(stranger);

    const tag = Date.now().toString();
    await callTool(
      "knowledge_create_entry",
      { entry_type: "note", title: `PrivateMeson${tag}`, content: "" },
      owner,
      ownerSid,
    );

    const { body } = await callTool(
      "knowledge_search_entries",
      { query: `PrivateMeson${tag}` },
      stranger,
      strangerSid,
    );
    const resources = parseToolSuccess(body).resources as Array<
      Record<string, unknown>
    >;

    expect(resources).toHaveLength(0);
  });

  it("filters by entry_type when provided", async () => {
    const sub = uniqueUser("search-type");
    const sid = await openSession(sub);

    const tag = Date.now().toString();
    await callTool(
      "knowledge_create_entry",
      { entry_type: "note", title: `Boson${tag}`, content: "" },
      sub,
      sid,
    );
    await callTool(
      "knowledge_create_entry",
      { entry_type: "task", title: `Boson${tag} Task`, content: "" },
      sub,
      sid,
    );

    const { body } = await callTool(
      "knowledge_search_entries",
      { query: `Boson${tag}`, entry_type: "note" },
      sub,
      sid,
    );
    const resources = parseToolSuccess(body).resources as Array<
      Record<string, unknown>
    >;

    expect(resources.every((r) => r.entry_type === "note")).toBe(true);
    expect(
      resources.some((r) => (r.title as string).includes(`Boson${tag}`)),
    ).toBe(true);
  });

  it("respects limit and skip for pagination", async () => {
    const sub = uniqueUser("search-page");
    const sid = await openSession(sub);

    const tag = Date.now().toString();
    for (let i = 0; i < 4; i++) {
      await callTool(
        "knowledge_create_entry",
        { entry_type: "note", title: `Lepton${tag} item${i}`, content: "" },
        sub,
        sid,
      );
    }

    const { body: b1 } = await callTool(
      "knowledge_search_entries",
      { query: `Lepton${tag}`, limit: 2, skip: 0 },
      sub,
      sid,
    );
    const { body: b2 } = await callTool(
      "knowledge_search_entries",
      { query: `Lepton${tag}`, limit: 2, skip: 2 },
      sub,
      sid,
    );

    const r1 = parseToolSuccess(b1).resources as Array<Record<string, unknown>>;
    const r2 = parseToolSuccess(b2).resources as Array<Record<string, unknown>>;
    expect(r1).toHaveLength(2);
    expect(r2).toHaveLength(2);
    const ids1 = r1.map((r) => r.id);
    const ids2 = r2.map((r) => r.id);
    expect(ids1.some((id) => ids2.includes(id))).toBe(false);
  });

  it("results include ownership field for owned resources", async () => {
    const sub = uniqueUser("search-ownership");
    const sid = await openSession(sub);

    const tag = Date.now().toString();
    await callTool(
      "knowledge_create_entry",
      { entry_type: "note", title: `Muon${tag}`, content: "" },
      sub,
      sid,
    );

    const { body } = await callTool(
      "knowledge_search_entries",
      { query: `Muon${tag}` },
      sub,
      sid,
    );
    const resources = parseToolSuccess(body).resources as Array<
      Record<string, unknown>
    >;

    expect(resources.length).toBeGreaterThanOrEqual(1);
    expect(resources.every((r) => r.ownership === "owner")).toBe(true);
  });

  it("explicit namespace arg searches in the specified namespace regardless of session namespace", async () => {
    const sub = uniqueUser("search-ns-override");
    const sidA = await openSession(sub, "ns-override-a");
    const sidB = await openSession(sub, "ns-override-b");

    const tag = Date.now().toString();
    await callTool(
      "knowledge_create_entry",
      { entry_type: "note", title: `Tauon${tag}`, content: "" },
      sub,
      sidA,
    );

    const { body } = await callTool(
      "knowledge_search_entries",
      { query: `Tauon${tag}`, namespace: "ns-override-a" },
      sub,
      sidB,
    );
    const resources = parseToolSuccess(body).resources as Array<
      Record<string, unknown>
    >;

    expect(resources.some((r) => r.title === `Tauon${tag}`)).toBe(true);
    expect(resources.every((r) => r.namespace === "ns-override-a")).toBe(true);
  });

  it("fulltext mode: does not return INTERNAL_ERROR for a query with Lucene special characters", async () => {
    const sub = uniqueUser("search-lucene");
    const sid = await openSession(sub);

    const { status, body } = await callTool(
      "knowledge_search_entries",
      { query: "(broken query", match_mode: "fulltext" },
      sub,
      sid,
    );

    expect(status).toBe(200);
    const result = body.result as Record<string, unknown>;
    expect(result.isError).toBe(false);
    const data = parseToolSuccess(body);
    expect(Array.isArray(data.resources)).toBe(true);
  });

  it("fuzzy mode: returns empty results when all tokens are boolean operators", async () => {
    const sub = uniqueUser("search-fuzzy-empty");
    const sid = await openSession(sub);

    const { status, body } = await callTool(
      "knowledge_search_entries",
      { query: "AND OR NOT", match_mode: "fuzzy" },
      sub,
      sid,
    );

    expect(status).toBe(200);
    const result = body.result as Record<string, unknown>;
    expect(result.isError).toBe(false);
    const data = parseToolSuccess(body);
    expect(data.resources).toEqual([]);
  });

  it("exact mode: finds entry via phrase match", async () => {
    const sub = uniqueUser("search-exact");
    const sid = await openSession(sub);

    const tag = `ExactPhraseTest${Date.now()}`;
    await callTool(
      "knowledge_create_entry",
      { entry_type: "note", title: tag, content: "" },
      sub,
      sid,
    );

    const { body } = await callTool(
      "knowledge_search_entries",
      { query: tag, match_mode: "exact" },
      sub,
      sid,
    );
    const resources = parseToolSuccess(body).resources as Array<
      Record<string, unknown>
    >;
    expect(resources.some((r) => r.title === tag)).toBe(true);
  });

  it("default match_mode is fuzzy and does not throw", async () => {
    const sub = uniqueUser("search-default-mode");
    const sid = await openSession(sub);

    const { status, body } = await callTool(
      "knowledge_search_entries",
      { query: "anything" },
      sub,
      sid,
    );
    expect(status).toBe(200);
    const result = body.result as Record<string, unknown>;
    expect(result.isError).toBe(false);
  });

  it("rejects an invalid match_mode value", async () => {
    const sub = uniqueUser("search-bad-mode");
    const sid = await openSession(sub);

    const { body } = await callTool(
      "knowledge_search_entries",
      { query: "test", match_mode: "invalid" },
      sub,
      sid,
    );
    expect(parseToolError(body).code).toBe(ErrorCode.INVALID_PARAMS);
  });

  it("all_namespaces:true returns hits from multiple namespaces for the same user", async () => {
    const sub = uniqueUser("search-all-ns");
    const sidA = await openSession(sub, "ns-all-a");
    const sidB = await openSession(sub, "ns-all-b");

    const tag = `AllNsTag${Date.now()}`;
    await callTool(
      "knowledge_create_entry",
      { entry_type: "note", title: `${tag}-inA`, content: "" },
      sub,
      sidA,
    );
    await callTool(
      "knowledge_create_entry",
      { entry_type: "note", title: `${tag}-inB`, content: "" },
      sub,
      sidB,
    );

    const { body } = await callTool(
      "knowledge_search_entries",
      { query: tag, all_namespaces: true },
      sub,
      sidA,
    );
    const resources = parseToolSuccess(body).resources as Array<
      Record<string, unknown>
    >;
    const namespaces = [...new Set(resources.map((r) => r.namespace))];
    expect(namespaces).toContain("ns-all-a");
    expect(namespaces).toContain("ns-all-b");
  });

  it("default (no namespace param) searches all accessible namespaces", async () => {
    const sub = uniqueUser("search-default-all-ns");
    const sidA = await openSession(sub, "ns-def-a");
    const sidB = await openSession(sub, "ns-def-b");

    const tag = `DefaultAllNsTag${Date.now()}`;
    await callTool(
      "knowledge_create_entry",
      { entry_type: "note", title: `${tag}-inA`, content: "" },
      sub,
      sidA,
    );
    await callTool(
      "knowledge_create_entry",
      { entry_type: "note", title: `${tag}-inB`, content: "" },
      sub,
      sidB,
    );

    const { body } = await callTool(
      "knowledge_search_entries",
      { query: tag },
      sub,
      sidA,
    );
    const resources = parseToolSuccess(body).resources as Array<
      Record<string, unknown>
    >;
    const namespaces = [...new Set(resources.map((r) => r.namespace))];
    expect(namespaces).toContain("ns-def-a");
    expect(namespaces).toContain("ns-def-b");
  });

  it("explicit namespace override still works when all_namespaces is omitted", async () => {
    const sub = uniqueUser("search-ns-explicit-unchanged");
    const sidA = await openSession(sub, "ns-exp-a");
    const sidB = await openSession(sub, "ns-exp-b");

    const tag = `ExplicitNsTag${Date.now()}`;
    await callTool(
      "knowledge_create_entry",
      { entry_type: "note", title: `${tag}`, content: "" },
      sub,
      sidA,
    );

    const { body } = await callTool(
      "knowledge_search_entries",
      { query: tag, namespace: "ns-exp-a" },
      sub,
      sidB,
    );
    const resources = parseToolSuccess(body).resources as Array<
      Record<string, unknown>
    >;
    expect(resources.some((r) => r.title === tag)).toBe(true);
    expect(resources.every((r) => r.namespace === "ns-exp-a")).toBe(true);
  });

  it("namespace + all_namespaces:true succeeds with namespace taking precedence", async () => {
    const sub = uniqueUser("search-ns-wins");
    const sidA = await openSession(sub, "ns-wins-a");
    const sidB = await openSession(sub, "ns-wins-b");

    const tag = `NsWinsTag${Date.now()}`;
    await callTool(
      "knowledge_create_entry",
      { entry_type: "note", title: `${tag}-inA`, content: "" },
      sub,
      sidA,
    );
    await callTool(
      "knowledge_create_entry",
      { entry_type: "note", title: `${tag}-inB`, content: "" },
      sub,
      sidB,
    );

    const { body } = await callTool(
      "knowledge_search_entries",
      { query: tag, namespace: "ns-wins-a", all_namespaces: true },
      sub,
      sidA,
    );
    // No error — namespace wins, only ns-wins-a results returned
    const resources = parseToolSuccess(body).resources as Array<
      Record<string, unknown>
    >;
    expect(resources.every((r) => r.namespace === "ns-wins-a")).toBe(true);
  });

  it("permission filtering still applies in all_namespaces mode", async () => {
    const owner = uniqueUser("search-all-perm-owner");
    const stranger = uniqueUser("search-all-perm-stranger");
    const ownerSid = await openSession(owner, "ns-perm-all");
    const strangerSid = await openSession(stranger, "ns-perm-all");

    const tag = `PrivateAllNs${Date.now()}`;
    await callTool(
      "knowledge_create_entry",
      { entry_type: "note", title: tag, content: "" },
      owner,
      ownerSid,
    );

    const { body } = await callTool(
      "knowledge_search_entries",
      { query: tag, all_namespaces: true },
      stranger,
      strangerSid,
    );
    const resources = parseToolSuccess(body).resources as Array<
      Record<string, unknown>
    >;
    expect(resources).toHaveLength(0);
  });

  it("pagination (limit/skip) works for cross-namespace combined results", async () => {
    const sub = uniqueUser("search-all-ns-page");
    const sidA = await openSession(sub, "ns-page-a");
    const sidB = await openSession(sub, "ns-page-b");

    const tag = `PageAllNs${Date.now()}`;
    for (let i = 0; i < 3; i++) {
      await callTool(
        "knowledge_create_entry",
        { entry_type: "note", title: `${tag}-a${i}`, content: "" },
        sub,
        sidA,
      );
    }
    for (let i = 0; i < 3; i++) {
      await callTool(
        "knowledge_create_entry",
        { entry_type: "note", title: `${tag}-b${i}`, content: "" },
        sub,
        sidB,
      );
    }

    const { body: b1 } = await callTool(
      "knowledge_search_entries",
      { query: tag, all_namespaces: true, limit: 3, skip: 0 },
      sub,
      sidA,
    );
    const { body: b2 } = await callTool(
      "knowledge_search_entries",
      { query: tag, all_namespaces: true, limit: 3, skip: 3 },
      sub,
      sidA,
    );

    const r1 = parseToolSuccess(b1).resources as Array<Record<string, unknown>>;
    const r2 = parseToolSuccess(b2).resources as Array<Record<string, unknown>>;
    expect(r1).toHaveLength(3);
    expect(r2).toHaveLength(3);
    const ids1 = r1.map((r) => r.id);
    const ids2 = r2.map((r) => r.id);
    expect(ids1.some((id) => ids2.includes(id))).toBe(false);
  });

  it("all_namespaces:false + explicit namespace matches the namespace override behavior", async () => {
    const sub = uniqueUser("search-false-with-ns");
    const sidA = await openSession(sub, "ns-false-a");
    const sidB = await openSession(sub, "ns-false-b");

    const tag = `FalseNsTag${Date.now()}`;
    await callTool(
      "knowledge_create_entry",
      { entry_type: "note", title: tag, content: "" },
      sub,
      sidA,
    );

    const { body } = await callTool(
      "knowledge_search_entries",
      { query: tag, namespace: "ns-false-a", all_namespaces: false },
      sub,
      sidB,
    );
    const resources = parseToolSuccess(body).resources as Array<
      Record<string, unknown>
    >;
    expect(resources.some((r) => r.title === tag)).toBe(true);
    expect(resources.every((r) => r.namespace === "ns-false-a")).toBe(true);
  });

  it("all_namespaces:false without namespace is a no-op and searches all namespaces", async () => {
    const sub = uniqueUser("search-false-no-ns");
    const sidA = await openSession(sub, "ns-false-only-a");
    const sidB = await openSession(sub, "ns-false-only-b");

    const tag = `FalseNoNsTag${Date.now()}`;
    await callTool(
      "knowledge_create_entry",
      { entry_type: "note", title: `${tag}-inA`, content: "" },
      sub,
      sidA,
    );
    await callTool(
      "knowledge_create_entry",
      { entry_type: "note", title: `${tag}-inB`, content: "" },
      sub,
      sidB,
    );

    const { body } = await callTool(
      "knowledge_search_entries",
      { query: tag, all_namespaces: false },
      sub,
      sidA,
    );
    const resources = parseToolSuccess(body).resources as Array<
      Record<string, unknown>
    >;
    const namespaces = [...new Set(resources.map((r) => r.namespace))];
    expect(namespaces).toContain("ns-false-only-a");
    expect(namespaces).toContain("ns-false-only-b");
  });

  it("results include a numeric score field", async () => {
    const sub = uniqueUser("search-score-field");
    const sid = await openSession(sub, "ns-score");
    const tag = `ScoreTag${Date.now()}`;
    await callTool(
      "knowledge_create_entry",
      { entry_type: "note", title: tag, content: tag },
      sub,
      sid,
    );

    const { body } = await callTool(
      "knowledge_search_entries",
      { query: tag },
      sub,
      sid,
    );
    const resources = parseToolSuccess(body).resources as Array<
      Record<string, unknown>
    >;
    expect(resources.length).toBeGreaterThan(0);
    expect(typeof resources[0]?.score).toBe("number");
    expect((resources[0]?.score as number) > 0).toBe(true);
  });

  it("returns a hint when querying structured tokens (IP) in fuzzy mode", async () => {
    const sub = uniqueUser("search-hint-ip");
    const sid = await openSession(sub, "ns-hint");
    await callTool(
      "knowledge_create_entry",
      {
        entry_type: "note",
        title: "Router config 10.0.0.1",
        content: "gateway 10.0.0.1",
      },
      sub,
      sid,
    );

    const { body } = await callTool(
      "knowledge_search_entries",
      { query: "10.0.0.1", match_mode: "fuzzy" },
      sub,
      sid,
    );
    const result = parseToolSuccess(body) as Record<string, unknown>;
    expect(typeof result.hint).toBe("string");
    expect((result.hint as string).length).toBeGreaterThan(0);
  });

  it("does not return a hint when match_mode is fulltext", async () => {
    const sub = uniqueUser("search-hint-fulltext");
    const sid = await openSession(sub, "ns-hint-ft");
    await callTool(
      "knowledge_create_entry",
      {
        entry_type: "note",
        title: "Router config 10.0.0.1",
        content: "gateway 10.0.0.1",
      },
      sub,
      sid,
    );

    const { body } = await callTool(
      "knowledge_search_entries",
      { query: "10.0.0.1", match_mode: "fulltext" },
      sub,
      sid,
    );
    const result = parseToolSuccess(body) as Record<string, unknown>;
    expect(result.hint).toBeUndefined();
  });

  it("does not return a hint for plain natural-language queries", async () => {
    const sub = uniqueUser("search-hint-plain");
    const sid = await openSession(sub, "ns-hint-plain");
    const tag = `PlainHintTag${Date.now()}`;
    await callTool(
      "knowledge_create_entry",
      { entry_type: "note", title: tag, content: "some content" },
      sub,
      sid,
    );

    const { body } = await callTool(
      "knowledge_search_entries",
      { query: tag },
      sub,
      sid,
    );
    const result = parseToolSuccess(body) as Record<string, unknown>;
    expect(result.hint).toBeUndefined();
  });
});

// ── knowledge_*_relation ──────────────────────────────────────────────────────

describe("knowledge_create_relation / knowledge_list_relations / knowledge_delete_relation", () => {
  it("creates relation and returns it through knowledge_list_relations wrapper", async () => {
    const sub = uniqueUser("rel-create-list");
    const sid = await openSession(sub, "rel-tools");
    const fromId = await createEntry(sub, sid, { title: "Source" });
    const toId = await createEntry(sub, sid, { title: "Target" });

    const { status: createStatus } = await callTool(
      "knowledge_create_relation",
      {
        from_id: fromId,
        to_id: toId,
        relation_type: "DEPENDS_ON",
        label: "critical runtime dependency",
      },
      sub,
      sid,
    );
    expect(createStatus).toBe(200);

    const { status: listStatus, body: listBody } = await callTool(
      "knowledge_list_relations",
      { entry_id: fromId, direction: "outbound" },
      sub,
      sid,
    );
    expect(listStatus).toBe(200);
    const relations = parseToolSuccess(listBody).relations as Array<
      Record<string, unknown>
    >;
    expect(relations).toHaveLength(1);
    expect(relations[0]?.direction).toBe("outbound");
    expect(relations[0]?.relation_type).toBe("DEPENDS_ON");
    expect(relations[0]?.label).toBe("critical runtime dependency");
    const relatedEntry = relations[0]?.entry as Record<string, unknown>;
    expect(relatedEntry.id).toBe(toId);
    expect(relatedEntry.title).toBe("Target");
  });

  it("returns INVALID_PARAMS for invalid relation_type format", async () => {
    const sub = uniqueUser("rel-invalid-type");
    const sid = await openSession(sub, "rel-tools-invalid");
    const fromId = await createEntry(sub, sid, { title: "From" });
    const toId = await createEntry(sub, sid, { title: "To" });

    const { body } = await callTool(
      "knowledge_create_relation",
      { from_id: fromId, to_id: toId, relation_type: "depends-on" },
      sub,
      sid,
    );
    expect(parseToolError(body).code).toBe(ErrorCode.INVALID_PARAMS);
  });

  it("returns INVALID_PARAMS for self relation", async () => {
    const sub = uniqueUser("rel-self");
    const sid = await openSession(sub, "rel-tools-self");
    const entryId = await createEntry(sub, sid, { title: "Self" });

    const { body } = await callTool(
      "knowledge_create_relation",
      { from_id: entryId, to_id: entryId, relation_type: "CONNECTS_TO" },
      sub,
      sid,
    );
    expect(parseToolError(body).code).toBe(ErrorCode.INVALID_PARAMS);
  });

  it("returns INVALID_PARAMS when entries are in different namespaces", async () => {
    const sub = uniqueUser("rel-cross-ns");
    const sidDefault = await openSession(sub, "rel-default");
    const sidOther = await openSession(sub, "rel-other");
    const fromId = await createEntry(sub, sidDefault, { title: "From" });
    const toId = await createEntry(sub, sidOther, { title: "To" });

    const { body } = await callTool(
      "knowledge_create_relation",
      { from_id: fromId, to_id: toId, relation_type: "CONNECTS_TO" },
      sub,
      sidDefault,
    );
    const err = parseToolError(body);
    expect(err.code).toBe(ErrorCode.INVALID_PARAMS);
    expect(err.message).toBe("Entries must belong to the same namespace");
  });

  it("filters list results where caller cannot read counterpart entry", async () => {
    const owner = uniqueUser("rel-filter-owner");
    const viewer = uniqueUser("rel-filter-viewer");
    const hiddenOwner = uniqueUser("rel-filter-hidden-owner");
    const ownerSid = await openSession(owner, "rel-filter");
    const viewerSid = await openSession(viewer, "rel-filter");
    const hiddenSid = await openSession(hiddenOwner, "rel-filter");

    const anchorId = await createEntry(owner, ownerSid, { title: "Anchor" });
    const visibleId = await createEntry(owner, ownerSid, { title: "Visible" });
    const hiddenId = await createEntry(hiddenOwner, hiddenSid, {
      title: "Hidden",
    });

    await neo4jClient.shareResource(anchorId, viewer, "viewer");
    await neo4jClient.shareResource(visibleId, viewer, "viewer");

    await callTool(
      "knowledge_create_relation",
      { from_id: anchorId, to_id: visibleId, relation_type: "CONNECTS_TO" },
      owner,
      ownerSid,
    );
    await callTool(
      "knowledge_create_relation",
      { from_id: anchorId, to_id: hiddenId, relation_type: "CONNECTS_TO" },
      owner,
      ownerSid,
    );

    const { body } = await callTool(
      "knowledge_list_relations",
      { entry_id: anchorId, direction: "outbound" },
      viewer,
      viewerSid,
    );
    const relations = parseToolSuccess(body).relations as Array<
      Record<string, unknown>
    >;
    expect(relations).toHaveLength(1);
    const relatedEntry = relations[0]?.entry as Record<string, unknown>;
    expect(relatedEntry.id).toBe(visibleId);
  });

  it("deletes relation and no longer shows it in list", async () => {
    const sub = uniqueUser("rel-delete");
    const sid = await openSession(sub, "rel-delete");
    const fromId = await createEntry(sub, sid, { title: "Delete From" });
    const toId = await createEntry(sub, sid, { title: "Delete To" });

    await callTool(
      "knowledge_create_relation",
      { from_id: fromId, to_id: toId, relation_type: "RUNS_ON" },
      sub,
      sid,
    );

    const { status: deleteStatus } = await callTool(
      "knowledge_delete_relation",
      { from_id: fromId, to_id: toId, relation_type: "RUNS_ON" },
      sub,
      sid,
    );
    expect(deleteStatus).toBe(200);

    const { body: listBody } = await callTool(
      "knowledge_list_relations",
      { entry_id: fromId, direction: "outbound" },
      sub,
      sid,
    );
    const relations = parseToolSuccess(listBody).relations as unknown[];
    expect(relations).toHaveLength(0);
  });
});

// ── knowledge_list_namespaces ─────────────────────────────────────────────────

describe("knowledge_list_namespaces", () => {
  it("empty user still includes current session namespace with zero counts", async () => {
    const sub = uniqueUser("ns-empty");
    const sid = await openSession(sub, "my-session-ns");

    const { status, body } = await callTool(
      "knowledge_list_namespaces",
      {},
      sub,
      sid,
    );

    expect(status).toBe(200);
    const result = body.result as Record<string, unknown>;
    expect(result.isError).toBe(false);
    const data = parseToolSuccess(body);
    const namespaces = data.namespaces as Array<Record<string, unknown>>;
    const ns = namespaces.find((n) => n.namespace === "my-session-ns");
    expect(ns).toBeDefined();
    expect(ns?.owned_count).toBe(0);
    expect(ns?.shared_count).toBe(0);
  });

  it("owned-only namespace has correct owned_count and zero shared_count", async () => {
    const sub = uniqueUser("ns-owned");
    const sid = await openSession(sub, "owned-ns");
    await callTool(
      "knowledge_create_entry",
      { entry_type: "note", title: "R1", content: "" },
      sub,
      sid,
    );
    await callTool(
      "knowledge_create_entry",
      { entry_type: "note", title: "R2", content: "" },
      sub,
      sid,
    );

    const { body } = await callTool("knowledge_list_namespaces", {}, sub, sid);
    const namespaces = parseToolSuccess(body).namespaces as Array<
      Record<string, unknown>
    >;
    const ns = namespaces.find((n) => n.namespace === "owned-ns");

    expect(ns).toBeDefined();
    expect(ns?.owned_count).toBe(2);
    expect(ns?.shared_count).toBe(0);
  });

  it("shared-only namespace has zero owned_count and correct shared_count", async () => {
    const owner = uniqueUser("ns-shared-owner");
    const sharer = uniqueUser("ns-shared-user");
    const ownerSid = await openSession(owner, "shared-only-ns");
    const sharerSid = await openSession(sharer, "shared-only-ns");

    const { body: cb1 } = await callTool(
      "knowledge_create_entry",
      { entry_type: "note", title: "S1", content: "" },
      owner,
      ownerSid,
    );
    const { body: cb2 } = await callTool(
      "knowledge_create_entry",
      { entry_type: "note", title: "S2", content: "" },
      owner,
      ownerSid,
    );
    const id1 = parseToolSuccess(cb1).id as string;
    const id2 = parseToolSuccess(cb2).id as string;
    await neo4jClient.shareResource(id1, sharer, "viewer");
    await neo4jClient.shareResource(id2, sharer, "viewer");

    const { body } = await callTool(
      "knowledge_list_namespaces",
      {},
      sharer,
      sharerSid,
    );
    const namespaces = parseToolSuccess(body).namespaces as Array<
      Record<string, unknown>
    >;
    const ns = namespaces.find((n) => n.namespace === "shared-only-ns");

    expect(ns).toBeDefined();
    expect(ns?.owned_count).toBe(0);
    expect(ns?.shared_count).toBe(2);
  });

  it("mixed same namespace has correct owned and shared counts", async () => {
    const owner = uniqueUser("ns-mix-owner");
    const user = uniqueUser("ns-mix-user");
    const ownerSid = await openSession(owner, "mix-ns");
    const userSid = await openSession(user, "mix-ns");

    await callTool(
      "knowledge_create_entry",
      { entry_type: "note", title: "Mine", content: "" },
      user,
      userSid,
    );
    const { body: cb } = await callTool(
      "knowledge_create_entry",
      { entry_type: "note", title: "Theirs", content: "" },
      owner,
      ownerSid,
    );
    const sharedId = parseToolSuccess(cb).id as string;
    await neo4jClient.shareResource(sharedId, user, "viewer");

    const { body } = await callTool(
      "knowledge_list_namespaces",
      {},
      user,
      userSid,
    );
    const namespaces = parseToolSuccess(body).namespaces as Array<
      Record<string, unknown>
    >;
    const ns = namespaces.find((n) => n.namespace === "mix-ns");

    expect(ns).toBeDefined();
    expect(ns?.owned_count).toBe(1);
    expect(ns?.shared_count).toBe(1);
  });

  it("excludes namespaces that belong to unrelated users", async () => {
    const sub = uniqueUser("ns-isolated");
    const other = uniqueUser("ns-isolated-other");
    const sid = await openSession(sub, "isolated-ns");
    const otherSid = await openSession(other, "other-private-ns");
    await callTool(
      "knowledge_create_entry",
      { entry_type: "note", title: "Private", content: "" },
      other,
      otherSid,
    );

    const { body } = await callTool("knowledge_list_namespaces", {}, sub, sid);
    const namespaces = parseToolSuccess(body).namespaces as Array<
      Record<string, unknown>
    >;

    expect(namespaces.some((n) => n.namespace === "other-private-ns")).toBe(
      false,
    );
  });

  it("returns isError false and content with type text containing JSON", async () => {
    const sub = uniqueUser("ns-format");
    const sid = await openSession(sub);

    const { status, body } = await callTool(
      "knowledge_list_namespaces",
      {},
      sub,
      sid,
    );

    expect(status).toBe(200);
    const result = body.result as Record<string, unknown>;
    expect(result.isError).toBe(false);
    const content = result.content as Array<{ type: string; text: string }>;
    expect(content[0]?.type).toBe("text");
    const parsed = JSON.parse(content[0]?.text ?? "") as Record<
      string,
      unknown
    >;
    expect(Array.isArray(parsed.namespaces)).toBe(true);
  });
});

// ── identity and user lookup tools ────────────────────────────────────────────

describe("knowledge_get_current_user", () => {
  it("returns the authenticated user's profile", async () => {
    const sub = uniqueUser("current-user");
    await neo4jClient.upsertUserProfile(
      sub,
      "Current User",
      "current@test.dev",
    );
    const sid = await openSession(sub);

    const { status, body } = await callTool(
      "knowledge_get_current_user",
      {},
      sub,
      sid,
    );

    expect(status).toBe(200);
    const data = parseToolSuccess(body);
    expect(data.user_id).toBe(sub);
    expect(data.name).toBe("Current User");
    expect(data.email).toBe("current@test.dev");
  });
});

describe("knowledge_search_users", () => {
  it("without filters returns only users connected by sharing relationships", async () => {
    const caller = uniqueUser("search-users-caller");
    const owner = uniqueUser("search-users-owner");
    const unrelated = uniqueUser("search-users-unrelated");
    const ownerSid = await openSession(owner);
    const callerSid = await openSession(caller);
    await openSession(unrelated);

    await neo4jClient.upsertUserProfile(
      owner,
      "Owner User",
      "owner@privacy.dev",
    );
    await neo4jClient.upsertUserProfile(
      caller,
      "Caller User",
      "caller@privacy.dev",
    );
    await neo4jClient.upsertUserProfile(
      unrelated,
      "Unrelated User",
      "unrelated@privacy.dev",
    );

    const entryId = await createEntry(owner, ownerSid);
    await neo4jClient.shareResource(entryId, caller, "viewer");

    const { status, body } = await callTool(
      "knowledge_search_users",
      {},
      caller,
      callerSid,
    );

    expect(status).toBe(200);
    const users = parseToolSuccess(body).users as Array<
      Record<string, unknown>
    >;
    expect(users.some((u) => u.user_id === owner)).toBe(true);
    expect(users.some((u) => u.user_id === unrelated)).toBe(false);
  });

  it("exact email lookup can find a user outside the sharing graph", async () => {
    const caller = uniqueUser("search-users-exact-caller");
    const outsider = uniqueUser("search-users-exact-outsider");
    const sid = await openSession(caller);
    await openSession(outsider);
    await neo4jClient.upsertUserProfile(
      outsider,
      "Exact Match User",
      "exact.user@privacy.dev",
    );

    const { status, body } = await callTool(
      "knowledge_search_users",
      { email: "EXACT.USER@PRIVACY.DEV" },
      caller,
      sid,
    );

    expect(status).toBe(200);
    const users = parseToolSuccess(body).users as Array<
      Record<string, unknown>
    >;
    expect(users.some((u) => u.user_id === outsider)).toBe(true);
  });

  it("partial lookup no longer reveals users globally", async () => {
    const caller = uniqueUser("search-users-partial-caller");
    const outsider = uniqueUser("search-users-partial-outsider");
    const sid = await openSession(caller);
    await openSession(outsider);
    await neo4jClient.upsertUserProfile(
      outsider,
      "Partial Hidden",
      "partial.hidden@privacy.dev",
    );

    const { status, body } = await callTool(
      "knowledge_search_users",
      { email: "partial" },
      caller,
      sid,
    );

    expect(status).toBe(200);
    const users = parseToolSuccess(body).users as Array<
      Record<string, unknown>
    >;
    expect(users.some((u) => u.user_id === outsider)).toBe(false);
  });
});

// ── namespace auto-share config tools ─────────────────────────────────────────

describe("namespace auto-share config", () => {
  it("returns default config when none exists", async () => {
    const sub = uniqueUser("ns-config-default");
    const sid = await openSession(sub, "auto-share-ns");

    const { status, body } = await callTool(
      "knowledge_get_namespace_config",
      {},
      sub,
      sid,
    );

    expect(status).toBe(200);
    const data = parseToolSuccess(body);
    expect(data.namespace).toBe("auto-share-ns");
    expect(data.auto_share).toBe(false);
    expect(data.auto_share_permission).toBe("read");
    expect(data.auto_share_user_ids).toEqual([]);
  });

  it("create entry auto-shares to configured users and reports metadata", async () => {
    const owner = uniqueUser("auto-share-owner");
    const target = uniqueUser("auto-share-target");

    await neo4jClient.upsertUserProfile(owner, "Owner", "owner@auto.dev");
    await neo4jClient.upsertUserProfile(target, "Target", "target@auto.dev");

    const ownerSid = await openSession(owner, "auto-share-enabled-ns");
    const targetSid = await openSession(target, "auto-share-enabled-ns");

    const { status: updateStatus } = await callTool(
      "knowledge_update_namespace_config",
      {
        auto_share: true,
        auto_share_permission: "read",
        auto_share_user_ids: [target],
      },
      owner,
      ownerSid,
    );
    expect(updateStatus).toBe(200);

    const { status, body } = await callTool(
      "knowledge_create_entry",
      { entry_type: "note", title: "Auto Shared", content: "payload" },
      owner,
      ownerSid,
    );
    expect(status).toBe(200);

    const created = parseToolSuccess(body);
    const autoShare = created.auto_share as Record<string, unknown> | undefined;
    expect(autoShare?.enabled).toBe(true);
    expect(autoShare?.shared_with_count).toBe(1);
    expect(autoShare?.shared_with).toEqual([target]);

    const { body: getBody } = await callTool(
      "knowledge_get_entry",
      { entry_id: created.id as string },
      target,
      targetSid,
    );
    expect(parseToolSuccess(getBody).role).toBe("viewer");
  });

  it("updates namespace config without per-user getUser lookups", async () => {
    const owner = uniqueUser("ns-config-batch-owner");
    const targetA = uniqueUser("ns-config-batch-target-a");
    const targetB = uniqueUser("ns-config-batch-target-b");

    await neo4jClient.upsertUserProfile(owner, "Owner", "owner@batch.dev");
    await neo4jClient.upsertUserProfile(targetA, "Target A", "a@batch.dev");
    await neo4jClient.upsertUserProfile(targetB, "Target B", "b@batch.dev");

    const ownerSid = await openSession(owner, "batch-ns");
    const getUserSpy = vi
      .spyOn(neo4jClient, "getUser")
      .mockRejectedValue(
        new Error(
          "knowledge_update_namespace_config must not call getUser per target",
        ),
      );

    try {
      const { status, body } = await callTool(
        "knowledge_update_namespace_config",
        {
          auto_share: true,
          auto_share_permission: "read",
          auto_share_user_ids: [targetA, targetB],
        },
        owner,
        ownerSid,
      );

      expect(status).toBe(200);
      const data = parseToolSuccess(body);
      expect(data.auto_share).toBe(true);
      expect(data.auto_share_user_ids).toEqual([targetA, targetB]);
      expect(getUserSpy).not.toHaveBeenCalled();
    } finally {
      getUserSpy.mockRestore();
    }
  });

  it("auto-share on create does not perform per-user getUser lookups", async () => {
    const owner = uniqueUser("auto-share-batch-owner");
    const targetA = uniqueUser("auto-share-batch-target-a");
    const targetB = uniqueUser("auto-share-batch-target-b");

    await neo4jClient.upsertUserProfile(owner, "Owner", "owner@autobatch.dev");
    await neo4jClient.upsertUserProfile(targetA, "Target A", "a@autobatch.dev");
    await neo4jClient.upsertUserProfile(targetB, "Target B", "b@autobatch.dev");

    const ownerSid = await openSession(owner, "auto-share-batch-ns");
    const { status: updateStatus } = await callTool(
      "knowledge_update_namespace_config",
      {
        auto_share: true,
        auto_share_permission: "read",
        auto_share_user_ids: [targetA, targetB],
      },
      owner,
      ownerSid,
    );
    expect(updateStatus).toBe(200);

    const getUserSpy = vi
      .spyOn(neo4jClient, "getUser")
      .mockRejectedValue(
        new Error(
          "knowledge_create_entry auto-share must not call getUser per target",
        ),
      );

    try {
      const { status, body } = await callTool(
        "knowledge_create_entry",
        {
          entry_type: "note",
          title: "Batched Auto Share",
          content: "payload",
        },
        owner,
        ownerSid,
      );

      expect(status).toBe(200);
      const created = parseToolSuccess(body);
      const autoShare = created.auto_share as
        | Record<string, unknown>
        | undefined;
      expect(autoShare?.enabled).toBe(true);
      expect(autoShare?.shared_with_count).toBe(2);
      expect(autoShare?.shared_with).toEqual([targetA, targetB]);
      expect(getUserSpy).not.toHaveBeenCalled();
    } finally {
      getUserSpy.mockRestore();
    }
  });
});

// ── Full lifecycle ────────────────────────────────────────────────────────────

describe("full lifecycle", () => {
  it("create → get → list → update → get updated → delete → gone", async () => {
    const sub = uniqueUser("lifecycle");
    const sid = await openSession(sub);

    // create
    const { body: cb } = await callTool(
      "knowledge_create_entry",
      { entry_type: "note", title: "Lifecycle", content: "v1" },
      sub,
      sid,
    );
    const id = parseToolSuccess(cb).id as string;
    expect(typeof id).toBe("string");

    // get
    const { body: gb1 } = await callTool(
      "knowledge_get_entry",
      { entry_id: id },
      sub,
      sid,
    );
    expect(parseToolSuccess(gb1).title).toBe("Lifecycle");
    expect(parseToolSuccess(gb1).role).toBe("owner");

    // list — resource appears
    const { body: lb } = await callTool("knowledge_list_entries", {}, sub, sid);
    const resources = parseToolSuccess(lb).resources as Array<
      Record<string, unknown>
    >;
    expect(resources.some((r) => r.id === id)).toBe(true);

    // update
    await callTool(
      "knowledge_update_entry",
      { entry_id: id, title: "Lifecycle v2", content: "v2" },
      sub,
      sid,
    );

    // get updated
    const { body: gb2 } = await callTool(
      "knowledge_get_entry",
      { entry_id: id },
      sub,
      sid,
    );
    expect(parseToolSuccess(gb2).title).toBe("Lifecycle v2");
    expect(parseToolSuccess(gb2).content).toBe("v2");

    // delete
    const { status: ds } = await callTool(
      "knowledge_delete_entry",
      { entry_id: id },
      sub,
      sid,
    );
    expect(ds).toBe(200);

    // confirm gone
    const { body: gb3 } = await callTool(
      "knowledge_get_entry",
      { entry_id: id },
      sub,
      sid,
    );
    expect(parseToolError(gb3).code).toBe(ErrorCode.RESOURCE_NOT_FOUND);
  });
});

// ── above-cap parameter rejection ────────────────────────────────────────────

describe("above-cap parameter rejection", () => {
  it("knowledge_expand_context: max_hops above cap returns INVALID_PARAMS", async () => {
    const sub = uniqueUser("cap-hops");
    const sid = await openSession(sub, "cap-ns");
    const entryId = await createEntry(sub, sid, { title: "Anchor" });

    const { body } = await callTool(
      "knowledge_expand_context",
      { entry_id: entryId, max_hops: 5 }, // cap is 4
      sub,
      sid,
    );
    expect(parseToolError(body).code).toBe(ErrorCode.INVALID_PARAMS);
  });

  it("knowledge_expand_context: limit above cap returns INVALID_PARAMS", async () => {
    const sub = uniqueUser("cap-expand-limit");
    const sid = await openSession(sub, "cap-ns");
    const entryId = await createEntry(sub, sid, { title: "Anchor" });

    const { body } = await callTool(
      "knowledge_expand_context",
      { entry_id: entryId, limit: 201 }, // cap is 200
      sub,
      sid,
    );
    expect(parseToolError(body).code).toBe(ErrorCode.INVALID_PARAMS);
  });

  it("knowledge_find_paths: max_depth above cap returns INVALID_PARAMS", async () => {
    const sub = uniqueUser("cap-depth");
    const sid = await openSession(sub, "cap-ns");
    const fromId = await createEntry(sub, sid, { title: "From" });
    const toId = await createEntry(sub, sid, { title: "To" });

    const { body } = await callTool(
      "knowledge_find_paths",
      { from_id: fromId, to_id: toId, max_depth: 7 }, // cap is 6
      sub,
      sid,
    );
    expect(parseToolError(body).code).toBe(ErrorCode.INVALID_PARAMS);
  });

  it("knowledge_find_paths: max_paths above cap returns INVALID_PARAMS", async () => {
    const sub = uniqueUser("cap-paths");
    const sid = await openSession(sub, "cap-ns");
    const fromId = await createEntry(sub, sid, { title: "From" });
    const toId = await createEntry(sub, sid, { title: "To" });

    const { body } = await callTool(
      "knowledge_find_paths",
      { from_id: fromId, to_id: toId, max_paths: 11 }, // cap is 10
      sub,
      sid,
    );
    expect(parseToolError(body).code).toBe(ErrorCode.INVALID_PARAMS);
  });

  it("knowledge_impact_analysis: max_depth above cap returns INVALID_PARAMS", async () => {
    const sub = uniqueUser("cap-impact-depth");
    const sid = await openSession(sub, "cap-ns");
    const entryId = await createEntry(sub, sid, { title: "Anchor" });

    const { body } = await callTool(
      "knowledge_impact_analysis",
      { entry_id: entryId, max_depth: 7 }, // cap is 6
      sub,
      sid,
    );
    expect(parseToolError(body).code).toBe(ErrorCode.INVALID_PARAMS);
  });

  it("knowledge_impact_analysis: limit above cap returns INVALID_PARAMS", async () => {
    const sub = uniqueUser("cap-impact-limit");
    const sid = await openSession(sub, "cap-ns");
    const entryId = await createEntry(sub, sid, { title: "Anchor" });

    const { body } = await callTool(
      "knowledge_impact_analysis",
      { entry_id: entryId, limit: 201 }, // cap is 200
      sub,
      sid,
    );
    expect(parseToolError(body).code).toBe(ErrorCode.INVALID_PARAMS);
  });

  it("knowledge_list_relations: limit above cap returns INVALID_PARAMS", async () => {
    const sub = uniqueUser("cap-rel-limit");
    const sid = await openSession(sub, "cap-ns");
    const entryId = await createEntry(sub, sid, { title: "Anchor" });

    const { body } = await callTool(
      "knowledge_list_relations",
      { entry_id: entryId, limit: 501 }, // cap is 500
      sub,
      sid,
    );
    expect(parseToolError(body).code).toBe(ErrorCode.INVALID_PARAMS);
  });
});

// ── knowledge_list_relations limit ───────────────────────────────────────────

describe("knowledge_list_relations with limit", () => {
  it("respects limit parameter", async () => {
    const sub = uniqueUser("list-rel-limit");
    const sid = await openSession(sub, "list-rel-limit-ns");
    const anchorId = await createEntry(sub, sid, { title: "Anchor" });

    for (let i = 0; i < 4; i++) {
      const nId = await createEntry(sub, sid, { title: `Node${i}` });
      await callTool(
        "knowledge_create_relation",
        { from_id: anchorId, to_id: nId, relation_type: "CONNECTS_TO" },
        sub,
        sid,
      );
    }

    const { body } = await callTool(
      "knowledge_list_relations",
      { entry_id: anchorId, direction: "outbound", limit: 2 },
      sub,
      sid,
    );
    const relations = parseToolSuccess(body).relations as unknown[];
    expect(relations).toHaveLength(2);
  });
});

// ── knowledge_expand_context ──────────────────────────────────────────────────

describe("knowledge_expand_context", () => {
  it("returns RESOURCE_NOT_FOUND for a non-existent entry", async () => {
    const sub = uniqueUser("expand-notfound");
    const sid = await openSession(sub);

    const { body } = await callTool(
      "knowledge_expand_context",
      { entry_id: "00000000-0000-0000-0000-000000000000" },
      sub,
      sid,
    );
    expect(parseToolError(body).code).toBe(ErrorCode.RESOURCE_NOT_FOUND);
  });

  it("returns INVALID_PARAMS for invalid relation_type in relation_types", async () => {
    const sub = uniqueUser("expand-bad-reltype");
    const sid = await openSession(sub, "expand-bad-ns");
    const entryId = await createEntry(sub, sid, { title: "Anchor" });

    const { body } = await callTool(
      "knowledge_expand_context",
      { entry_id: entryId, relation_types: ["invalid-type"] },
      sub,
      sid,
    );
    expect(parseToolError(body).code).toBe(ErrorCode.INVALID_PARAMS);
  });

  it("returns layers with distance and entries for connected nodes", async () => {
    const sub = uniqueUser("expand-layers");
    const sid = await openSession(sub, "expand-layers-ns");
    const anchorId = await createEntry(sub, sid, { title: "Anchor" });
    const childId = await createEntry(sub, sid, { title: "Child" });

    await callTool(
      "knowledge_create_relation",
      { from_id: anchorId, to_id: childId, relation_type: "DEPENDS_ON" },
      sub,
      sid,
    );

    const { status, body } = await callTool(
      "knowledge_expand_context",
      { entry_id: anchorId, direction: "outbound" },
      sub,
      sid,
    );
    expect(status).toBe(200);
    const data = parseToolSuccess(body);
    const layers = data.layers as Array<{
      distance: number;
      entries: Array<{ id: string; title: string }>;
    }>;
    expect(layers.length).toBeGreaterThanOrEqual(1);
    const layer1 = layers.find((l) => l.distance === 1);
    expect(layer1).toBeDefined();
    expect(layer1?.entries.some((e) => e.id === childId)).toBe(true);
  });

  it("filters by relation_types", async () => {
    const sub = uniqueUser("expand-rel-filter");
    const sid = await openSession(sub, "expand-relfilter-ns");
    const anchorId = await createEntry(sub, sid, { title: "Anchor" });
    const depId = await createEntry(sub, sid, { title: "Dep" });
    const refId = await createEntry(sub, sid, { title: "Ref" });

    await callTool(
      "knowledge_create_relation",
      { from_id: anchorId, to_id: depId, relation_type: "DEPENDS_ON" },
      sub,
      sid,
    );
    await callTool(
      "knowledge_create_relation",
      { from_id: anchorId, to_id: refId, relation_type: "REFERENCES" },
      sub,
      sid,
    );

    const { body } = await callTool(
      "knowledge_expand_context",
      {
        entry_id: anchorId,
        direction: "outbound",
        relation_types: ["DEPENDS_ON"],
      },
      sub,
      sid,
    );
    const layers = parseToolSuccess(body).layers as Array<{
      distance: number;
      entries: Array<{ id: string }>;
    }>;
    const allIds = layers.flatMap((l) => l.entries.map((e) => e.id));
    expect(allIds).toContain(depId);
    expect(allIds).not.toContain(refId);
  });

  it("returns empty layers for isolated entry", async () => {
    const sub = uniqueUser("expand-isolated");
    const sid = await openSession(sub, "expand-isolated-ns");
    const entryId = await createEntry(sub, sid, { title: "Isolated" });

    const { body } = await callTool(
      "knowledge_expand_context",
      { entry_id: entryId },
      sub,
      sid,
    );
    const layers = parseToolSuccess(body).layers as unknown[];
    expect(layers).toHaveLength(0);
  });
});

// ── knowledge_find_paths ──────────────────────────────────────────────────────

describe("knowledge_find_paths", () => {
  it("returns INVALID_PARAMS when from_id equals to_id", async () => {
    const sub = uniqueUser("paths-self");
    const sid = await openSession(sub, "paths-self-ns");
    const entryId = await createEntry(sub, sid, { title: "Self" });

    const { body } = await callTool(
      "knowledge_find_paths",
      { from_id: entryId, to_id: entryId },
      sub,
      sid,
    );
    expect(parseToolError(body).code).toBe(ErrorCode.INVALID_PARAMS);
  });

  it("returns RESOURCE_NOT_FOUND when an entry does not exist", async () => {
    const sub = uniqueUser("paths-notfound");
    const sid = await openSession(sub, "paths-notfound-ns");
    const entryId = await createEntry(sub, sid, { title: "Exists" });

    const { body } = await callTool(
      "knowledge_find_paths",
      { from_id: entryId, to_id: "00000000-0000-0000-0000-000000000000" },
      sub,
      sid,
    );
    expect(parseToolError(body).code).toBe(ErrorCode.RESOURCE_NOT_FOUND);
  });

  it("returns paths with nodes and relations for a connected pair", async () => {
    const sub = uniqueUser("paths-found");
    const sid = await openSession(sub, "paths-found-ns");
    const fromId = await createEntry(sub, sid, { title: "From" });
    const toId = await createEntry(sub, sid, { title: "To" });

    await callTool(
      "knowledge_create_relation",
      {
        from_id: fromId,
        to_id: toId,
        relation_type: "DEPENDS_ON",
        label: "hard dep",
      },
      sub,
      sid,
    );

    const { status, body } = await callTool(
      "knowledge_find_paths",
      { from_id: fromId, to_id: toId },
      sub,
      sid,
    );
    expect(status).toBe(200);
    const data = parseToolSuccess(body);
    const paths = data.paths as Array<{
      nodes: Array<{ id: string; title: string; entry_type: string }>;
      relations: Array<{
        relation_type: string;
        label?: string;
        from_id: string;
        to_id: string;
      }>;
      formatted: string;
    }>;
    expect(paths.length).toBeGreaterThanOrEqual(1);
    const path = paths[0];
    expect(path).toBeDefined();
    if (!path) throw new Error("Expected a path");
    expect(path.nodes[0]?.id).toBe(fromId);
    expect(path.nodes[path.nodes.length - 1]?.id).toBe(toId);
    expect(path.nodes[0]?.entry_type).toBe("note");
    expect(path.relations[0]?.relation_type).toBe("DEPENDS_ON");
    expect(path.relations[0]?.label).toBe("hard dep");
    expect(path.relations[0]?.from_id).toBe(fromId);
    expect(path.relations[0]?.to_id).toBe(toId);
    expect(typeof path.formatted).toBe("string");
    expect(path.formatted).toContain("From");
    expect(path.formatted).toContain("To");
  });

  it("returns empty paths array when no directed path exists", async () => {
    const sub = uniqueUser("paths-none-tool");
    const sid = await openSession(sub, "paths-none-ns");
    const fromId = await createEntry(sub, sid, { title: "A" });
    const toId = await createEntry(sub, sid, { title: "B" });

    const { body } = await callTool(
      "knowledge_find_paths",
      { from_id: fromId, to_id: toId },
      sub,
      sid,
    );
    const paths = parseToolSuccess(body).paths as unknown[];
    expect(paths).toHaveLength(0);
  });

  it("returns INVALID_PARAMS for invalid relation_type in relation_types", async () => {
    const sub = uniqueUser("paths-bad-reltype");
    const sid = await openSession(sub, "paths-bad-ns");
    const fromId = await createEntry(sub, sid, { title: "From" });
    const toId = await createEntry(sub, sid, { title: "To" });

    const { body } = await callTool(
      "knowledge_find_paths",
      { from_id: fromId, to_id: toId, relation_types: ["bad-type"] },
      sub,
      sid,
    );
    expect(parseToolError(body).code).toBe(ErrorCode.INVALID_PARAMS);
  });

  it("direction:both finds path across reversed edges; direction:outbound returns empty+hint", async () => {
    // Topology: A <-[CONNECTS_TO]- Mid -[CONNECTS_TO]-> B
    // Outbound from A→B skips this, but undirected finds it.
    const sub = uniqueUser("paths-dir");
    const sid = await openSession(sub, "paths-dir-ns");
    const aId = await createEntry(sub, sid, { title: "A" });
    const midId = await createEntry(sub, sid, { title: "Mid" });
    const bId = await createEntry(sub, sid, { title: "B" });

    // Mid → A and Mid → B (so A←Mid→B)
    await callTool(
      "knowledge_create_relation",
      { from_id: midId, to_id: aId, relation_type: "CONNECTS_TO" },
      sub,
      sid,
    );
    await callTool(
      "knowledge_create_relation",
      { from_id: midId, to_id: bId, relation_type: "CONNECTS_TO" },
      sub,
      sid,
    );

    // direction:"both" should find A→Mid→B path
    const { body: bothBody } = await callTool(
      "knowledge_find_paths",
      { from_id: aId, to_id: bId, direction: "both" },
      sub,
      sid,
    );
    const bothData = parseToolSuccess(bothBody);
    const bothPaths = bothData.paths as unknown[];
    expect(bothPaths.length).toBeGreaterThanOrEqual(1);

    // direction:"outbound" from A→B should return empty paths + hint
    const { body: outBody } = await callTool(
      "knowledge_find_paths",
      { from_id: aId, to_id: bId, direction: "outbound" },
      sub,
      sid,
    );
    const outData = parseToolSuccess(outBody);
    expect(outData.paths as unknown[]).toHaveLength(0);
    expect(typeof outData.hint).toBe("string");
    expect(outData.hint as string).toContain("outbound");
  });
});

// ── knowledge_explain_relationship ────────────────────────────────────────────

describe("knowledge_explain_relationship", () => {
  it("returns INVALID_PARAMS when entry_a_id equals entry_b_id", async () => {
    const sub = uniqueUser("explain-self");
    const sid = await openSession(sub, "explain-self-ns");
    const entryId = await createEntry(sub, sid, { title: "Self" });

    const { body } = await callTool(
      "knowledge_explain_relationship",
      { entry_a_id: entryId, entry_b_id: entryId },
      sub,
      sid,
    );
    expect(parseToolError(body).code).toBe(ErrorCode.INVALID_PARAMS);
  });

  it("returns INVALID_PARAMS when max_depth exceeds cap", async () => {
    const sub = uniqueUser("explain-cap");
    const sid = await openSession(sub, "explain-cap-ns");
    const aId = await createEntry(sub, sid, { title: "A" });
    const bId = await createEntry(sub, sid, { title: "B" });

    const { body } = await callTool(
      "knowledge_explain_relationship",
      { entry_a_id: aId, entry_b_id: bId, max_depth: 7 }, // cap is 6
      sub,
      sid,
    );
    expect(parseToolError(body).code).toBe(ErrorCode.INVALID_PARAMS);
  });

  it("returns direct_relations populated for a directly connected pair", async () => {
    const sub = uniqueUser("explain-direct");
    const sid = await openSession(sub, "explain-direct-ns");
    const aId = await createEntry(sub, sid, { title: "NAS" });
    const bId = await createEntry(sub, sid, { title: "Router" });

    await callTool(
      "knowledge_create_relation",
      { from_id: aId, to_id: bId, relation_type: "CONNECTS_TO" },
      sub,
      sid,
    );

    const { status, body } = await callTool(
      "knowledge_explain_relationship",
      { entry_a_id: aId, entry_b_id: bId },
      sub,
      sid,
    );
    expect(status).toBe(200);
    const data = parseToolSuccess(body);
    expect(data.connected).toBe(true);
    const directRels = data.direct_relations as Array<{
      relation_type: string;
      direction: "a_to_b" | "b_to_a";
    }>;
    expect(directRels.length).toBeGreaterThanOrEqual(1);
    expect(directRels[0]?.relation_type).toBe("CONNECTS_TO");
    expect(directRels[0]?.direction).toBe("a_to_b");
  });

  it("returns connected:true with formatted path for indirect 2-hop connection", async () => {
    const sub = uniqueUser("explain-indirect");
    const sid = await openSession(sub, "explain-indirect-ns");
    const nasId = await createEntry(sub, sid, { title: "NAS" });
    const midId = await createEntry(sub, sid, { title: "Management VM" });
    const pikvmId = await createEntry(sub, sid, { title: "PiKVM" });

    // Mid → NAS and Mid → PiKVM (NAS ←[MANAGED_BY]— Mid —[CONNECTS_TO]→ PiKVM)
    await callTool(
      "knowledge_create_relation",
      { from_id: midId, to_id: nasId, relation_type: "MANAGED_BY" },
      sub,
      sid,
    );
    await callTool(
      "knowledge_create_relation",
      { from_id: midId, to_id: pikvmId, relation_type: "CONNECTS_TO" },
      sub,
      sid,
    );

    const { status, body } = await callTool(
      "knowledge_explain_relationship",
      { entry_a_id: nasId, entry_b_id: pikvmId },
      sub,
      sid,
    );
    expect(status).toBe(200);
    const data = parseToolSuccess(body);
    expect(data.connected).toBe(true);
    const paths = data.paths as Array<{ formatted: string; nodes: unknown[] }>;
    expect(paths.length).toBeGreaterThanOrEqual(1);
    // formatted should contain all three node titles
    const formatted = paths[0]?.formatted ?? "";
    expect(formatted).toContain("NAS");
    expect(formatted).toContain("Management VM");
    expect(formatted).toContain("PiKVM");
  });

  it("returns connected:false with empty paths for unconnected entries", async () => {
    const sub = uniqueUser("explain-noconn");
    const sid = await openSession(sub, "explain-noconn-ns");
    const aId = await createEntry(sub, sid, { title: "Island A" });
    const bId = await createEntry(sub, sid, { title: "Island B" });

    const { status, body } = await callTool(
      "knowledge_explain_relationship",
      { entry_a_id: aId, entry_b_id: bId },
      sub,
      sid,
    );
    expect(status).toBe(200);
    const data = parseToolSuccess(body);
    expect(data.connected).toBe(false);
    expect(data.direct_relations as unknown[]).toHaveLength(0);
    expect(data.paths as unknown[]).toHaveLength(0);
  });

  it("max_paths:1 returns exactly one path", async () => {
    // topology: A←Mid→B creates exactly one 2-hop path between A and B
    const sub = uniqueUser("explain-maxpaths");
    const sid = await openSession(sub, "explain-maxpaths-ns");
    const aId = await createEntry(sub, sid, { title: "AlphaNode" });
    const midId = await createEntry(sub, sid, { title: "MidNode" });
    const bId = await createEntry(sub, sid, { title: "BetaNode" });
    await callTool(
      "knowledge_create_relation",
      { from_id: midId, to_id: aId, relation_type: "CONNECTS_TO" },
      sub,
      sid,
    );
    await callTool(
      "knowledge_create_relation",
      { from_id: midId, to_id: bId, relation_type: "CONNECTS_TO" },
      sub,
      sid,
    );

    const { status, body } = await callTool(
      "knowledge_explain_relationship",
      { entry_a_id: aId, entry_b_id: bId, max_paths: 1 },
      sub,
      sid,
    );
    expect(status).toBe(200);
    const data = parseToolSuccess(body);
    expect(data.paths as unknown[]).toHaveLength(1);
  });

  it("max_paths above cap returns INVALID_PARAMS", async () => {
    const sub = uniqueUser("explain-maxpaths-cap");
    const sid = await openSession(sub, "explain-maxpaths-cap-ns");
    const aId = await createEntry(sub, sid, { title: "A" });
    const bId = await createEntry(sub, sid, { title: "B" });

    const { body } = await callTool(
      "knowledge_explain_relationship",
      { entry_a_id: aId, entry_b_id: bId, max_paths: 11 }, // cap is 10
      sub,
      sid,
    );
    expect(parseToolError(body).code).toBe(ErrorCode.INVALID_PARAMS);
  });
});

// ── knowledge_get_entry relation_summary ──────────────────────────────────────

describe("knowledge_get_entry relation_summary", () => {
  it("returns relation_summary with correct outbound/inbound/total counts", async () => {
    const sub = uniqueUser("get-relsummary");
    const sid = await openSession(sub, "get-relsummary-ns");
    const hubId = await createEntry(sub, sid, { title: "Hub" });
    const out1Id = await createEntry(sub, sid, { title: "Out1" });
    const out2Id = await createEntry(sub, sid, { title: "Out2" });
    const in1Id = await createEntry(sub, sid, { title: "In1" });
    await callTool(
      "knowledge_create_relation",
      { from_id: hubId, to_id: out1Id, relation_type: "CONNECTS_TO" },
      sub,
      sid,
    );
    await callTool(
      "knowledge_create_relation",
      { from_id: hubId, to_id: out2Id, relation_type: "CONNECTS_TO" },
      sub,
      sid,
    );
    await callTool(
      "knowledge_create_relation",
      { from_id: in1Id, to_id: hubId, relation_type: "DEPENDS_ON" },
      sub,
      sid,
    );

    const { status, body } = await callTool(
      "knowledge_get_entry",
      { entry_id: hubId },
      sub,
      sid,
    );
    expect(status).toBe(200);
    const data = parseToolSuccess(body);
    const rs = data.relation_summary as {
      outbound: number;
      inbound: number;
      total: number;
    };
    expect(rs.outbound).toBe(2);
    expect(rs.inbound).toBe(1);
    expect(rs.total).toBe(3);
  });

  it("returns relation_summary all zeros for an isolated entry", async () => {
    const sub = uniqueUser("get-relsummary-isolated");
    const sid = await openSession(sub, "get-relsummary-isolated-ns");
    const entryId = await createEntry(sub, sid, { title: "Isolated" });

    const { status, body } = await callTool(
      "knowledge_get_entry",
      { entry_id: entryId },
      sub,
      sid,
    );
    expect(status).toBe(200);
    const data = parseToolSuccess(body);
    const rs = data.relation_summary as {
      outbound: number;
      inbound: number;
      total: number;
    };
    expect(rs.outbound).toBe(0);
    expect(rs.inbound).toBe(0);
    expect(rs.total).toBe(0);
  });
});

// ── knowledge_impact_analysis ─────────────────────────────────────────────────

describe("knowledge_impact_analysis", () => {
  it("returns RESOURCE_NOT_FOUND for a non-existent entry", async () => {
    const sub = uniqueUser("impact-notfound");
    const sid = await openSession(sub);

    const { body } = await callTool(
      "knowledge_impact_analysis",
      { entry_id: "00000000-0000-0000-0000-000000000000" },
      sub,
      sid,
    );
    expect(parseToolError(body).code).toBe(ErrorCode.RESOURCE_NOT_FOUND);
  });

  it("returns layers and total_impacted for dependent entries", async () => {
    const sub = uniqueUser("impact-basic");
    const sid = await openSession(sub, "impact-basic-ns");
    const anchorId = await createEntry(sub, sid, { title: "Anchor" });
    const depId = await createEntry(sub, sid, { title: "Dependent" });

    await callTool(
      "knowledge_create_relation",
      { from_id: depId, to_id: anchorId, relation_type: "DEPENDS_ON" },
      sub,
      sid,
    );

    const { status, body } = await callTool(
      "knowledge_impact_analysis",
      { entry_id: anchorId },
      sub,
      sid,
    );
    expect(status).toBe(200);
    const data = parseToolSuccess(body);
    const layers = data.layers as Array<{
      distance: number;
      entries: Array<{ id: string }>;
    }>;
    const totalImpacted = data.total_impacted as number;

    expect(layers.length).toBeGreaterThanOrEqual(1);
    const layer1 = layers.find((l) => l.distance === 1);
    expect(layer1?.entries.some((e) => e.id === depId)).toBe(true);
    expect(totalImpacted).toBeGreaterThanOrEqual(1);
    expect(totalImpacted).toBe(
      layers.reduce((sum, l) => sum + l.entries.length, 0),
    );
  });

  it("returns empty layers and total_impacted 0 for an isolated entry", async () => {
    const sub = uniqueUser("impact-isolated");
    const sid = await openSession(sub, "impact-isolated-ns");
    const entryId = await createEntry(sub, sid, { title: "Isolated" });

    const { body } = await callTool(
      "knowledge_impact_analysis",
      { entry_id: entryId },
      sub,
      sid,
    );
    const data = parseToolSuccess(body);
    expect(data.layers).toHaveLength(0);
    expect(data.total_impacted).toBe(0);
  });

  it("returns INVALID_PARAMS for invalid relation_type in relation_types", async () => {
    const sub = uniqueUser("impact-bad-reltype");
    const sid = await openSession(sub, "impact-bad-ns");
    const entryId = await createEntry(sub, sid, { title: "Entry" });

    const { body } = await callTool(
      "knowledge_impact_analysis",
      { entry_id: entryId, relation_types: ["bad-type"] },
      sub,
      sid,
    );
    expect(parseToolError(body).code).toBe(ErrorCode.INVALID_PARAMS);
  });
});

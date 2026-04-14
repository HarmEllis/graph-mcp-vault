import { Hono } from "hono";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  OidcMetadataClient,
  createOAuthMetaRouter,
} from "../src/routers/oauth-meta.js";

// ── Fixtures ──────────────────────────────────────────────────────────────────

const ISSUER = "https://oidc.example.com";

const UPSTREAM_METADATA = {
  issuer: ISSUER,
  authorization_endpoint: `${ISSUER}/authorize`,
  token_endpoint: `${ISSUER}/token`,
  jwks_uri: `${ISSUER}/.well-known/jwks.json`,
  scopes_supported: ["openid", "profile", "email"],
  response_types_supported: ["code"],
  grant_types_supported: ["authorization_code"],
  code_challenge_methods_supported: ["S256"],
};

const DISCOVERY_URL = `${ISSUER}/.well-known/openid-configuration`;

function stubFetch(
  body: object,
  { ok = true, status = 200 }: { ok?: boolean; status?: number } = {},
): ReturnType<typeof vi.fn> {
  const mock = vi
    .fn()
    .mockResolvedValue({ ok, status, json: async () => body });
  vi.stubGlobal("fetch", mock);
  return mock;
}

afterEach(() => {
  vi.restoreAllMocks();
});

// ── OidcMetadataClient ────────────────────────────────────────────────────────

describe("OidcMetadataClient", () => {
  it("fetches the upstream discovery document on first call", async () => {
    const fetchMock = stubFetch(UPSTREAM_METADATA);
    const client = new OidcMetadataClient(ISSUER, 3_600_000);

    await client.getMetadata();

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock).toHaveBeenCalledWith(DISCOVERY_URL);
  });

  it("returns the upstream metadata document", async () => {
    stubFetch(UPSTREAM_METADATA);
    const client = new OidcMetadataClient(ISSUER, 3_600_000);

    const metadata = await client.getMetadata();

    expect(metadata).toEqual(UPSTREAM_METADATA);
  });

  it("serves subsequent calls from the cache without re-fetching", async () => {
    const fetchMock = stubFetch(UPSTREAM_METADATA);
    const client = new OidcMetadataClient(ISSUER, 3_600_000);

    await client.getMetadata();
    await client.getMetadata();
    await client.getMetadata();

    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("re-fetches when the cache TTL has elapsed", async () => {
    const fetchMock = stubFetch(UPSTREAM_METADATA);
    const client = new OidcMetadataClient(ISSUER, 0); // 0 ms TTL → always stale

    await client.getMetadata();
    await client.getMetadata();

    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("throws when the upstream returns a non-OK response", async () => {
    stubFetch({}, { ok: false, status: 503 });
    const client = new OidcMetadataClient(ISSUER, 3_600_000);

    await expect(client.getMetadata()).rejects.toThrow("503");
  });

  it("does not cache a failed response — retries on the next call", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, status: 503, json: async () => ({}) })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => UPSTREAM_METADATA,
      });
    vi.stubGlobal("fetch", fetchMock);

    const client = new OidcMetadataClient(ISSUER, 3_600_000);

    await expect(client.getMetadata()).rejects.toThrow();
    const metadata = await client.getMetadata(); // second call should succeed

    expect(metadata).toEqual(UPSTREAM_METADATA);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

// ── createOAuthMetaRouter ─────────────────────────────────────────────────────

function buildApp(
  ttlMs = 3_600_000,
  scopesAllowlist?: string[],
  discoveryUrl?: string,
): { app: Hono; client: OidcMetadataClient } {
  const client = new OidcMetadataClient(ISSUER, ttlMs, discoveryUrl);
  const router = createOAuthMetaRouter(client, scopesAllowlist);
  const app = new Hono();
  app.route("/", router);
  return { app, client };
}

describe("GET /.well-known/oauth-authorization-server", () => {
  it("returns HTTP 200", async () => {
    stubFetch(UPSTREAM_METADATA);
    const { app } = buildApp();

    const res = await app.request("/.well-known/oauth-authorization-server");

    expect(res.status).toBe(200);
  });

  it("returns JSON content-type", async () => {
    stubFetch(UPSTREAM_METADATA);
    const { app } = buildApp();

    const res = await app.request("/.well-known/oauth-authorization-server");

    expect(res.headers.get("content-type")).toMatch(/application\/json/);
  });

  it("includes issuer in the response body", async () => {
    stubFetch(UPSTREAM_METADATA);
    const { app } = buildApp();

    const res = await app.request("/.well-known/oauth-authorization-server");
    const body = await res.json();

    expect(body.issuer).toBe(ISSUER);
  });

  it("includes authorization_endpoint, token_endpoint, jwks_uri, scopes_supported", async () => {
    stubFetch(UPSTREAM_METADATA);
    const { app } = buildApp();

    const res = await app.request("/.well-known/oauth-authorization-server");
    const body = await res.json();

    expect(body.authorization_endpoint).toBe(
      UPSTREAM_METADATA.authorization_endpoint,
    );
    expect(body.token_endpoint).toBe(UPSTREAM_METADATA.token_endpoint);
    expect(body.jwks_uri).toBe(UPSTREAM_METADATA.jwks_uri);
    expect(body.scopes_supported).toEqual(UPSTREAM_METADATA.scopes_supported);
  });

  it("returns HTTP 502 when the upstream OIDC provider is unavailable", async () => {
    stubFetch({}, { ok: false, status: 503 });
    const { app } = buildApp();

    const res = await app.request("/.well-known/oauth-authorization-server");

    expect(res.status).toBe(502);
  });

  it("returns a JSON error body on upstream failure", async () => {
    stubFetch({}, { ok: false, status: 503 });
    const { app } = buildApp();

    const res = await app.request("/.well-known/oauth-authorization-server");
    const body = await res.json();

    expect(body).toHaveProperty("error");
  });

  it("serves a second request from the cache — fetch called only once", async () => {
    const fetchMock = stubFetch(UPSTREAM_METADATA);
    const { app } = buildApp();

    await app.request("/.well-known/oauth-authorization-server");
    await app.request("/.well-known/oauth-authorization-server");

    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("re-fetches when the TTL has expired", async () => {
    const fetchMock = stubFetch(UPSTREAM_METADATA);
    const { app } = buildApp(0); // 0 ms TTL

    await app.request("/.well-known/oauth-authorization-server");
    await app.request("/.well-known/oauth-authorization-server");

    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

// ── scopes_supported passthrough / allowlist ──────────────────────────────────

describe("scopes_supported behavior", () => {
  it("passes through upstream scopes_supported unchanged when no allowlist is configured", async () => {
    stubFetch(UPSTREAM_METADATA);
    const { app } = buildApp();

    const res = await app.request("/.well-known/oauth-authorization-server");
    const body = await res.json();

    expect(body.scopes_supported).toEqual(UPSTREAM_METADATA.scopes_supported);
  });

  it("does not inject scopes_supported when upstream does not include it", async () => {
    const metaWithoutScopes = { ...UPSTREAM_METADATA };
    const { scopes_supported: _omit, ...rest } = metaWithoutScopes;
    stubFetch(rest);
    const { app } = buildApp();

    const res = await app.request("/.well-known/oauth-authorization-server");
    const body = await res.json();

    expect(body).not.toHaveProperty("scopes_supported");
  });

  it("with allowlist: returns intersection of allowlist and upstream scopes", async () => {
    stubFetch(UPSTREAM_METADATA); // upstream has ['openid', 'profile', 'email']
    const { app } = buildApp(3_600_000, ["openid", "email", "offline_access"]);

    const res = await app.request("/.well-known/oauth-authorization-server");
    const body = await res.json();

    // 'offline_access' is in allowlist but not upstream → excluded
    expect(body.scopes_supported).toEqual(["openid", "email"]);
  });

  it("with allowlist: excludes scopes not present in upstream", async () => {
    stubFetch(UPSTREAM_METADATA); // upstream has ['openid', 'profile', 'email']
    const { app } = buildApp(3_600_000, ["openid", "graph-mcp-vault-api"]);

    const res = await app.request("/.well-known/oauth-authorization-server");
    const body = await res.json();

    expect(body.scopes_supported).toEqual(["openid"]);
  });

  it("with allowlist and no matching upstream scopes: returns empty array", async () => {
    stubFetch(UPSTREAM_METADATA);
    const { app } = buildApp(3_600_000, ["nope", "also-nope"]);

    const res = await app.request("/.well-known/oauth-authorization-server");
    const body = await res.json();

    expect(body.scopes_supported).toEqual([]);
  });

  it("preserves all other upstream fields unchanged regardless of allowlist setting", async () => {
    stubFetch(UPSTREAM_METADATA);
    const { app } = buildApp(3_600_000, ["openid"]);

    const res = await app.request("/.well-known/oauth-authorization-server");
    const body = await res.json();

    expect(body.issuer).toBe(UPSTREAM_METADATA.issuer);
    expect(body.authorization_endpoint).toBe(
      UPSTREAM_METADATA.authorization_endpoint,
    );
    expect(body.token_endpoint).toBe(UPSTREAM_METADATA.token_endpoint);
    expect(body.jwks_uri).toBe(UPSTREAM_METADATA.jwks_uri);
  });
});

// ── OidcMetadataClient custom discoveryUrl ────────────────────────────────────

describe("OidcMetadataClient: custom discoveryUrl", () => {
  it("uses the default constructed URL when no discoveryUrl is provided", async () => {
    const fetchMock = stubFetch(UPSTREAM_METADATA);
    const client = new OidcMetadataClient(ISSUER, 3_600_000);

    await client.getMetadata();

    expect(fetchMock).toHaveBeenCalledWith(DISCOVERY_URL);
  });

  it("uses the provided discoveryUrl instead of the default construction", async () => {
    const custom =
      "https://custom.example.com/.well-known/openid-configuration";
    const fetchMock = stubFetch(UPSTREAM_METADATA);
    const client = new OidcMetadataClient(ISSUER, 3_600_000, custom);

    await client.getMetadata();

    expect(fetchMock).toHaveBeenCalledWith(custom);
  });
});

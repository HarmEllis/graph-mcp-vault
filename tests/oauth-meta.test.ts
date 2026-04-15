import { Hono } from "hono";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  OidcMetadataClient,
  createOAuthMetaRouter,
} from "../src/routers/oauth-meta.js";

// ── Fixtures ──────────────────────────────────────────────────────────────────

const ISSUER = "https://oidc.example.com";
const PUBLIC_URL = "https://mcp.example.com";
const CLIENT_ID = "graph-mcp-vault";

const UPSTREAM_METADATA = {
  issuer: ISSUER,
  authorization_endpoint: `${ISSUER}/authorize`,
  token_endpoint: `${ISSUER}/token`,
  jwks_uri: `${ISSUER}/.well-known/jwks.json`,
  registration_endpoint: `${ISSUER}/clients`,
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
  injectMissingScope = false,
): { app: Hono; client: OidcMetadataClient } {
  const client = new OidcMetadataClient(ISSUER, ttlMs, discoveryUrl);
  const router = createOAuthMetaRouter(
    client,
    PUBLIC_URL,
    ISSUER,
    CLIENT_ID,
    scopesAllowlist,
    injectMissingScope,
  );
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

  it("overrides issuer to the proxy public URL (RFC 8414 §3.3)", async () => {
    stubFetch(UPSTREAM_METADATA);
    const { app } = buildApp();

    const res = await app.request("/.well-known/oauth-authorization-server");
    const body = await res.json();

    expect(body.issuer).toBe(PUBLIC_URL);
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

// ── GET /.well-known/oauth-protected-resource (RFC 9728) ─────────────────────

describe("GET /.well-known/oauth-protected-resource", () => {
  it("returns HTTP 200", async () => {
    const { app } = buildApp();

    const res = await app.request("/.well-known/oauth-protected-resource");

    expect(res.status).toBe(200);
  });

  it("returns JSON content-type", async () => {
    const { app } = buildApp();

    const res = await app.request("/.well-known/oauth-protected-resource");

    expect(res.headers.get("content-type")).toMatch(/application\/json/);
  });

  it("includes resource set to the server public URL", async () => {
    const { app } = buildApp();

    const res = await app.request("/.well-known/oauth-protected-resource");
    const body = await res.json();

    expect(body.resource).toBe(PUBLIC_URL);
  });

  it("includes authorization_servers pointing to the proxy public URL", async () => {
    const { app } = buildApp();

    const res = await app.request("/.well-known/oauth-protected-resource");
    const body = await res.json();

    expect(body.authorization_servers).toEqual([PUBLIC_URL]);
  });

  it("includes bearer_methods_supported: ['header']", async () => {
    const { app } = buildApp();

    const res = await app.request("/.well-known/oauth-protected-resource");
    const body = await res.json();

    expect(body.bearer_methods_supported).toEqual(["header"]);
  });

  it("includes resource_signing_alg_values_supported: ['RS256']", async () => {
    const { app } = buildApp();

    const res = await app.request("/.well-known/oauth-protected-resource");
    const body = await res.json();

    expect(body.resource_signing_alg_values_supported).toEqual(["RS256"]);
  });

  it("includes scopes_supported when scopesAllowlist is configured", async () => {
    const { app } = buildApp(3_600_000, ["openid", "profile"]);

    const res = await app.request("/.well-known/oauth-protected-resource");
    const body = await res.json();

    expect(body.scopes_supported).toEqual(["openid", "profile"]);
  });

  it("includes fallback scopes_supported when no scopesAllowlist is configured", async () => {
    const { app } = buildApp();

    const res = await app.request("/.well-known/oauth-protected-resource");
    const body = await res.json();

    expect(body.scopes_supported).toEqual(["openid"]);
  });

  it("does not require a live upstream OIDC provider", async () => {
    // Protected resource metadata is static — no upstream fetch should occur
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const { app } = buildApp();

    await app.request("/.well-known/oauth-protected-resource");

    expect(fetchMock).not.toHaveBeenCalled();
  });
});

// ── registration_endpoint replacement ────────────────────────────────────────

describe("registration_endpoint replacement", () => {
  it("replaces upstream registration_endpoint with <publicUrl>/clients", async () => {
    stubFetch(UPSTREAM_METADATA); // upstream includes registration_endpoint
    const { app } = buildApp();

    const res = await app.request("/.well-known/oauth-authorization-server");
    const body = await res.json();

    expect(body.registration_endpoint).toBe(`${PUBLIC_URL}/clients`);
  });

  it("preserves all other upstream fields when replacing registration_endpoint", async () => {
    stubFetch(UPSTREAM_METADATA);
    const { app } = buildApp();

    const res = await app.request("/.well-known/oauth-authorization-server");
    const body = await res.json();

    // issuer is overridden to publicUrl per RFC 8414 §3.3
    expect(body.issuer).toBe(PUBLIC_URL);
    expect(body.authorization_endpoint).toBe(
      UPSTREAM_METADATA.authorization_endpoint,
    );
    expect(body.token_endpoint).toBe(UPSTREAM_METADATA.token_endpoint);
    expect(body.jwks_uri).toBe(UPSTREAM_METADATA.jwks_uri);
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

  it("injects fallback scopes_supported when upstream does not include it", async () => {
    const metaWithoutScopes = { ...UPSTREAM_METADATA };
    const { scopes_supported: _omit, ...rest } = metaWithoutScopes;
    stubFetch(rest);
    const { app } = buildApp();

    const res = await app.request("/.well-known/oauth-authorization-server");
    const body = await res.json();

    expect(body.scopes_supported).toEqual(["openid"]);
  });

  it("with allowlist: uses the allowlist when upstream omits scopes_supported", async () => {
    const metaWithoutScopes = { ...UPSTREAM_METADATA };
    const { scopes_supported: _omit, ...rest } = metaWithoutScopes;
    stubFetch(rest);
    const { app } = buildApp(3_600_000, ["openid", "profile", "email"]);

    const res = await app.request("/.well-known/oauth-authorization-server");
    const body = await res.json();

    expect(body.scopes_supported).toEqual(["openid", "profile", "email"]);
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

    // issuer is overridden to publicUrl per RFC 8414 §3.3
    expect(body.issuer).toBe(PUBLIC_URL);
    expect(body.authorization_endpoint).toBe(
      UPSTREAM_METADATA.authorization_endpoint,
    );
    expect(body.token_endpoint).toBe(UPSTREAM_METADATA.token_endpoint);
    expect(body.jwks_uri).toBe(UPSTREAM_METADATA.jwks_uri);
  });
});

// ── POST /clients (RFC 7591 DCR proxy) ───────────────────────────────────────

describe("POST /clients", () => {
  it("returns HTTP 201", async () => {
    const { app } = buildApp();

    const res = await app.request("/clients", { method: "POST" });

    expect(res.status).toBe(201);
  });

  it("returns JSON content-type", async () => {
    const { app } = buildApp();

    const res = await app.request("/clients", { method: "POST" });

    expect(res.headers.get("content-type")).toMatch(/application\/json/);
  });

  it("returns the pre-configured client_id", async () => {
    const { app } = buildApp();

    const res = await app.request("/clients", { method: "POST" });
    const body = await res.json();

    expect(body.client_id).toBe(CLIENT_ID);
  });

  it("registers the client as public (token_endpoint_auth_method: none)", async () => {
    const { app } = buildApp();

    const res = await app.request("/clients", { method: "POST" });
    const body = await res.json();

    expect(body.token_endpoint_auth_method).toBe("none");
  });

  it("includes grant_types: ['authorization_code']", async () => {
    const { app } = buildApp();

    const res = await app.request("/clients", { method: "POST" });
    const body = await res.json();

    expect(body.grant_types).toEqual(["authorization_code"]);
  });

  it("includes response_types: ['code']", async () => {
    const { app } = buildApp();

    const res = await app.request("/clients", { method: "POST" });
    const body = await res.json();

    expect(body.response_types).toEqual(["code"]);
  });

  it("echoes back the redirect_uris from the request body", async () => {
    const { app } = buildApp();
    const redirectUris = ["http://localhost:19876/oauth/callback"];

    const res = await app.request("/clients", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ redirect_uris: redirectUris }),
    });
    const body = await res.json();

    expect(body.redirect_uris).toEqual(redirectUris);
  });

  it("returns empty redirect_uris when none are supplied in the request", async () => {
    const { app } = buildApp();

    const res = await app.request("/clients", { method: "POST" });
    const body = await res.json();

    expect(body.redirect_uris).toEqual([]);
  });

  it("includes client_id_issued_at as a Unix timestamp", async () => {
    const before = Math.floor(Date.now() / 1000);
    const { app } = buildApp();

    const res = await app.request("/clients", { method: "POST" });
    const body = await res.json();
    const after = Math.floor(Date.now() / 1000);

    expect(body.client_id_issued_at).toBeGreaterThanOrEqual(before);
    expect(body.client_id_issued_at).toBeLessThanOrEqual(after);
  });

  it("includes scope defaulting to 'openid' when no allowlist is configured", async () => {
    const { app } = buildApp(); // no scopesAllowlist

    const res = await app.request("/clients", { method: "POST" });
    const body = await res.json();

    expect(body.scope).toBe("openid");
  });

  it("includes scope as space-separated allowlist when scopesAllowlist is configured", async () => {
    const { app } = buildApp(3_600_000, ["openid", "profile", "email"]);

    const res = await app.request("/clients", { method: "POST" });
    const body = await res.json();

    expect(body.scope).toBe("openid profile email");
  });

  it("does not require a live upstream OIDC provider", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const { app } = buildApp();

    await app.request("/clients", { method: "POST" });

    expect(fetchMock).not.toHaveBeenCalled();
  });
});

// ── INJECT_MISSING_SCOPE — authorization proxy ────────────────────────────────

describe("GET /authorize (scope injection proxy)", () => {
  it("returns 404 when injectMissingScope is disabled (default)", async () => {
    const { app } = buildApp(); // injectMissingScope defaults to false

    const res = await app.request("/authorize?response_type=code&client_id=x");

    expect(res.status).toBe(404);
  });

  it("redirects to the upstream authorization_endpoint when enabled", async () => {
    stubFetch(UPSTREAM_METADATA);
    const { app } = buildApp(3_600_000, undefined, undefined, true);

    const res = await app.request(
      "/authorize?response_type=code&client_id=x&scope=openid",
    );

    expect(res.status).toBe(302);
    const location = res.headers.get("location") ?? "";
    expect(location.startsWith(UPSTREAM_METADATA.authorization_endpoint)).toBe(
      true,
    );
  });

  it("injects 'openid' scope when the client omits scope and no allowlist is set", async () => {
    stubFetch(UPSTREAM_METADATA);
    const { app } = buildApp(3_600_000, undefined, undefined, true);

    const res = await app.request("/authorize?response_type=code&client_id=x");

    const location = new URL(res.headers.get("location") ?? "http://x");
    expect(location.searchParams.get("scope")).toBe("openid");
  });

  it("injects the allowlist as scope when the client omits scope", async () => {
    stubFetch(UPSTREAM_METADATA);
    const { app } = buildApp(
      3_600_000,
      ["openid", "profile", "email"],
      undefined,
      true,
    );

    const res = await app.request("/authorize?response_type=code&client_id=x");

    const location = new URL(res.headers.get("location") ?? "http://x");
    expect(location.searchParams.get("scope")).toBe("openid profile email");
  });

  it("preserves an existing scope when the client already includes it", async () => {
    stubFetch(UPSTREAM_METADATA);
    const { app } = buildApp(
      3_600_000,
      ["openid", "profile", "email"],
      undefined,
      true,
    );

    const res = await app.request(
      "/authorize?response_type=code&client_id=x&scope=openid+offline_access",
    );

    const location = new URL(res.headers.get("location") ?? "http://x");
    expect(location.searchParams.get("scope")).toBe("openid offline_access");
  });

  it("forwards all original query parameters to the upstream", async () => {
    stubFetch(UPSTREAM_METADATA);
    const { app } = buildApp(3_600_000, undefined, undefined, true);

    const res = await app.request(
      "/authorize?response_type=code&client_id=x&state=abc&code_challenge=xyz&code_challenge_method=S256",
    );

    const location = new URL(res.headers.get("location") ?? "http://x");
    expect(location.searchParams.get("response_type")).toBe("code");
    expect(location.searchParams.get("client_id")).toBe("x");
    expect(location.searchParams.get("state")).toBe("abc");
    expect(location.searchParams.get("code_challenge")).toBe("xyz");
  });

  it("returns 502 when upstream metadata is unavailable", async () => {
    stubFetch({}, { ok: false, status: 503 });
    const { app } = buildApp(3_600_000, undefined, undefined, true);

    const res = await app.request("/authorize?response_type=code&client_id=x");

    expect(res.status).toBe(502);
  });

  it("overrides authorization_endpoint in AS metadata when enabled", async () => {
    stubFetch(UPSTREAM_METADATA);
    const { app } = buildApp(3_600_000, undefined, undefined, true);

    const res = await app.request("/.well-known/oauth-authorization-server");
    const body = await res.json();

    expect(body.authorization_endpoint).toBe(`${PUBLIC_URL}/authorize`);
  });

  it("keeps the upstream authorization_endpoint in AS metadata when disabled", async () => {
    stubFetch(UPSTREAM_METADATA);
    const { app } = buildApp(); // disabled

    const res = await app.request("/.well-known/oauth-authorization-server");
    const body = await res.json();

    expect(body.authorization_endpoint).toBe(
      UPSTREAM_METADATA.authorization_endpoint,
    );
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

import { SignJWT, exportJWK, generateKeyPair } from "jose";
import type { KeyLike } from "jose";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { AuthError, JwksClient, validateBearerToken } from "../src/auth.js";
import type { Config } from "../src/config.js";

// ── Fixtures ─────────────────────────────────────────────────────────────────

const ISSUER = "https://oidc.example.com";
const AUDIENCE = "graph-mcp-vault";
const KID_1 = "key-1";
const KID_2 = "key-2";
const JWKS_URI = `${ISSUER}/.well-known/jwks.json`;
const TTL_MS = 3_600_000;

let privateKey1: KeyLike;
let publicKey1: KeyLike;
let privateKey2: KeyLike;
let publicKey2: KeyLike;

const testConfig: Config = {
  oidcIssuer: ISSUER,
  oidcAudience: AUDIENCE,
  jwksCacheTtl: 3600,
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
  injectMissingScope: false,
};

beforeAll(async () => {
  ({ privateKey: privateKey1, publicKey: publicKey1 } =
    await generateKeyPair("RS256"));
  ({ privateKey: privateKey2, publicKey: publicKey2 } =
    await generateKeyPair("RS256"));
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ── Helpers ───────────────────────────────────────────────────────────────────

async function buildJwks(
  pairs: Array<{ key: KeyLike; kid: string }>,
): Promise<object> {
  const keys = await Promise.all(
    pairs.map(async ({ key, kid }) => ({
      ...(await exportJWK(key)),
      kid,
      use: "sig",
    })),
  );
  return { keys };
}

function stubFetch(
  jwks: object,
  { ok = true }: { ok?: boolean } = {},
): ReturnType<typeof vi.fn> {
  const mock = vi
    .fn()
    .mockResolvedValue({ ok, status: ok ? 200 : 500, json: async () => jwks });
  vi.stubGlobal("fetch", mock);
  return mock;
}

async function makeToken(
  opts: {
    key?: KeyLike;
    kid?: string;
    sub?: string;
    iss?: string;
    aud?: string;
    /** Unix seconds; defaults to now+3600 */
    exp?: number;
    /** Unix seconds; if set, adds nbf claim */
    nbf?: number;
    /** Optional OIDC name claim */
    name?: string;
    /** Optional OIDC email claim */
    email?: string;
    /** Optional OIDC email_verified claim */
    email_verified?: boolean;
    /** Optional OIDC preferred_username claim */
    preferred_username?: string;
    /** Optional OIDC given_name claim */
    given_name?: string;
    /** Optional OIDC family_name claim */
    family_name?: string;
  } = {},
): Promise<string> {
  const nowSec = Math.floor(Date.now() / 1000);
  const extra: Record<string, unknown> = {};
  if (opts.name !== undefined) extra.name = opts.name;
  if (opts.email !== undefined) extra.email = opts.email;
  if (opts.email_verified !== undefined)
    extra.email_verified = opts.email_verified;
  if (opts.preferred_username !== undefined)
    extra.preferred_username = opts.preferred_username;
  if (opts.given_name !== undefined) extra.given_name = opts.given_name;
  if (opts.family_name !== undefined) extra.family_name = opts.family_name;
  let builder = new SignJWT({ sub: opts.sub ?? "user-123", ...extra })
    .setProtectedHeader({ alg: "RS256", kid: opts.kid ?? KID_1 })
    .setIssuer(opts.iss ?? ISSUER)
    .setAudience(opts.aud ?? AUDIENCE)
    .setIssuedAt()
    .setExpirationTime(opts.exp ?? nowSec + 3600);
  if (opts.nbf !== undefined) {
    builder = builder.setNotBefore(opts.nbf);
  }
  return builder.sign(opts.key ?? privateKey1);
}

function freshClient(): JwksClient {
  return new JwksClient(JWKS_URI, TTL_MS);
}

// ── JwksClient tests ──────────────────────────────────────────────────────────

describe("JwksClient", () => {
  it("fetches JWKS on first getKey call and returns the matching key", async () => {
    const jwks = await buildJwks([{ key: publicKey1, kid: KID_1 }]);
    const fetchMock = stubFetch(jwks);

    const client = freshClient();
    const key = await client.getKey(KID_1);

    expect(key).not.toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("returns null for an unknown kid without extra fetches when cache is warm", async () => {
    const jwks = await buildJwks([{ key: publicKey1, kid: KID_1 }]);
    const fetchMock = stubFetch(jwks);

    const client = freshClient();
    await client.getKey(KID_1); // warms cache
    const key = await client.getKey("nonexistent-kid"); // cache is valid, no refetch

    expect(key).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("re-fetches when cache is expired", async () => {
    const jwks = await buildJwks([{ key: publicKey1, kid: KID_1 }]);
    const fetchMock = stubFetch(jwks);

    // TTL of 0 ms → cache always expired
    const client = new JwksClient(JWKS_URI, 0);
    await client.getKey(KID_1);
    await client.getKey(KID_1);

    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("forceRefresh updates the key cache immediately", async () => {
    const oldJwks = await buildJwks([{ key: publicKey1, kid: KID_1 }]);
    const newJwks = await buildJwks([{ key: publicKey2, kid: KID_2 }]);
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => oldJwks,
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => newJwks,
      });
    vi.stubGlobal("fetch", fetchMock);

    const client = freshClient();
    await client.getKey(KID_1); // populates cache with key-1
    await client.forceRefresh(); // replaces cache with key-2
    const key = await client.getKey(KID_2); // should find key-2 without another fetch

    expect(key).not.toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

// ── validateBearerToken tests ─────────────────────────────────────────────────

describe("validateBearerToken", () => {
  it("returns userId for a valid token", async () => {
    const jwks = await buildJwks([{ key: publicKey1, kid: KID_1 }]);
    stubFetch(jwks);
    const client = freshClient();

    const token = await makeToken({ sub: "alice" });
    const result = await validateBearerToken(
      `Bearer ${token}`,
      testConfig,
      client,
    );

    expect(result.userId).toBe("alice");
  });

  it("throws AuthError when Authorization header is absent", async () => {
    const client = freshClient();
    await expect(
      validateBearerToken(undefined, testConfig, client),
    ).rejects.toThrow(AuthError);
  });

  it("throws AuthError when Authorization header uses a non-Bearer scheme", async () => {
    const client = freshClient();
    await expect(
      validateBearerToken("Basic dXNlcjpwYXNz", testConfig, client),
    ).rejects.toThrow(AuthError);
  });

  it("throws AuthError for an expired token", async () => {
    const jwks = await buildJwks([{ key: publicKey1, kid: KID_1 }]);
    stubFetch(jwks);
    const client = freshClient();

    // Expired 60 s ago — well outside the 30 s clock-skew tolerance
    const expiredToken = await makeToken({
      exp: Math.floor(Date.now() / 1000) - 60,
    });
    await expect(
      validateBearerToken(`Bearer ${expiredToken}`, testConfig, client),
    ).rejects.toThrow(AuthError);
  });

  it("throws AuthError when the issuer does not match", async () => {
    const jwks = await buildJwks([{ key: publicKey1, kid: KID_1 }]);
    stubFetch(jwks);
    const client = freshClient();

    const token = await makeToken({ iss: "https://wrong-issuer.example.com" });
    await expect(
      validateBearerToken(`Bearer ${token}`, testConfig, client),
    ).rejects.toThrow(AuthError);
  });

  it("throws AuthError when the audience does not match", async () => {
    const jwks = await buildJwks([{ key: publicKey1, kid: KID_1 }]);
    stubFetch(jwks);
    const client = freshClient();

    const token = await makeToken({ aud: "wrong-audience" });
    await expect(
      validateBearerToken(`Bearer ${token}`, testConfig, client),
    ).rejects.toThrow(AuthError);
  });

  it("accepts a token whose nbf is within the 30-second leeway", async () => {
    const jwks = await buildJwks([{ key: publicKey1, kid: KID_1 }]);
    stubFetch(jwks);
    const client = freshClient();

    // nbf 20 seconds in the future — within the 30s tolerance
    const token = await makeToken({ nbf: Math.floor(Date.now() / 1000) + 20 });
    const result = await validateBearerToken(
      `Bearer ${token}`,
      testConfig,
      client,
    );

    expect(result.userId).toBe("user-123");
  });

  it("throws AuthError when nbf is beyond the 30-second leeway", async () => {
    const jwks = await buildJwks([{ key: publicKey1, kid: KID_1 }]);
    stubFetch(jwks);
    const client = freshClient();

    // nbf 60 seconds in the future — outside the 30s tolerance
    const token = await makeToken({ nbf: Math.floor(Date.now() / 1000) + 60 });
    await expect(
      validateBearerToken(`Bearer ${token}`, testConfig, client),
    ).rejects.toThrow(AuthError);
  });

  it("triggers a JWKS force-refresh on unknown kid and succeeds after key rotation", async () => {
    const oldJwks = await buildJwks([{ key: publicKey1, kid: KID_1 }]);
    const newJwks = await buildJwks([{ key: publicKey2, kid: KID_2 }]);
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => oldJwks,
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => newJwks,
      });
    vi.stubGlobal("fetch", fetchMock);

    const client = freshClient();
    await client.getKey(KID_1); // warm cache with old JWKS (key-1 only)

    // JWT signed with the new key (kid-2) — not yet in cache
    const token = await makeToken({ key: privateKey2, kid: KID_2 });
    const result = await validateBearerToken(
      `Bearer ${token}`,
      testConfig,
      client,
    );

    expect(result.userId).toBe("user-123");
    // First fetch warmed the cache; second fetch was the force-refresh
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("throws AuthError when kid remains unknown even after force-refresh", async () => {
    const jwks = await buildJwks([{ key: publicKey1, kid: KID_1 }]);
    // Both fetches return the same JWKS — no kid-2 ever appears
    const fetchMock = vi
      .fn()
      .mockResolvedValue({ ok: true, status: 200, json: async () => jwks });
    vi.stubGlobal("fetch", fetchMock);

    const client = freshClient();
    const token = await makeToken({ key: privateKey2, kid: KID_2 });

    await expect(
      validateBearerToken(`Bearer ${token}`, testConfig, client),
    ).rejects.toThrow(AuthError);
  });

  it("returns name and email from JWT claims when both are present", async () => {
    const jwks = await buildJwks([{ key: publicKey1, kid: KID_1 }]);
    stubFetch(jwks);
    const client = freshClient();

    const token = await makeToken({
      name: "Alice Smith",
      email: "alice@example.com",
    });
    const result = await validateBearerToken(
      `Bearer ${token}`,
      testConfig,
      client,
    );

    expect(result.name).toBe("Alice Smith");
    expect(result.email).toBe("alice@example.com");
  });

  it("returns null for email when email_verified is false", async () => {
    const jwks = await buildJwks([{ key: publicKey1, kid: KID_1 }]);
    stubFetch(jwks);
    const client = freshClient();

    const token = await makeToken({
      name: "Alice Smith",
      email: "alice@example.com",
      email_verified: false,
    });
    const result = await validateBearerToken(
      `Bearer ${token}`,
      testConfig,
      client,
    );

    expect(result.name).toBe("Alice Smith");
    expect(result.email).toBeNull();
  });

  it("returns null for name and email when those claims are absent", async () => {
    const jwks = await buildJwks([{ key: publicKey1, kid: KID_1 }]);
    stubFetch(jwks);
    const client = freshClient();

    const token = await makeToken();
    const result = await validateBearerToken(
      `Bearer ${token}`,
      testConfig,
      client,
    );

    expect(result.name).toBeNull();
    expect(result.email).toBeNull();
  });

  it("returns null for name when the claim is not a string", async () => {
    const jwks = await buildJwks([{ key: publicKey1, kid: KID_1 }]);
    stubFetch(jwks);
    const client = freshClient();

    // Build a token where name is a non-string (number) — not a standard claim value
    const nowSec = Math.floor(Date.now() / 1000);
    const rawToken = await new SignJWT({
      sub: "user-123",
      name: 42, // not a string
    })
      .setProtectedHeader({ alg: "RS256", kid: KID_1 })
      .setIssuer(ISSUER)
      .setAudience(AUDIENCE)
      .setIssuedAt()
      .setExpirationTime(nowSec + 3600)
      .sign(privateKey1);

    const result = await validateBearerToken(
      `Bearer ${rawToken}`,
      testConfig,
      client,
    );

    expect(result.name).toBeNull();
  });

  it("falls back to preferred_username when name is absent", async () => {
    const jwks = await buildJwks([{ key: publicKey1, kid: KID_1 }]);
    stubFetch(jwks);
    const client = freshClient();

    const token = await makeToken({ preferred_username: "alice-dev" });
    const result = await validateBearerToken(
      `Bearer ${token}`,
      testConfig,
      client,
    );

    expect(result.name).toBe("alice-dev");
  });

  it("falls back to given_name + family_name when name is absent", async () => {
    const jwks = await buildJwks([{ key: publicKey1, kid: KID_1 }]);
    stubFetch(jwks);
    const client = freshClient();

    const token = await makeToken({
      given_name: "Alice",
      family_name: "Dev",
    });
    const result = await validateBearerToken(
      `Bearer ${token}`,
      testConfig,
      client,
    );

    expect(result.name).toBe("Alice Dev");
  });
});

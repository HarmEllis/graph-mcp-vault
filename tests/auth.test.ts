import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { SignJWT, exportJWK, generateKeyPair } from 'jose';
import type { KeyLike } from 'jose';
import { AuthError, JwksClient, validateBearerToken } from '../src/auth.js';
import type { Config } from '../src/config.js';

// ── Fixtures ─────────────────────────────────────────────────────────────────

const ISSUER = 'https://oidc.example.com';
const AUDIENCE = 'graph-mcp-vault';
const KID_1 = 'key-1';
const KID_2 = 'key-2';
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
  neo4jUri: 'bolt://localhost:7687',
  neo4jUser: 'neo4j',
  neo4jPassword: 'secret',
  host: '0.0.0.0',
  port: 8000,
  defaultNamespace: 'default',
  logLevel: 'info',
  allowedOrigins: '',
};

beforeAll(async () => {
  ({ privateKey: privateKey1, publicKey: publicKey1 } = await generateKeyPair('RS256'));
  ({ privateKey: privateKey2, publicKey: publicKey2 } = await generateKeyPair('RS256'));
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ── Helpers ───────────────────────────────────────────────────────────────────

async function buildJwks(pairs: Array<{ key: KeyLike; kid: string }>): Promise<object> {
  const keys = await Promise.all(
    pairs.map(async ({ key, kid }) => ({ ...(await exportJWK(key)), kid, use: 'sig' })),
  );
  return { keys };
}

function stubFetch(jwks: object, { ok = true }: { ok?: boolean } = {}): ReturnType<typeof vi.fn> {
  const mock = vi.fn().mockResolvedValue({ ok, status: ok ? 200 : 500, json: async () => jwks });
  vi.stubGlobal('fetch', mock);
  return mock;
}

async function makeToken(opts: {
  key?: KeyLike;
  kid?: string;
  sub?: string;
  iss?: string;
  aud?: string;
  /** Unix seconds; defaults to now+3600 */
  exp?: number;
  /** Unix seconds; if set, adds nbf claim */
  nbf?: number;
} = {}): Promise<string> {
  const nowSec = Math.floor(Date.now() / 1000);
  let builder = new SignJWT({ sub: opts.sub ?? 'user-123' })
    .setProtectedHeader({ alg: 'RS256', kid: opts.kid ?? KID_1 })
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

describe('JwksClient', () => {
  it('fetches JWKS on first getKey call and returns the matching key', async () => {
    const jwks = await buildJwks([{ key: publicKey1, kid: KID_1 }]);
    const fetchMock = stubFetch(jwks);

    const client = freshClient();
    const key = await client.getKey(KID_1);

    expect(key).not.toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('returns null for an unknown kid without extra fetches when cache is warm', async () => {
    const jwks = await buildJwks([{ key: publicKey1, kid: KID_1 }]);
    const fetchMock = stubFetch(jwks);

    const client = freshClient();
    await client.getKey(KID_1); // warms cache
    const key = await client.getKey('nonexistent-kid'); // cache is valid, no refetch

    expect(key).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('re-fetches when cache is expired', async () => {
    const jwks = await buildJwks([{ key: publicKey1, kid: KID_1 }]);
    const fetchMock = stubFetch(jwks);

    // TTL of 0 ms → cache always expired
    const client = new JwksClient(JWKS_URI, 0);
    await client.getKey(KID_1);
    await client.getKey(KID_1);

    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('forceRefresh updates the key cache immediately', async () => {
    const oldJwks = await buildJwks([{ key: publicKey1, kid: KID_1 }]);
    const newJwks = await buildJwks([{ key: publicKey2, kid: KID_2 }]);
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => oldJwks })
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => newJwks });
    vi.stubGlobal('fetch', fetchMock);

    const client = freshClient();
    await client.getKey(KID_1); // populates cache with key-1
    await client.forceRefresh(); // replaces cache with key-2
    const key = await client.getKey(KID_2); // should find key-2 without another fetch

    expect(key).not.toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

// ── validateBearerToken tests ─────────────────────────────────────────────────

describe('validateBearerToken', () => {
  it('returns userId for a valid token', async () => {
    const jwks = await buildJwks([{ key: publicKey1, kid: KID_1 }]);
    stubFetch(jwks);
    const client = freshClient();

    const token = await makeToken({ sub: 'alice' });
    const result = await validateBearerToken(`Bearer ${token}`, testConfig, client);

    expect(result.userId).toBe('alice');
  });

  it('throws AuthError when Authorization header is absent', async () => {
    const client = freshClient();
    await expect(validateBearerToken(undefined, testConfig, client)).rejects.toThrow(AuthError);
  });

  it('throws AuthError when Authorization header uses a non-Bearer scheme', async () => {
    const client = freshClient();
    await expect(
      validateBearerToken('Basic dXNlcjpwYXNz', testConfig, client),
    ).rejects.toThrow(AuthError);
  });

  it('throws AuthError for an expired token', async () => {
    const jwks = await buildJwks([{ key: publicKey1, kid: KID_1 }]);
    stubFetch(jwks);
    const client = freshClient();

    // Expired 60 s ago — well outside the 30 s clock-skew tolerance
    const expiredToken = await makeToken({ exp: Math.floor(Date.now() / 1000) - 60 });
    await expect(
      validateBearerToken(`Bearer ${expiredToken}`, testConfig, client),
    ).rejects.toThrow(AuthError);
  });

  it('throws AuthError when the issuer does not match', async () => {
    const jwks = await buildJwks([{ key: publicKey1, kid: KID_1 }]);
    stubFetch(jwks);
    const client = freshClient();

    const token = await makeToken({ iss: 'https://wrong-issuer.example.com' });
    await expect(
      validateBearerToken(`Bearer ${token}`, testConfig, client),
    ).rejects.toThrow(AuthError);
  });

  it('throws AuthError when the audience does not match', async () => {
    const jwks = await buildJwks([{ key: publicKey1, kid: KID_1 }]);
    stubFetch(jwks);
    const client = freshClient();

    const token = await makeToken({ aud: 'wrong-audience' });
    await expect(
      validateBearerToken(`Bearer ${token}`, testConfig, client),
    ).rejects.toThrow(AuthError);
  });

  it('accepts a token whose nbf is within the 30-second leeway', async () => {
    const jwks = await buildJwks([{ key: publicKey1, kid: KID_1 }]);
    stubFetch(jwks);
    const client = freshClient();

    // nbf 20 seconds in the future — within the 30s tolerance
    const token = await makeToken({ nbf: Math.floor(Date.now() / 1000) + 20 });
    const result = await validateBearerToken(`Bearer ${token}`, testConfig, client);

    expect(result.userId).toBe('user-123');
  });

  it('throws AuthError when nbf is beyond the 30-second leeway', async () => {
    const jwks = await buildJwks([{ key: publicKey1, kid: KID_1 }]);
    stubFetch(jwks);
    const client = freshClient();

    // nbf 60 seconds in the future — outside the 30s tolerance
    const token = await makeToken({ nbf: Math.floor(Date.now() / 1000) + 60 });
    await expect(
      validateBearerToken(`Bearer ${token}`, testConfig, client),
    ).rejects.toThrow(AuthError);
  });

  it('triggers a JWKS force-refresh on unknown kid and succeeds after key rotation', async () => {
    const oldJwks = await buildJwks([{ key: publicKey1, kid: KID_1 }]);
    const newJwks = await buildJwks([{ key: publicKey2, kid: KID_2 }]);
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => oldJwks })
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => newJwks });
    vi.stubGlobal('fetch', fetchMock);

    const client = freshClient();
    await client.getKey(KID_1); // warm cache with old JWKS (key-1 only)

    // JWT signed with the new key (kid-2) — not yet in cache
    const token = await makeToken({ key: privateKey2, kid: KID_2 });
    const result = await validateBearerToken(`Bearer ${token}`, testConfig, client);

    expect(result.userId).toBe('user-123');
    // First fetch warmed the cache; second fetch was the force-refresh
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('throws AuthError when kid remains unknown even after force-refresh', async () => {
    const jwks = await buildJwks([{ key: publicKey1, kid: KID_1 }]);
    // Both fetches return the same JWKS — no kid-2 ever appears
    const fetchMock = vi
      .fn()
      .mockResolvedValue({ ok: true, status: 200, json: async () => jwks });
    vi.stubGlobal('fetch', fetchMock);

    const client = freshClient();
    const token = await makeToken({ key: privateKey2, kid: KID_2 });

    await expect(
      validateBearerToken(`Bearer ${token}`, testConfig, client),
    ).rejects.toThrow(AuthError);
  });
});

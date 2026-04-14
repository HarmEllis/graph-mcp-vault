import { decodeProtectedHeader, importJWK, jwtVerify } from "jose";
import type { JWK, KeyLike } from "jose";
import type { Config } from "./config.js";

// ── Types ─────────────────────────────────────────────────────────────────────

interface JwksDocument {
  keys: Array<JWK & { kid: string }>;
}

// ── AuthError ─────────────────────────────────────────────────────────────────

export class AuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AuthError";
  }
}

// ── JwksClient ────────────────────────────────────────────────────────────────

/**
 * In-memory JWKS key cache with TTL-based expiry.
 *
 * Cache behaviour:
 * - Keys are fetched on first access or when the TTL has elapsed.
 * - `forceRefresh()` bypasses TTL and re-fetches unconditionally.
 * - On unknown `kid`, callers should call `forceRefresh()` and retry once
 *   (handled by `validateBearerToken`).
 */
export class JwksClient {
  private keys: Map<string, KeyLike> = new Map();
  private fetchedAt = 0;

  constructor(
    private readonly jwksUri: string,
    /** Cache TTL in milliseconds. */
    private readonly ttlMs: number,
  ) {}

  /** Returns the key for the given `kid`, fetching JWKS if the cache is stale. */
  async getKey(kid: string): Promise<KeyLike | null> {
    if (!this.isCacheValid()) {
      await this.refresh();
    }
    return this.keys.get(kid) ?? null;
  }

  /** Forces an unconditional JWKS re-fetch, replacing the current cache. */
  async forceRefresh(): Promise<void> {
    await this.refresh();
  }

  private isCacheValid(): boolean {
    return this.keys.size > 0 && Date.now() - this.fetchedAt < this.ttlMs;
  }

  private async refresh(): Promise<void> {
    const resp = await fetch(this.jwksUri);
    if (!resp.ok) {
      throw new AuthError(`JWKS fetch failed with HTTP ${resp.status}`);
    }
    const doc = (await resp.json()) as JwksDocument;
    const entries = await Promise.all(
      doc.keys.map(async (jwk) => {
        const key = await importJWK(jwk, "RS256");
        return [jwk.kid, key as KeyLike] as const;
      }),
    );
    this.keys = new Map(entries);
    this.fetchedAt = Date.now();
  }
}

// ── validateBearerToken ───────────────────────────────────────────────────────

/**
 * Validates a `Bearer <jwt>` Authorization header.
 *
 * - Only RS256 tokens are accepted.
 * - On unknown `kid`: forces one JWKS refresh and retries.
 * - `nbf` is validated with a 30-second clock-skew leeway.
 *
 * Throws `AuthError` on any validation failure.
 * Returns `{ userId }` (the `sub` claim) on success.
 */
export async function validateBearerToken(
  authHeader: string | undefined,
  config: Config,
  jwksClient: JwksClient,
): Promise<{ userId: string }> {
  if (!authHeader?.startsWith("Bearer ")) {
    throw new AuthError("Missing or invalid Authorization header");
  }

  const token = authHeader.slice(7);

  let kid: string;
  try {
    const header = decodeProtectedHeader(token);
    if (!header.kid)
      throw new AuthError("JWT is missing the kid header parameter");
    kid = header.kid;
  } catch (err) {
    if (err instanceof AuthError) throw err;
    throw new AuthError("Malformed JWT header");
  }

  // Look up the signing key; force-refresh once if kid is unknown.
  let key = await jwksClient.getKey(kid);
  if (!key) {
    await jwksClient.forceRefresh();
    key = await jwksClient.getKey(kid);
    if (!key) throw new AuthError(`Unknown signing key: ${kid}`);
  }

  try {
    const { payload } = await jwtVerify(token, key, {
      issuer: config.oidcIssuer,
      audience: config.oidcAudience,
      algorithms: ["RS256"],
      clockTolerance: 30, // seconds — handles clock skew for nbf and exp
    });

    if (!payload.sub) throw new AuthError("JWT is missing the sub claim");
    return { userId: payload.sub };
  } catch (err) {
    if (err instanceof AuthError) throw err;
    throw new AuthError(
      err instanceof Error ? err.message : "JWT validation failed",
    );
  }
}

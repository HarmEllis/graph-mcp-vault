import { createHash, randomBytes } from "node:crypto";
import { decodeProtectedHeader, importJWK, jwtVerify } from "jose";
import type { JWK, KeyLike } from "jose";
import type { Config } from "./config.js";
import type { Neo4jClient } from "./neo4j-client.js";

// ── Types ─────────────────────────────────────────────────────────────────────

interface JwksDocument {
  keys: Array<JWK & { kid: string }>;
}

function readStringClaim(
  payload: Record<string, unknown>,
  key: string,
): string | null {
  const value = payload[key];
  return typeof value === "string" ? value : null;
}

function resolveNameClaim(payload: Record<string, unknown>): string | null {
  const directName = readStringClaim(payload, "name");
  if (directName) return directName;

  const givenName = readStringClaim(payload, "given_name");
  const familyName = readStringClaim(payload, "family_name");
  if (givenName && familyName) return `${givenName} ${familyName}`;
  if (givenName) return givenName;
  if (familyName) return familyName;

  const preferredUsername = readStringClaim(payload, "preferred_username");
  if (preferredUsername) return preferredUsername;

  return null;
}

function resolveEmailClaim(payload: Record<string, unknown>): string | null {
  if (payload.email_verified === false) return null;
  return readStringClaim(payload, "email");
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
  private lastForceRefreshAt = 0;

  constructor(
    private readonly jwksUri: string,
    /** Cache TTL in milliseconds. */
    private readonly ttlMs: number,
    /** Minimum milliseconds between forced refreshes (flood protection). */
    private readonly forceRefreshMinIntervalMs = 30_000,
    /** Timeout in milliseconds for JWKS fetch requests. */
    private readonly fetchTimeoutMs = 5_000,
    /** When true, a stale cache is served on fetch error instead of throwing. */
    private readonly allowStaleOnError = false,
  ) {}

  /** Returns the key for the given `kid`, fetching JWKS if the cache is stale. */
  async getKey(kid: string): Promise<KeyLike | null> {
    if (!this.isCacheValid()) {
      await this.refresh();
    }
    return this.keys.get(kid) ?? null;
  }

  /**
   * Forces a JWKS re-fetch, throttled to at most once per `forceRefreshMinIntervalMs`.
   * A no-op if called again within the throttle window.
   */
  async forceRefresh(): Promise<void> {
    const now = Date.now();
    if (now - this.lastForceRefreshAt < this.forceRefreshMinIntervalMs) return;
    await this.refresh();
    // Record timestamp only after a successful fetch so a transient JWKS error
    // does not lock out legitimate retries for the full throttle window.
    this.lastForceRefreshAt = now;
  }

  private isCacheValid(): boolean {
    return this.keys.size > 0 && Date.now() - this.fetchedAt < this.ttlMs;
  }

  private async refresh(): Promise<void> {
    let resp: Response;
    try {
      resp = await fetch(this.jwksUri, {
        signal: AbortSignal.timeout(this.fetchTimeoutMs),
      });
    } catch (err) {
      if (this.allowStaleOnError && this.keys.size > 0) return;
      throw new AuthError(
        `JWKS fetch failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    if (!resp.ok) {
      if (this.allowStaleOnError && this.keys.size > 0) return;
      throw new AuthError(`JWKS fetch failed with HTTP ${resp.status}`);
    }
    const doc = (await resp.json()) as JwksDocument;
    const results = await Promise.allSettled(
      doc.keys.map(async (jwk) => {
        const key = await importJWK(jwk, "RS256");
        return [jwk.kid, key as KeyLike] as const;
      }),
    );
    const entries = results
      .filter(
        (r): r is PromiseFulfilledResult<readonly [string, KeyLike]> =>
          r.status === "fulfilled",
      )
      .map((r) => r.value);
    if (entries.length === 0) {
      if (this.allowStaleOnError && this.keys.size > 0) return;
      throw new AuthError("JWKS contains no usable RS256 keys");
    }
    this.keys = new Map(entries);
    this.fetchedAt = Date.now();
  }
}

// ── API key helpers ──────────────────────────────────────────────────────────

export function generateApiKey(): {
  raw: string;
  hash: string;
  prefix: string;
} {
  const raw = `gmv_${randomBytes(32).toString("hex")}`;
  return {
    raw,
    hash: createHash("sha256").update(raw, "utf8").digest("hex"),
    prefix: raw.slice(0, 12),
  };
}

export async function validateApiKey(
  token: string,
  neo4jClient: Neo4jClient,
): Promise<{
  userId: string;
  apiKeyId: string;
  allowedNamespaces: string[] | null;
}> {
  if (!/^gmv_[0-9a-f]{64}$/.test(token)) {
    throw new AuthError("Invalid API key");
  }

  const keyHash = createHash("sha256").update(token, "utf8").digest("hex");
  const apiKey = await neo4jClient.getApiKeyByHash(keyHash);
  if (!apiKey || apiKey.revoked) {
    throw new AuthError("Invalid API key");
  }

  if (apiKey.expires_at !== null) {
    const expiresAt = Date.parse(apiKey.expires_at);
    if (!Number.isFinite(expiresAt) || expiresAt <= Date.now()) {
      throw new AuthError("Invalid API key");
    }
  }

  void neo4jClient.updateApiKeyLastUsed(apiKey.id).catch(() => undefined);

  return {
    userId: apiKey.user_id,
    apiKeyId: apiKey.id,
    allowedNamespaces: apiKey.namespaces,
  };
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
 * Returns `{ userId, name, email }` on success. `name` and `email` are
 * extracted from standard OIDC claims when present as strings; otherwise null.
 */
export async function validateBearerToken(
  authHeader: string | undefined,
  config: Config,
  jwksClient: JwksClient,
): Promise<{ userId: string; name: string | null; email: string | null }> {
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

    if (
      typeof payload.exp === "number" &&
      typeof payload.iat === "number" &&
      payload.exp - payload.iat > config.maxTokenLifetimeSeconds
    ) {
      throw new AuthError("Token lifetime exceeds maximum allowed");
    }

    const payloadRecord = payload as Record<string, unknown>;
    const name = resolveNameClaim(payloadRecord);
    const email = resolveEmailClaim(payloadRecord);
    return { userId: payload.sub, name, email };
  } catch (err) {
    if (err instanceof AuthError) throw err;
    throw new AuthError(
      err instanceof Error ? err.message : "JWT validation failed",
    );
  }
}

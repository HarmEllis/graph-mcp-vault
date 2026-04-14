import { Hono } from "hono";

// ── OidcMetadataClient ────────────────────────────────────────────────────────

/**
 * Fetches and caches the upstream OIDC provider's discovery document.
 *
 * The document is retrieved from `{oidcIssuer}/.well-known/openid-configuration`
 * and held in memory for `ttlMs` milliseconds before the next fetch.
 * A failed fetch is never cached — the next call will retry.
 */
export class OidcMetadataClient {
  private cached: unknown = null;
  private fetchedAt = 0;

  constructor(
    private readonly oidcIssuer: string,
    private readonly ttlMs: number,
    private readonly discoveryUrl?: string,
  ) {}

  /** Returns the cached metadata, re-fetching if the TTL has elapsed. */
  async getMetadata(): Promise<unknown> {
    if (this.isCacheValid()) return this.cached;

    const url =
      this.discoveryUrl ??
      `${this.oidcIssuer}/.well-known/openid-configuration`;
    const resp = await fetch(url);
    if (!resp.ok) {
      throw new Error(
        `Upstream OIDC metadata fetch failed with HTTP ${resp.status}`,
      );
    }

    this.cached = await resp.json();
    this.fetchedAt = Date.now();
    return this.cached;
  }

  private isCacheValid(): boolean {
    return this.cached !== null && Date.now() - this.fetchedAt < this.ttlMs;
  }
}

// ── Router ────────────────────────────────────────────────────────────────────

/**
 * Returns a Hono router that serves the OAuth 2.0 Authorization Server
 * Metadata document (RFC 8414) by proxying the upstream OIDC discovery
 * document through the provided `OidcMetadataClient`.
 *
 * GET /.well-known/oauth-authorization-server
 *   → 200 JSON  — upstream metadata
 *   → 502 JSON  — upstream unavailable
 */
export function createOAuthMetaRouter(
  metadataClient: OidcMetadataClient,
  scopesAllowlist?: string[],
): Hono {
  const app = new Hono();

  app.get("/.well-known/oauth-authorization-server", async (c) => {
    try {
      const metadata = (await metadataClient.getMetadata()) as Record<
        string,
        unknown
      >;

      if (scopesAllowlist === undefined) {
        return c.json(metadata);
      }

      // Filter scopes_supported to intersection with the allowlist, if provided.
      const upstreamScopes = metadata.scopes_supported;
      if (!Array.isArray(upstreamScopes)) {
        return c.json(metadata);
      }

      const filtered = {
        ...metadata,
        scopes_supported: upstreamScopes.filter(
          (s): s is string =>
            typeof s === "string" && scopesAllowlist.includes(s),
        ),
      };
      return c.json(filtered);
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "upstream unavailable";
      return c.json({ error: "upstream_unavailable", detail: message }, 502);
    }
  });

  return app;
}

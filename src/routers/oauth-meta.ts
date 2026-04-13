import { Hono } from 'hono';

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
  ) {}

  /** Returns the cached metadata, re-fetching if the TTL has elapsed. */
  async getMetadata(): Promise<unknown> {
    if (this.isCacheValid()) return this.cached;

    const url = `${this.oidcIssuer}/.well-known/openid-configuration`;
    const resp = await fetch(url);
    if (!resp.ok) {
      throw new Error(`Upstream OIDC metadata fetch failed with HTTP ${resp.status}`);
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
export function createOAuthMetaRouter(metadataClient: OidcMetadataClient): Hono {
  const app = new Hono();

  app.get('/.well-known/oauth-authorization-server', async (c) => {
    try {
      const metadata = await metadataClient.getMetadata() as Record<string, unknown>;
      // Expose only end-user OAuth scopes; Keycloak-internal scopes (service_account,
      // web-origins, etc.) must not be advertised — the MCP SDK sends all scopes_supported
      // verbatim in its dynamic client registration request, which causes Keycloak's
      // Allowed Client Scopes policy to reject the registration.
      const filtered = {
        ...metadata,
        scopes_supported: ['openid', 'profile', 'email', 'offline_access', 'graph-mcp-vault-api'],
      };
      return c.json(filtered);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'upstream unavailable';
      return c.json({ error: 'upstream_unavailable', detail: message }, 502);
    }
  });

  return app;
}

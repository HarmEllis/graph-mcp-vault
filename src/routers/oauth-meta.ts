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
 * Returns a Hono router that serves two OAuth discovery endpoints:
 *
 * GET /.well-known/oauth-protected-resource  (RFC 9728)
 *   Describes this server as a protected resource and names the upstream
 *   authorization server. MCP-compliant clients discover this endpoint via
 *   the `resource_metadata` parameter in the WWW-Authenticate response header
 *   and use `authorization_servers` to find the real token issuer — without
 *   ever triggering Dynamic Client Registration on this server.
 *   → 200 JSON
 *
 * GET /.well-known/oauth-authorization-server  (RFC 8414 proxy, backwards compat)
 *   Proxies the upstream OIDC discovery document for clients that look for
 *   auth metadata on the resource server domain rather than following RFC 9728.
 *   `registration_endpoint` is always stripped to prevent DCR attempts.
 *   → 200 JSON  — upstream metadata (filtered)
 *   → 502 JSON  — upstream unavailable
 */
export function createOAuthMetaRouter(
  metadataClient: OidcMetadataClient,
  publicUrl: string,
  oidcIssuer: string,
  scopesAllowlist?: string[],
): Hono {
  const app = new Hono();

  // ── Protected Resource Metadata (RFC 9728) ────────────────────────────────
  app.get("/.well-known/oauth-protected-resource", (c) => {
    const metadata: Record<string, unknown> = {
      resource: publicUrl,
      authorization_servers: [oidcIssuer],
      bearer_methods_supported: ["header"],
      resource_signing_alg_values_supported: ["RS256"],
    };
    if (scopesAllowlist !== undefined) {
      metadata.scopes_supported = scopesAllowlist;
    }
    return c.json(metadata);
  });

  // ── Authorization Server Metadata proxy (RFC 8414) ────────────────────────
  app.get("/.well-known/oauth-authorization-server", async (c) => {
    try {
      const upstream = (await metadataClient.getMetadata()) as Record<
        string,
        unknown
      >;

      // Always strip registration_endpoint — exposing it causes MCP clients
      // to attempt Dynamic Client Registration (DCR), which upstream providers
      // may reject with scope policy errors. Clients that need auth endpoints
      // should use /.well-known/oauth-protected-resource (RFC 9728) instead.
      const { registration_endpoint: _reg, ...metadata } = upstream;

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

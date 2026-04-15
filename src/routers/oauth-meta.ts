import { Hono } from "hono";

const FALLBACK_SCOPES = ["openid"] as const;

function asStringScopes(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.filter((scope): scope is string => typeof scope === "string");
}

function resolveSupportedScopes(
  upstreamScopes: unknown,
  scopesAllowlist: string[] | undefined,
): string[] {
  const parsedUpstreamScopes = asStringScopes(upstreamScopes);
  if (scopesAllowlist === undefined) {
    if (
      parsedUpstreamScopes === undefined ||
      parsedUpstreamScopes.length === 0
    ) {
      return [...FALLBACK_SCOPES];
    }
    return parsedUpstreamScopes;
  }

  if (parsedUpstreamScopes === undefined || parsedUpstreamScopes.length === 0) {
    return scopesAllowlist;
  }

  return parsedUpstreamScopes.filter((scope) =>
    scopesAllowlist.includes(scope),
  );
}

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
 * Returns a Hono router that serves three OAuth endpoints:
 *
 * GET /.well-known/oauth-protected-resource  (RFC 9728)
 *   Describes this server as a protected resource. Points `authorization_servers`
 *   to `publicUrl` (this server), so clients fetch OUR authorization server
 *   metadata — not the upstream IdP's — and never see the upstream
 *   `registration_endpoint`.
 *   → 200 JSON
 *
 * GET /.well-known/oauth-authorization-server  (RFC 8414 proxy)
 *   Proxies the upstream OIDC discovery document with three modifications:
 *   1. `issuer` is overridden to `publicUrl` (RFC 8414 §3.3 requires issuer to
 *      match the URL the document was fetched from).
 *   2. `registration_endpoint` is replaced with `<publicUrl>/clients` — our own
 *      DCR proxy, which returns the pre-configured client ID without forwarding
 *      to the upstream provider's DCR service.
 *   3. `scopes_supported` is filtered to the allowlist, if configured.
 *   → 200 JSON  — modified upstream metadata
 *   → 502 JSON  — upstream unavailable
 *
 * POST /clients  (RFC 7591 Dynamic Client Registration proxy)
 *   Returns the pre-configured `clientId` so MCP clients that require DCR
 *   (e.g. Claude Code with no explicit clientId in their config) receive a
 *   usable client identity without the upstream IdP's scope-policy restrictions.
 *   The client is registered as public (`token_endpoint_auth_method: "none"`),
 *   which matches PKCE flows that do not send a client secret.
 *   `redirect_uris` from the request are echoed back; the upstream IdP must be
 *   configured with permissive redirect URIs for the pre-configured client.
 *   → 201 JSON
 */
export function createOAuthMetaRouter(
  metadataClient: OidcMetadataClient,
  publicUrl: string,
  oidcIssuer: string,
  clientId: string,
  scopesAllowlist?: string[],
  injectMissingScope = false,
): Hono {
  const app = new Hono();

  // ── Protected Resource Metadata (RFC 9728) ────────────────────────────────
  // authorization_servers points to publicUrl so clients fetch our filtered
  // /.well-known/oauth-authorization-server, not the raw upstream IdP endpoint.
  app.get("/.well-known/oauth-protected-resource", (c) => {
    const metadata: Record<string, unknown> = {
      resource: publicUrl,
      authorization_servers: [publicUrl],
      bearer_methods_supported: ["header"],
      resource_signing_alg_values_supported: ["RS256"],
      scopes_supported: scopesAllowlist ?? [...FALLBACK_SCOPES],
    };
    return c.json(metadata);
  });

  // ── Authorization Server Metadata proxy (RFC 8414) ────────────────────────
  app.get("/.well-known/oauth-authorization-server", async (c) => {
    try {
      const upstream = (await metadataClient.getMetadata()) as Record<
        string,
        unknown
      >;

      // Replace registration_endpoint with our DCR proxy so MCP clients never
      // interact with the upstream IdP's client registration directly.
      // We intentionally keep the upstream issuer so that MCP clients can
      // validate the `iss` claim of tokens issued by the upstream IdP against
      // the issuer advertised here. Overriding issuer to publicUrl would cause
      // token validation to fail because the IdP stamps tokens with its own
      // issuer, not ours.
      const { registration_endpoint: _reg, ...rest } = upstream;

      const base: Record<string, unknown> = {
        ...rest,
        registration_endpoint: `${publicUrl}/clients`,
      };
      const withScopes: Record<string, unknown> = {
        ...base,
        scopes_supported: resolveSupportedScopes(
          base.scopes_supported,
          scopesAllowlist,
        ),
      };
      // When scope injection is enabled the authorization_endpoint is overridden
      // to our own proxy so we can add the missing scope parameter before
      // forwarding to the upstream IdP.
      if (injectMissingScope) {
        withScopes.authorization_endpoint = `${publicUrl}/authorize`;
      }
      return c.json(withScopes);
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "upstream unavailable";
      return c.json({ error: "upstream_unavailable", detail: message }, 502);
    }
  });

  // ── DCR proxy (RFC 7591) ─────────────────────────────────────────────────
  // Returns the pre-configured clientId as a public (PKCE) client so that MCP
  // clients that perform Dynamic Client Registration do not need to interact
  // with the upstream IdP's DCR service at all.
  app.post("/clients", async (c) => {
    let body: Record<string, unknown> = {};
    try {
      body = (await c.req.json()) as Record<string, unknown>;
    } catch {
      // Ignore parse errors — treat missing body as empty registration request.
    }

    const redirectUris = Array.isArray(body.redirect_uris)
      ? body.redirect_uris
      : [];

    // Include scope so clients know which scopes to request in the authorization
    // request. Without this, clients like Open WebUI send no scope parameter to
    // the IdP, which causes providers like Pocket ID to reject with
    // "scope is required". Use the allowlist if configured, else fall back to
    // the minimal "openid" scope.
    const scope =
      scopesAllowlist !== undefined ? scopesAllowlist.join(" ") : "openid";

    const response: Record<string, unknown> = {
      client_id: clientId,
      client_id_issued_at: Math.floor(Date.now() / 1000),
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code"],
      response_types: ["code"],
      redirect_uris: redirectUris,
      scope,
    };

    return c.json(response, 201);
  });

  // ── Authorization proxy (scope injection) ────────────────────────────────
  // Only registered when INJECT_MISSING_SCOPE is enabled. Acts as a thin
  // passthrough in front of the upstream authorization endpoint: copies all
  // query parameters forwarded by the MCP client and adds a `scope` parameter
  // if the client did not include one. This works around MCP clients (e.g.
  // Open WebUI) that omit `scope` from the authorization request, causing
  // strict OIDC providers (e.g. Pocket ID) to reject with "scope is required".
  if (injectMissingScope) {
    app.get("/authorize", async (c) => {
      let upstreamAuthEndpoint: string;
      try {
        const upstream = (await metadataClient.getMetadata()) as Record<
          string,
          unknown
        >;
        if (typeof upstream.authorization_endpoint !== "string") {
          return c.json(
            {
              error: "upstream_unavailable",
              detail: "no authorization_endpoint in upstream metadata",
            },
            502,
          );
        }
        upstreamAuthEndpoint = upstream.authorization_endpoint;
      } catch (err) {
        const message =
          err instanceof Error ? err.message : "upstream unavailable";
        return c.json({ error: "upstream_unavailable", detail: message }, 502);
      }

      const params = new URLSearchParams(
        c.req.query() as Record<string, string>,
      );
      if (!params.has("scope")) {
        params.set("scope", scopesAllowlist?.join(" ") ?? "openid");
      }

      return c.redirect(`${upstreamAuthEndpoint}?${params.toString()}`, 302);
    });
  }

  return app;
}

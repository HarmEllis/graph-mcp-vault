# graph-mcp-vault — Open WebUI Setup Example

This document is an Open WebUI-focused setup example.
The proxy itself is provider-agnostic and works with any standards-compliant OIDC/OAuth2 provider.
Pocket ID is only one example provider, not a hard dependency.

## 1. Register the MCP Proxy as an OIDC Client

Create a new OIDC client in your identity provider (for example Pocket ID, Keycloak, Auth0, Okta, Entra ID).

| Field | Value |
|---|---|
| Name | `graph-mcp-vault` |
| Client ID | `graph-mcp-vault` |
| Redirect URIs | `https://graph-mcp-vault.your-domain.com/oauth/callback` and `http://localhost:27123/oauth/callback` (Claude Code local callback) |
| Grant types | `authorization_code`, `refresh_token` |
| PKCE | Required (Claude Code uses PKCE without a client secret) |
| Scopes | `openid`, `profile`, `email` |

Save the `client_id` and `client_secret` (if your provider uses one for confidential clients).

## 2. Add the MCP Server in Open WebUI

Open WebUI supports MCP through the **Tools** section with OAuth2.

### Global MCP tool (all users)

1. Go to **Admin → Settings → Tools**.
2. Click **Add MCP Server**.
3. Configure:
   - **URL**: `https://graph-mcp-vault.your-domain.com/mcp`
   - **Auth type**: OAuth2
   - **Client ID**: `graph-mcp-vault`
   - **Discovery URL**: `https://graph-mcp-vault.your-domain.com/.well-known/oauth-authorization-server`
4. Save. Open WebUI will start the OAuth flow on first use.

### Per assistant/workspace (namespace via URL)

Create a separate **Custom Assistant** per workspace:

1. Go to **Workspace → Assistants → New Assistant**.
2. Under **Tools → MCP Servers**, add one URL per namespace:
   - Homelab assistant: `https://graph-mcp-vault.your-domain.com/mcp/homelab`
   - Personal assistant: `https://graph-mcp-vault.your-domain.com/mcp/personal`
   - Work assistant: `https://graph-mcp-vault.your-domain.com/mcp/work`
3. Use the same OAuth settings as above.

## 3. Add the MCP Server in Claude Code

Add to `~/.claude/mcp.json` (or use `claude mcp add`):

```json
{
  "mcpServers": {
    "neo4j-homelab": {
      "type": "http",
      "url": "https://graph-mcp-vault.your-domain.com/mcp/homelab",
      "auth": {
        "type": "oauth2",
        "clientId": "graph-mcp-vault",
        "authorizationUrl": "https://idp.your-domain.com/authorize",
        "tokenUrl": "https://idp.your-domain.com/token",
        "scopes": ["openid", "profile", "email"]
      }
    },
    "neo4j-personal": {
      "type": "http",
      "url": "https://graph-mcp-vault.your-domain.com/mcp/personal",
      "auth": {
        "type": "oauth2",
        "clientId": "graph-mcp-vault",
        "authorizationUrl": "https://idp.your-domain.com/authorize",
        "tokenUrl": "https://idp.your-domain.com/token",
        "scopes": ["openid", "profile", "email"]
      }
    }
  }
}
```

At first use, Claude Code opens your browser for provider login.
Tokens are cached locally (`~/.claude/`) and refreshed automatically.

### CLI alternative

```bash
claude mcp add neo4j-homelab \
  --type http \
  --url https://graph-mcp-vault.your-domain.com/mcp/homelab \
  --oauth2-client-id graph-mcp-vault \
  --oauth2-discovery https://graph-mcp-vault.your-domain.com/.well-known/oauth-authorization-server
```

## 4. n8n / Service Accounts

Register a second OIDC client for machine-to-machine usage if your provider supports `client_credentials`.

| Field | Value |
|---|---|
| Name | `graph-mcp-vault-service` |
| Grant types | `client_credentials` |
| Redirect URI | Not required |

In n8n, use an **HTTP Request** node:
- URL: `https://idp.your-domain.com/token`
- Body: `grant_type=client_credentials&client_id=...&client_secret=...`
- Send the returned token as `Authorization: Bearer <token>` to the MCP proxy

The `sub` claim from the service account token becomes `user_id` in Neo4j
(for example `homelab-service`). Combine this with namespace `/mcp/homelab`.

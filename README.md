# graph-mcp-vault

A multi-tenant MCP proxy server that exposes Neo4j as an MCP tool server.
Each user's data lives in a **namespace** and is access-controlled by role.
Identity is delegated to any standards-compliant OIDC/OAuth2 provider.

MCP transport: **Streamable HTTP 2025-03-26** — JSON-only responses, no SSE.

---

## Contents

- [Quick start](#quick-start)
- [Environment variables](#environment-variables)
- [Authentication](#authentication)
- [Namespaces](#namespaces)
- [MCP tools](#mcp-tools)
- [Permissions](#permissions)
- [Session lifecycle](#session-lifecycle)
- [Client setup](#client-setup)
- [Development](#development)

---

## Quick start

```bash
# 1. Copy and fill in your environment
cp .env.example .env
$EDITOR .env          # set OIDC_ISSUER, OIDC_AUDIENCE, NEO4J_PASSWORD at minimum

# 2. Start Neo4j + the server
docker compose up -d

# 3. Verify the server is up
curl http://localhost:8000/.well-known/oauth-authorization-server
```

The server schema-initialises Neo4j on first boot (idempotent, safe to restart).

---

## Environment variables

Copy `.env.example` to `.env` before running.

| Variable | Required | Default | Description |
|---|---|---|---|
| `OIDC_ISSUER` | yes | — | Base URL of your OIDC provider (e.g. `https://idp.example.com`) |
| `OIDC_AUDIENCE` | yes | — | Expected `aud` claim in incoming JWTs (e.g. `graph-mcp-vault`) |
| `JWKS_CACHE_TTL` | no | `3600` | Seconds to cache the provider's JWKS response |
| `METADATA_CACHE_TTL` | no | `3600` | Seconds to cache the OpenID Connect discovery document |
| `NEO4J_URI` | no | `bolt://neo4j:7687` | Bolt URI for Neo4j (use `bolt://localhost:7687` outside Docker) |
| `NEO4J_USER` | no | `neo4j` | Neo4j username |
| `NEO4J_PASSWORD` | yes | — | Neo4j password; also used to configure the neo4j Docker service |
| `HOST` | no | `0.0.0.0` | Bind address |
| `PORT` | no | `8000` | Listen port |
| `DEFAULT_NAMESPACE` | no | `default` | Namespace used when none is specified at session open |
| `LOG_LEVEL` | no | `info` | Log verbosity (`debug`, `info`, `warn`, `error`) |
| `ALLOWED_ORIGINS` | no | `""` | Comma-separated CORS origins; `*` for any; empty = no cross-origin requests |

---

## Authentication

Every request must carry a Bearer JWT issued by the configured OIDC provider:

```
Authorization: Bearer <jwt>
```

The server:

1. Extracts the `kid` from the JWT header.
2. Fetches the provider's JWKS from `{OIDC_ISSUER}/.well-known/jwks.json` (cached).
3. Verifies the RS256 signature, `iss`, `aud`, `exp`, and `nbf` (30 s clock tolerance).
4. Uses the `sub` claim as the persistent user identity in Neo4j.

An unknown `kid` triggers a one-time JWKS cache refresh before failing.

---

## Namespaces

Every resource belongs to exactly one namespace. Namespaces provide multi-tenant
data isolation — a session in namespace `work` cannot see resources in `homelab`.

### How a session's namespace is resolved (first match wins)

1. `params.meta.namespace` in the `initialize` request body
2. URL path: `POST /mcp/{namespace}`
3. `DEFAULT_NAMESPACE` from config

### Example: namespace via URL

```
POST /mcp/homelab   →  session namespace = "homelab"
POST /mcp/personal  →  session namespace = "personal"
POST /mcp           →  session namespace = DEFAULT_NAMESPACE
```

Once a session is created, its namespace is fixed. Sending a request to
`/mcp/other-ns` with a session that belongs to `homelab` returns
**HTTP 404 SESSION_NAMESPACE_CONFLICT**.

### Cross-namespace reads

Any tool that accepts a `namespace` argument (e.g. `list_resources`) can
explicitly target a different namespace. The session namespace is the default;
passing `namespace: "other"` overrides it for that single call.

---

## MCP tools

### Resource tools

#### `create_resource`

Create a new resource in the session namespace (or a specified namespace).

```json
{
  "type": "note",
  "title": "My note",
  "content": "Hello world",
  "namespace": "optional-override"
}
```

Returns `{ "id": "<uuid>", "created_at": "<iso8601>" }`.

---

#### `get_resource`

Fetch a resource by ID. Requires at least read access.

```json
{ "resource_id": "<uuid>" }
```

Returns the full resource object plus an `"ownership"` field (`"owner"` or `"shared"`).

---

#### `list_resources`

List all resources the caller can read (owned + shared) in a namespace.

```json
{
  "namespace": "optional — defaults to session namespace",
  "type": "optional type filter",
  "limit": 50,
  "skip": 0
}
```

Returns `{ "resources": [ ... ] }` ordered by `updated_at` descending.

---

#### `update_resource`

Update the title and/or content of a resource. Requires editor or owner role.

```json
{
  "resource_id": "<uuid>",
  "title": "New title",
  "content": "New content"
}
```

Returns `{}`.

---

#### `delete_resource`

Delete a resource and all its relationships. Owner only.

```json
{ "resource_id": "<uuid>" }
```

Returns `{}`.

---

### Sharing tools

#### `share_resource`

Grant another user access to a resource. Owner only.

```json
{
  "resource_id": "<uuid>",
  "target_user_id": "other-user-sub",
  "role": "viewer"
}
```

`role` is `"viewer"` (read-only) or `"editor"` (read + write).
Returns `{}`.

---

#### `revoke_access`

Remove a user's access to a resource. Owner only. Cannot revoke your own access.

```json
{
  "resource_id": "<uuid>",
  "target_user_id": "other-user-sub"
}
```

Returns `{}`.

---

#### `list_sharing`

List all users with access to a resource. Requires read access.

```json
{ "resource_id": "<uuid>" }
```

Returns `{ "sharing": [{ "user_id", "role", "granted_at" }] }`.

---

## Permissions

| Operation | Minimum role |
|---|---|
| Read resource / list sharing | viewer |
| Update resource | editor |
| Delete resource | owner |
| Share resource | owner |
| Revoke access | owner |

Roles are stored as `HAS_ACCESS` relationships in Neo4j. The resource creator
automatically becomes the owner via an `OWNS` relationship.

---

## Session lifecycle

```
POST /mcp   initialize   →   HTTP 200  +  Mcp-Session-Id: <uuid>  (header + result.meta.sessionId)
POST /mcp   tools/list   →   HTTP 200  (Mcp-Session-Id required)
POST /mcp   tools/call   →   HTTP 200  (Mcp-Session-Id required)
```

- Sessions expire after **24 hours of inactivity**.
- Background cleanup runs every hour.
- The `Mcp-Session-Id` must be sent as a request header on every call after `initialize`.
- Missing session ID → **HTTP 400 INVALID_REQUEST**.
- Unknown or expired session ID → **HTTP 404 SESSION_NOT_FOUND**.

### JSON-RPC batch

Send an array of requests/notifications:

```json
[
  { "jsonrpc": "2.0", "id": 1, "method": "tools/list" },
  { "jsonrpc": "2.0", "method": "notifications/initialized" }
]
```

- Each request gets a result entry; notifications are silently dropped.
- All-notifications batch → **HTTP 202** empty body.
- Session errors are per-entry in the response array; batch HTTP status is always **200**.

---

## Error reference

| HTTP | JSON-RPC code | Constant | Meaning |
|---|---|---|---|
| 400 | -32700 | `PARSE_ERROR` | Malformed JSON body |
| 400 | -32600 | `INVALID_REQUEST` | Bad envelope or missing `Mcp-Session-Id` |
| 200 | -32601 | `METHOD_NOT_FOUND` | Unknown MCP method or tool name |
| 200 | -32602 | `INVALID_PARAMS` | Tool parameter validation failure |
| 404 | -32000 | `SESSION_NOT_FOUND` | Unknown or expired session |
| 404 | -32001 | `SESSION_NAMESPACE_CONFLICT` | URL namespace ≠ session namespace |
| 200 | -32002 | `PERMISSION_DENIED` | Insufficient role |
| 200 | -32003 | `RESOURCE_NOT_FOUND` | Resource does not exist |
| 500 | -32004 | `INTERNAL_ERROR` | Unexpected server error |

---

## Client setup

### Claude Code

Add to `~/.claude/mcp.json` (one entry per namespace):

```json
{
  "mcpServers": {
    "vault-homelab": {
      "type": "http",
      "url": "https://graph-mcp-vault.example.com/mcp/homelab",
      "auth": {
        "type": "oauth2",
        "clientId": "graph-mcp-vault",
        "authorizationUrl": "https://idp.example.com/authorize",
        "tokenUrl": "https://idp.example.com/token",
        "scopes": ["openid", "profile"]
      }
    }
  }
}
```

Or via CLI:

```bash
claude mcp add vault-homelab \
  --type http \
  --url https://graph-mcp-vault.example.com/mcp/homelab \
  --oauth2-client-id graph-mcp-vault \
  --oauth2-discovery https://graph-mcp-vault.example.com/.well-known/oauth-authorization-server
```

### Open WebUI

See [`docs/OPEN_WEBUI_SETUP_EXAMPLE.md`](docs/OPEN_WEBUI_SETUP_EXAMPLE.md) for a complete
walkthrough including per-assistant namespace setup and service account configuration.

---

## Development

### Prerequisites

- Node.js 24+
- pnpm
- Docker (for integration tests and local stack)

### Install

```bash
pnpm install
```

### Run tests

```bash
pnpm test                        # all tests (requires Docker for Neo4j containers)
pnpm vitest run tests/auth.test.ts       # single file
pnpm vitest                      # watch mode
```

Integration tests spin up a temporary `neo4j:5-community` container per test file
via Testcontainers. Docker must be running.

### Type-check and build

```bash
pnpm build    # tsc — outputs to dist/
```

### Run locally (without Docker)

```bash
# Start Neo4j separately, then:
NEO4J_URI=bolt://localhost:7687 pnpm start
```

### Docker Compose

```bash
docker compose up -d          # start Neo4j + server
docker compose logs -f        # follow logs
docker compose down           # stop (data volume persists)
docker compose down -v        # stop and delete Neo4j data
```

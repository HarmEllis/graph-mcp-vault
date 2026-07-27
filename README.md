# graph-mcp-vault

A multi-tenant MCP knowledge memory bank backed by Neo4j.
Store notes, decisions, facts, and documentation as structured entries in named namespaces,
with per-user role-based access control.
Identity is delegated to any standards-compliant OIDC/OAuth2 provider.

MCP transport: **Streamable HTTP 2025-03-26** — JSON-only responses, no SSE.

---

## Contents

- [Quick start (development)](#quick-start-development)
- [Production deployment](#production-deployment)
- [Environment variables](#environment-variables)
- [Authentication](#authentication)
- [API key authentication](#api-key-authentication)
- [Namespaces](#namespaces)
- [MCP tools](#mcp-tools)
- [Permissions](#permissions)
- [Session lifecycle](#session-lifecycle)
- [Client setup](#client-setup)
- [Development](#development)
- [Changelog](#changelog)
- [Release](#release)

---

## Quick start (development)

Uses `docker-compose.dev.yml` which builds the server locally and includes a Keycloak dev realm for testing.

```bash
# 1. Copy and fill in your environment
cp .env.example .env
$EDITOR .env          # set at least NEO4J_PASSWORD

# 2. Start Neo4j + Keycloak + the server (local build)
docker compose -f docker-compose.dev.yml up -d

# 3. Verify the OAuth metadata endpoint
curl http://localhost:8000/.well-known/oauth-authorization-server

# 4. Fetch a dev token (preconfigured Keycloak realm/client/user)
TOKEN="$(curl -sS -X POST http://localhost:8081/realms/graph-mcp-vault/protocol/openid-connect/token \
  -H 'content-type: application/x-www-form-urlencoded' \
  -d 'grant_type=password' \
  -d 'scope=openid profile email' \
  -d 'client_id=graph-mcp-vault' \
  -d 'client_secret=dev-secret' \
  -d 'username=dev-user' \
  -d 'password=dev-password' | jq -r '.access_token')"

# 5. Call MCP with Bearer token
curl -i -X POST http://localhost:8000/mcp \
  -H "authorization: Bearer $TOKEN" \
  -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":"init-1","method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"curl","version":"1.0.0"}}}'
```

On first boot the server runs schema initialisation and migrations against Neo4j (idempotent, safe to restart).

> **Migrating from an older version?** The development stack file was renamed from `docker-compose.yml` to `docker-compose.dev.yml`. Replace `docker compose up -d` with `docker compose -f docker-compose.dev.yml up -d` in your scripts.

---

## Production deployment

`docker-compose.yml` is the production stack. It requires a Bring-Your-Own OIDC provider (Pocket ID, Auth0, Keycloak, etc.) and creates isolated Docker networks so Neo4j is not reachable from outside the app.

```bash
cp .env.example .env
$EDITOR .env   # set OIDC_ISSUER, OIDC_AUDIENCE, PUBLIC_URL, NEO4J_PASSWORD, ALLOWED_ORIGINS
docker compose up -d
```

See `docker-compose.yml` for the full service definition and `docker-compose.dev.yml` for the development stack.

### Minimum hardening checklist (Bunkerweb / reverse proxy)

- [ ] TLS + HSTS enabled on the reverse proxy
- [ ] Rate limit configured on `/mcp` (e.g. 60 req/min per IP)
- [ ] Body size cap enforced at proxy level (align with `MAX_REQUEST_BODY_BYTES`)
- [ ] Neo4j port not exposed to the host (`internal: true` network in `docker-compose.yml`)

### Deployment notes

- **In-memory sessions**: sessions are stored in-memory and are lost on restart. This is acceptable for single-instance deployments. No sticky sessions or shared session store are required.

---

## Environment variables

Copy `.env.example` to `.env` before running.

| Variable | Required | Default | Description |
|---|---|---|---|
| `OIDC_ISSUER` | yes | — | Base URL of your OIDC provider (e.g. `https://idp.example.com`) |
| `OIDC_AUDIENCE` | yes | — | Expected `aud` claim in incoming JWTs (e.g. `graph-mcp-vault`) |
| `JWKS_CACHE_TTL` | no | `3600` | Seconds to cache the provider's JWKS response |
| `JWKS_FORCE_REFRESH_MIN_INTERVAL_SECONDS` | no | `30` | Minimum seconds between forced JWKS refreshes (flood protection) |
| `JWKS_FETCH_TIMEOUT_MS` | no | `5000` | Timeout in milliseconds for JWKS fetch requests |
| `JWKS_ALLOW_STALE_ON_ERROR` | no | `false` | Serve stale JWKS cache on fetch error instead of failing |
| `MAX_TOKEN_LIFETIME_SECONDS` | no | `3600` | Maximum allowed token lifetime (`exp - iat`); longer tokens are rejected |
| `MAX_REQUEST_BODY_BYTES` | no | `262144` | Maximum request body size in bytes (256 KiB); larger bodies return 413 |
| `METADATA_CACHE_TTL` | no | `3600` | Seconds to cache the OpenID Connect discovery document |
| `NEO4J_URI` | no | `bolt://neo4j:7687` | Bolt URI for Neo4j (use `bolt://localhost:7687` outside Docker) |
| `NEO4J_USER` | no | `neo4j` | Neo4j username |
| `NEO4J_PASSWORD` | yes | — | Neo4j password; also used to configure the neo4j Docker service |
| `HOST` | no | `0.0.0.0` | Bind address |
| `PORT` | no | `8000` | Listen port |
| `PUBLIC_URL` | no | `http://localhost:PORT` | Public URL of this server, used in OAuth metadata and `WWW-Authenticate` headers |
| `DEFAULT_NAMESPACE` | no | `default` | Namespace used when none is specified at session open |
| `LOG_LEVEL` | no | `info` | Log verbosity (`trace`, `debug`, `info`, `warn`, `error`) |
| `ALLOWED_ORIGINS` | no | `""` | Comma-separated CORS origins; `*` for any; empty = no cross-origin requests |
| `SCOPES_ALLOWLIST` | no | provider scopes (fallback `openid`) | Comma-separated scopes exposed in OAuth metadata (recommended: `openid,profile,email`) |
| `API_KEYS_ENABLED` | no | `false` | Enable API key authentication for non-OIDC clients |
| `API_KEYS_MAX_PER_USER` | no | `20` | Maximum active (non-revoked) API keys per user |
| `API_KEYS_HASH_SECRET` | when `API_KEYS_ENABLED=true` | — | Secret used to hash API keys (min 32 chars); changing it invalidates all existing keys |

---

## Authentication

Every request must carry a Bearer JWT issued by the configured OIDC provider:

```
Authorization: Bearer <jwt>
```

The server:

1. Extracts the `kid` from the JWT header.
2. Fetches the provider's JWKS from `{OIDC_ISSUER}/.well-known/jwks.json` (cached, TTL controlled by `JWKS_CACHE_TTL`).
3. Verifies the RS256 signature, `iss`, `aud`, `exp`, and `nbf` (30 s clock tolerance).
4. Rejects tokens whose lifetime (`exp - iat`) exceeds `MAX_TOKEN_LIFETIME_SECONDS`.
5. Uses the `sub` claim as the persistent user identity in Neo4j.

An unknown `kid` triggers a one-time JWKS cache refresh before failing. Repeated unknown-`kid` requests are throttled via `JWKS_FORCE_REFRESH_MIN_INTERVAL_SECONDS` to prevent JWKS endpoint flooding.

---

## API key authentication

For automation, CI pipelines, or MCP clients that do not support OAuth2 browser flows, the server supports API key authentication as an alternative to OIDC JWTs.

### Enabling API keys

Set the following environment variables:

```env
API_KEYS_ENABLED=true
API_KEYS_HASH_SECRET=your-long-random-secret-at-least-32-chars
```

### Creating a key

API keys are created through the MCP tool `knowledge_create_api_key` during an **OIDC-authenticated session**. This means a user must first authenticate via OAuth2/OIDC, then use the tool to mint an API key for subsequent headless access.

### Using an API key

Send the key as a Bearer token in the `Authorization` header:

```
Authorization: Bearer gmv_<hex>
```

The server detects API keys by their `gmv_` prefix and routes them to API key validation instead of JWT verification.

### Key properties

- **Prefix**: all keys start with `gmv_` followed by 64 hex characters.
- **Namespace restriction**: keys can optionally be scoped to specific namespaces. A namespace-restricted key can work across its whole allow-list but cannot access namespaces outside it. Add `?lock_namespace=true` to confine such a session to a single namespace.
- **Expiry**: keys can have an optional expiry (1–365 days). Keys without an expiry never expire.
- **Per-user limit**: each user can hold at most `API_KEYS_MAX_PER_USER` active (non-revoked) keys (default: 20).
- **Hashing**: keys are stored as scrypt digests; the raw key is returned exactly once at creation and cannot be recovered.
- **Privilege escalation prevention**: a namespace-scoped caller cannot mint, list, or revoke a key with broader scope than its own effective namespace scope.

### Management tools

See [API key tools](#api-key-tools) below for the full tool reference.

---

## Namespaces

Every knowledge entry belongs to exactly one namespace, which organises entries into
separate workspaces.

A namespace is **not** an isolation boundary by itself: the session namespace is only the
default used by calls that omit one. By default a session may still target another
namespace explicitly, search across all of them, and traverse relations that cross the
boundary. What a session can actually reach is its [namespace scope](#namespace-scope) —
use `?lock_namespace=true` or a single-namespace API key allow-list to confine a client to
one namespace.

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

### Cross-namespace access

Any tool that accepts a `namespace` argument (e.g. `knowledge_list_entries`) can
explicitly target a different namespace. The session namespace is the default;
passing `namespace: "other"` overrides it for that single call.

Relations may connect entries in **different** namespaces, and graph traversal
(`knowledge_expand_context`, `knowledge_find_paths`,
`knowledge_explain_relationship`, `knowledge_impact_analysis`) follows those
edges across the boundary. Relation and traversal results carry each entry's
`namespace` so the caller can tell them apart.

### Namespace scope

Every session has an **effective namespace scope** that bounds what it can see
and write. It is derived as follows (see
[D-033](docs/DECISIONS.md#d-033--cross-namespace-entry-relations-and-explicit-session-namespace-scope-breaking)):

| Session | Effective scope |
|---|---|
| JWT | unrestricted |
| JWT with `?lock_namespace=true` | the session namespace only |
| API key with a `namespaces` allow-list | that allow-list |
| API key with allow-list + `?lock_namespace=true` | the session namespace only |

A hard lock always wins. Within the scope, per-entry permissions still apply —
the scope narrows access, it never widens it. Entries outside the scope are
invisible: they cannot be read, related, or reached through traversal, and they
do not appear in search results, `knowledge_list_namespaces`, or relation counts.

Use `?lock_namespace=true` when a client must be confined to a single namespace.

---

## MCP tools

The server exposes up to 27 MCP tools (24 always-on, plus 3 API key management tools when
`API_KEYS_ENABLED=true`). LLMs should **search before creating** to avoid duplicate entries.

### Knowledge entry tools

#### `knowledge_create_entry`

Save a new knowledge entry to the memory bank. Use this to store notes, decisions, facts,
documentation snippets, or any information worth remembering.

```json
{
  "entry_type": "note",
  "title": "My note",
  "content": "Hello world",
  "namespace": "optional-override",
  "topic": "optional subject area",
  "tags": ["optional", "keywords"],
  "summary": "optional one-sentence summary",
  "source": "https://optional-source-url.example.com",
  "last_verified_at": "2026-04-14T00:00:00.000Z"
}
```

Returns `{ "id": "<uuid>", "created_at": "<iso8601>" }`.

---

#### `knowledge_get_entry`

Fetch a knowledge entry by ID. Requires at least read access.

```json
{ "entry_id": "<uuid>" }
```

Returns the full entry object plus a `"role"` field (`"owner"`, `"editor"`, or `"viewer"`).

---

#### `knowledge_list_entries`

List all knowledge entries the caller can read (owned and shared) in a namespace.

```json
{
  "namespace": "optional — defaults to session namespace",
  "entry_type": "optional type filter",
  "limit": 50,
  "skip": 0
}
```

Returns `{ "resources": [ ... ] }` ordered by `updated_at` descending.

---

#### `knowledge_update_entry`

Update an entry's title, content, or metadata. Requires editor or owner role.
Retrieve the entry first to see its current state.

```json
{
  "entry_id": "<uuid>",
  "title": "New title",
  "content": "New content",
  "summary": "Updated summary",
  "tags": ["updated", "tags"],
  "topic": "new-topic",
  "source": "https://new-source.example.com",
  "last_verified_at": "2026-04-14T12:00:00.000Z"
}
```

Returns `{}`.

---

#### `knowledge_delete_entry`

Delete a knowledge entry and all its access grants. Owner only. Irreversible.

```json
{ "entry_id": "<uuid>" }
```

Returns `{}`.

---

#### `knowledge_search_entries`

Search the knowledge memory bank by keyword. Always call this before creating new entries
to avoid duplicates. Only returns entries the caller can read.

```json
{
  "query": "search keywords",
  "namespace": "optional — defaults to session namespace",
  "entry_type": "optional type filter",
  "limit": 20,
  "skip": 0,
  "match_mode": "fuzzy"
}
```

`match_mode` options:
- `"fuzzy"` (default) — per-token fuzzy matching with edit-distance tolerance for typos
- `"fulltext"` — exact keyword match (Lucene escaped)
- `"exact"` — phrase match (entire query treated as a phrase)

Returns `{ "resources": [ ... ] }`.

---

### Relation tools

#### `knowledge_create_relation`

Create a typed relation between two knowledge entries. Requires at least read (viewer) access
to both entries. The two entries may belong to different namespaces.

```json
{
  "from_id": "<uuid>",
  "to_id": "<uuid>",
  "relation_type": "DEPENDS_ON",
  "label": "optional free-text description"
}
```

`relation_type` must be `UPPER_SNAKE_CASE` (e.g. `DEPENDS_ON`, `RUNS_ON`, `CONNECTS_TO`).
Returns `{}`. Creating the same typed relation twice is idempotent (MERGE semantics).

---

#### `knowledge_delete_relation`

Delete a typed relation between two entries. Requires owner role on the source entry.

```json
{
  "from_id": "<uuid>",
  "to_id": "<uuid>",
  "relation_type": "DEPENDS_ON"
}
```

Returns `{}`. No-op if the relation does not exist.

---

#### `knowledge_list_relations`

List the relations of a knowledge entry. Returns relations in the requested direction,
filtered to counterpart entries the caller can read.

```json
{
  "entry_id": "<uuid>",
  "direction": "both",
  "limit": 100
}
```

`direction` is `"outbound"` (entry → other), `"inbound"` (other → entry), or `"both"` (default).
`limit` defaults to 100; max 500. Values above the cap are rejected with `INVALID_PARAMS`.

Returns:
```json
{
  "relations": [
    {
      "direction": "outbound",
      "relation_type": "DEPENDS_ON",
      "label": "optional label",
      "entry": { "id": "<uuid>", "title": "Other Entry" }
    }
  ]
}
```

---

#### `knowledge_expand_context`

Traverse the entry-relation graph outward from an anchor entry and return all reachable
entries grouped by hop distance. Only entries the caller can read are included; paths
through inaccessible nodes are excluded.

```json
{
  "entry_id": "<uuid>",
  "direction": "both",
  "max_hops": 3,
  "relation_types": ["DEPENDS_ON"],
  "limit": 50
}
```

| Parameter | Default | Max | Notes |
|-----------|---------|-----|-------|
| `direction` | `"both"` | — | `"outbound"`, `"inbound"`, or `"both"` |
| `max_hops` | 3 | **4** | Rejected above cap |
| `limit` | 50 | **200** | Total nodes across all hops; rejected above cap |
| `relation_types` | all | — | Array of `UPPER_SNAKE_CASE` strings |

Returns:
```json
{
  "layers": [
    { "distance": 1, "entries": [{ "id": "<uuid>", "title": "..." }] },
    { "distance": 2, "entries": [{ "id": "<uuid>", "title": "..." }] }
  ]
}
```

---

#### `knowledge_find_paths`

Find all directed paths between two entries via entry-relation edges. Traversal crosses
namespaces; only paths where every node is readable by the caller and inside the session's
namespace scope are returned.

```json
{
  "from_id": "<uuid>",
  "to_id": "<uuid>",
  "max_depth": 4,
  "max_paths": 5,
  "relation_types": ["DEPENDS_ON"]
}
```

| Parameter | Default | Max | Notes |
|-----------|---------|-----|-------|
| `max_depth` | 4 | **6** | Rejected above cap |
| `max_paths` | 5 | **10** | Rejected above cap |
| `relation_types` | all | — | Array of `UPPER_SNAKE_CASE` strings |

Returns:
```json
{
  "paths": [
    {
      "nodes": [{ "id": "<uuid>", "title": "..." }, ...],
      "relations": [{ "relation_type": "DEPENDS_ON", "label": "..." }, ...]
    }
  ]
}
```

---

#### `knowledge_impact_analysis`

Find all entries that transitively depend on (point to) the anchor entry, grouped by
hop distance. Answers "what would be affected if this entry changes?". Only readable
entries are included; paths through inaccessible nodes are excluded.

```json
{
  "entry_id": "<uuid>",
  "max_depth": 4,
  "relation_types": ["DEPENDS_ON"],
  "limit": 50
}
```

| Parameter | Default | Max | Notes |
|-----------|---------|-----|-------|
| `max_depth` | 4 | **6** | Rejected above cap |
| `limit` | 50 | **200** | Total entries across all layers; rejected above cap |
| `relation_types` | all | — | Array of `UPPER_SNAKE_CASE` strings |

Returns:
```json
{
  "layers": [
    { "distance": 1, "entries": [{ "id": "<uuid>", "title": "..." }] }
  ],
  "total_impacted": 3
}
```

`total_impacted` is the count of unique entries in the returned set (may be truncated by `limit`).

---

### Sharing tools

#### `knowledge_share_entry`

Grant another user access to a knowledge entry. Owner only.

```json
{
  "entry_id": "<uuid>",
  "target_user_id": "other-user-sub",
  "role": "viewer"
}
```

`role` is `"viewer"` (read-only) or `"editor"` (read + write).
Returns `{}`.

---

#### `knowledge_revoke_access`

Remove a user's access to a knowledge entry. Owner only. Cannot revoke your own access.

```json
{
  "entry_id": "<uuid>",
  "target_user_id": "other-user-sub"
}
```

Returns `{}`.

---

#### `knowledge_list_access`

List all users with access to a knowledge entry. Requires read access. Results are
ordered by grant date (most recent first).

```json
{ "entry_id": "<uuid>", "limit": 100 }
```

`limit` defaults to 100; max 500. Values above the cap are rejected with `INVALID_PARAMS`.

Returns `{ "sharing": [{ "user_id", "role", "granted_at" }] }`.

---

#### `knowledge_list_namespaces`

List all namespaces the caller owns or has shared access to, with per-namespace entry counts.

Returns `{ "namespaces": [{ "namespace", "owned_count", "shared_count" }] }`.

---

### API key tools

These tools are only available when `API_KEYS_ENABLED=true`.

#### `knowledge_create_api_key`

Create a new API key for the authenticated user. The raw key is returned exactly once
and cannot be recovered. Requires an OIDC-authenticated session (or an existing API key
with sufficient scope).

```json
{
  "name": "ci-deploy",
  "namespaces": ["production", "staging"],
  "expires_in_days": 90
}
```

| Parameter | Required | Description |
|---|---|---|
| `name` | yes | Human-readable label (1–100 chars) |
| `namespaces` | no | Namespace allow-list; omit for unrestricted access |
| `expires_in_days` | no | Expiry window in days (1–365); omit for no expiry |

Returns:
```json
{
  "id": "<uuid>",
  "name": "ci-deploy",
  "key": "gmv_<hex>",
  "key_prefix": "gmv_abcdef01",
  "namespaces": ["production", "staging"],
  "expires_at": "2026-10-06T12:00:00.000Z"
}
```

> **⚠️ Save the `key` value immediately** — it is not stored and cannot be retrieved later.

---

#### `knowledge_list_api_keys`

List all API keys owned by the authenticated user. Never returns the raw key or key hash.

```json
{}
```

Returns `{ "api_keys": [{ "id", "name", "key_prefix", "namespaces", "expires_at", "last_used_at", "created_at" }] }`.

---

#### `knowledge_revoke_api_key`

Revoke an API key owned by the authenticated user. Revocation is immediate and
irreversible.

```json
{ "key_id": "<uuid>" }
```

Returns `{ "revoked": true }`. Returns `RESOURCE_NOT_FOUND` if the key does not exist.

---

## Permissions

| Operation | Minimum role |
|---|---|
| Read entry / list access | viewer |
| Update entry | editor |
| Delete entry | owner |
| Share entry | owner |
| Revoke access | owner |
| Create relation | viewer (on both entries, which may be in different namespaces) |
| List relations | viewer (on anchor entry) |
| Delete relation | owner (on source entry) |
| Create / list / revoke API keys | authenticated user (own keys only) |

Roles are stored as `HAS_ACCESS` relationships in Neo4j. The entry creator
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
| 200 | -32003 | `RESOURCE_NOT_FOUND` | Entry does not exist |
| 500 | -32004 | `INTERNAL_ERROR` | Unexpected server error |

---

## Client setup

### Claude Code (OAuth — recommended)

Claude Code supports MCP OAuth auto-discovery. Add to `~/.claude/mcp.json` (one entry per namespace):

```json
{
  "mcpServers": {
    "vault-homelab": {
      "type": "http",
      "url": "https://graph-mcp-vault.example.com/mcp/homelab"
    }
  }
}
```

On first use, Claude Code probes `/.well-known/oauth-protected-resource`, discovers the
authorization server, and triggers a browser-based PKCE login flow. No manual `auth` block
is needed.

Or via CLI:

```bash
claude mcp add vault-homelab \
  --type http \
  --url https://graph-mcp-vault.example.com/mcp/homelab
```

### Claude Code (API key)

If you have an API key (see [API key authentication](#api-key-authentication)), you can
use it as a static Bearer token instead of OAuth:

```json
{
  "mcpServers": {
    "vault-homelab": {
      "type": "http",
      "url": "https://graph-mcp-vault.example.com/mcp/homelab",
      "headers": {
        "Authorization": "Bearer gmv_<your-api-key>"
      }
    }
  }
}
```

This is ideal for CI, automation, or environments without a browser.

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
docker compose up -d          # start Neo4j + Keycloak + server
docker compose logs -f        # follow logs
docker compose down           # stop (data volume persists)
docker compose down -v        # stop and delete Neo4j data
```

## Changelog

See [`CHANGELOG.md`](CHANGELOG.md) for release history.

## Release

Use [`docs/RELEASE.md`](docs/RELEASE.md) for the exact release procedure, including
preflight checks, tagging, push steps, and GitHub release creation.

# graph-mcp-vault

A multi-tenant MCP knowledge memory bank backed by Neo4j.
Store notes, decisions, facts, and documentation as structured entries in named namespaces,
with per-user role-based access control.
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
- [Changelog](#changelog)
- [Release](#release)

---

## Quick start

```bash
# 1. Copy and fill in your environment
cp .env.example .env
$EDITOR .env          # set at least NEO4J_PASSWORD

# 2. Start Neo4j + Keycloak + the server
docker compose up -d

# 3. Verify the OAuth metadata endpoint
curl http://localhost:8000/.well-known/oauth-authorization-server

# 4. Fetch a dev token (preconfigured Keycloak realm/client/user)
TOKEN="$(curl -sS -X POST http://localhost:8081/realms/graph-mcp-vault/protocol/openid-connect/token \
  -H 'content-type: application/x-www-form-urlencoded' \
  -d 'grant_type=password' \
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
| `KEYCLOAK_ADMIN` | no | `admin` | Admin username for the bundled Keycloak dev container (Docker Compose only) |
| `KEYCLOAK_ADMIN_PASSWORD` | no | `admin` | Admin password for the bundled Keycloak dev container (Docker Compose only) |
| `HOST` | no | `0.0.0.0` | Bind address |
| `PORT` | no | `8000` | Listen port |
| `DEFAULT_NAMESPACE` | no | `default` | Namespace used when none is specified at session open |
| `LOG_LEVEL` | no | `info` | Log verbosity (`debug`, `info`, `warn`, `error`) |
| `ALLOWED_ORIGINS` | no | `""` | Comma-separated CORS origins; `*` for any; empty = no cross-origin requests |

When running with `docker compose`, if `OIDC_ISSUER` and `OIDC_AUDIENCE` are unset,
the stack defaults to the bundled Keycloak development realm:

- `OIDC_ISSUER=http://keycloak:8080/realms/graph-mcp-vault`
- `OIDC_AUDIENCE=graph-mcp-vault`

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

Every knowledge entry belongs to exactly one namespace. Namespaces provide multi-tenant
data isolation — a session in namespace `work` cannot see entries in `homelab`.

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

Any tool that accepts a `namespace` argument (e.g. `knowledge_list_entries`) can
explicitly target a different namespace. The session namespace is the default;
passing `namespace: "other"` overrides it for that single call.

---

## MCP tools

The server exposes thirteen knowledge tools. LLMs should **search before creating** to avoid
duplicate entries.

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
to both entries. Both entries must belong to the same namespace.

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

Find all directed paths between two entries via entry-relation edges. Only paths where
every node is readable by the caller are returned. Both entries must be in the same namespace.

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

## Permissions

| Operation | Minimum role |
|---|---|
| Read entry / list access | viewer |
| Update entry | editor |
| Delete entry | owner |
| Share entry | owner |
| Revoke access | owner |
| Create relation | viewer (on both entries) |
| List relations | viewer (on anchor entry) |
| Delete relation | owner (on source entry) |

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

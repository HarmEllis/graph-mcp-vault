# PLAN: graph-mcp-vault

---

## Goal

Build an MCP proxy server that exposes Neo4j as a multi-tenant MCP tool server.

- Identity management via a standards-compliant OIDC/OAuth2 provider (Pocket ID is one example)
- Data isolation per `(user_id, namespace)`
- Graph-native permissions in Neo4j
- Implementation language: TypeScript (project standard)

---

## Implementation Language

TypeScript is the fixed implementation language for this project:

- **Official MCP TypeScript SDK** (`@modelcontextprotocol/sdk`) is TypeScript-first and handles: protocol version negotiation, batch JSON-RPC, session headers, tool registry, and message routing — eliminating ~30% of manual protocol implementation work.
- **`jose`** (npm) — industry-standard JWT/JWKS for Node.js: RS256, kid-lookup, JWKS refresh, all built in.
- **`neo4j-driver`** — full TypeScript support, officially maintained by Neo4j.
- **`zod`** — schema validation.
- **`testcontainers`** — works in TypeScript/Node.js.
- HTTP server: **Hono**.

**Potential downsides of TypeScript:**

| Risk | Severity | Notes |
|------|----------|-------|
| MCP SDK abstracts protocol details | Low | Less raw control, but SDK is spec-compliant |
| testcontainers Node.js behavior can vary by host OS | Low | Covered by CI and deterministic container setup |
| Strict TypeScript can slow first implementation pass | Low | Prevents many runtime issues early |

**Conclusion**: no significant downsides. TypeScript with the official MCP SDK is the **chosen implementation path**.

---

## Finalized Architecture Decisions (language-agnostic)

### MCP Transport
- **Streamable HTTP 2025-03-26** — JSON-only responses, **no SSE**
- `POST /mcp` and `POST /mcp/{namespace}` — MCP endpoints
- `GET /mcp{,/{namespace}}` → 405 Method Not Allowed
- `/mcp/{namespace}` is a **deliberate proxy-level extension** to the spec (namespace via URL, for Open WebUI / Claude Code workspace isolation; see `docs/OPEN_WEBUI_SETUP_EXAMPLE.md`)

### Authentication
- Bearer JWT only — no API keys, no other schemes
- **RS256 only**, `kid`-based key lookup in JWKS cache
- Unknown `kid` → force JWKS refresh → retry once
- `nbf` validation with 30s leeway

### Sessions
- **Single-process, in-memory** (explicit deployment constraint — Redis out of scope)
- UUID4 session ID returned in `Mcp-Session-Id` HTTP response header AND `meta.sessionId` in JSON body
- 24h inactivity TTL; background task cleans up hourly
- Session validation on subsequent requests:
  - Header absent → **HTTP 400** + JSON-RPC -32600 INVALID_REQUEST
  - Header present but unknown/expired → **HTTP 404** + JSON-RPC -32000 SESSION_NOT_FOUND
  - URL namespace ≠ session namespace → **HTTP 404** + JSON-RPC -32001 SESSION_NAMESPACE_CONFLICT

### Namespace Resolution (on `initialize`, first match wins)
1. `params.meta.namespace` in request body
2. `{namespace}` URL path parameter
3. `DEFAULT_NAMESPACE` from config

### JSON-RPC Batch Support
MCP 2025-03-26 requires batch support:
- Request body may be a JSON array of requests/notifications
- Each request gets a result entry (any order)
- Notifications get no result entry
- Notifications-only batch → HTTP 202 empty body

---

## Error Taxonomy (canonical — used consistently everywhere)

| HTTP | JSON-RPC | Constant                    | When                                                  |
|------|----------|-----------------------------|-------------------------------------------------------|
| 400  | -32700   | PARSE_ERROR                 | Malformed JSON body                                   |
| 400  | -32600   | INVALID_REQUEST             | Bad JSON-RPC envelope; `Mcp-Session-Id` header absent |
| 200  | -32601   | METHOD_NOT_FOUND            | Unknown MCP method                                    |
| 200  | -32602   | INVALID_PARAMS              | Tool parameter validation failure                     |
| 404  | -32000   | SESSION_NOT_FOUND           | Header present but unknown or expired session ID      |
| 404  | -32001   | SESSION_NAMESPACE_CONFLICT  | URL namespace ≠ session namespace                     |
| 200  | -32002   | PERMISSION_DENIED           | Insufficient role for operation                       |
| 200  | -32003   | RESOURCE_NOT_FOUND          | Resource does not exist                               |
| 500  | -32004   | INTERNAL_ERROR              | Unexpected server/Neo4j error                         |

---

## Neo4j Schema (idempotent at startup)

```cypher
CREATE CONSTRAINT user_id_unique IF NOT EXISTS FOR (u:User) REQUIRE u.id IS UNIQUE;
CREATE CONSTRAINT resource_id_unique IF NOT EXISTS FOR (r:Resource) REQUIRE r.id IS UNIQUE;
CREATE INDEX resource_scope IF NOT EXISTS FOR (r:Resource) ON (r.user_id, r.namespace);
CREATE INDEX resource_type IF NOT EXISTS FOR (r:Resource) ON (r.type);
```

**Nodes:**
- `(:User { id, name? })`
- `(:Resource { id, user_id, namespace, type, title, content, created_at, updated_at })`

**Relationships:**
- `(:User)-[:OWNS]->(:Resource)`
- `(:User)-[:HAS_ACCESS { role: "viewer"|"editor", granted_at }]->(:Resource)`

### Role Hierarchy (enforced in proxy, not Neo4j)

```
owner  → read, write, share, delete
editor → read, write
viewer → read
```

### Effective Role Query (corrected Cypher — match Resource independently)

```cypher
MATCH (r:Resource {id: $resource_id})
OPTIONAL MATCH (u:User {id: $user_id})-[:OWNS]->(r)
OPTIONAL MATCH (u2:User {id: $user_id})-[acc:HAS_ACCESS]->(r)
RETURN
  CASE
    WHEN u IS NOT NULL THEN 'owner'
    WHEN acc IS NOT NULL THEN acc.role
    ELSE null
  END AS role
```

### list_resources Query (traversal from user — no global Resource scan)

```cypher
MATCH (u:User {id: $user_id})-[:OWNS|HAS_ACCESS]->(r:Resource)
WHERE ($namespace IS NULL OR r.namespace = $namespace)
  AND ($type IS NULL OR r.type = $type)
RETURN r,
  CASE WHEN (u)-[:OWNS]->(r) THEN 'owner' ELSE 'shared' END AS ownership
ORDER BY r.updated_at DESC
SKIP $skip LIMIT $limit
```

---

## Project Structure

```
graph-mcp-vault/
├── src/
│   ├── main.ts              # App entry point, lifespan, router registration
│   ├── config.ts            # Settings from environment variables
│   ├── auth.ts              # JWT validation + JWKS cache
│   ├── session.ts           # In-memory session store + background cleanup
│   ├── neo4j-client.ts      # Async Neo4j driver + all query helpers
│   ├── schema.ts            # Neo4j schema initialization
│   ├── errors.ts            # Error constants + helper factory
│   ├── routers/
│   │   ├── oauth-meta.ts    # GET /.well-known/oauth-authorization-server
│   │   └── mcp.ts           # POST /mcp + POST /mcp/{namespace}
│   └── tools/
│       ├── registry.ts      # MCP tool registry + tool descriptor list
│       ├── resources.ts     # create/get/list/update/delete tools
│       └── sharing.ts       # share/revoke/list_sharing tools
├── tests/
│   ├── setup.ts             # Fixtures: Neo4j testcontainer, RSA keys, test app, make_token
│   ├── auth.test.ts
│   ├── mcp-lifecycle.test.ts
│   ├── tools.test.ts
│   ├── sharing.test.ts
│   └── namespace.test.ts
├── docs/
│   ├── PLAN.md
│   ├── DECISIONS.md
│   └── OPEN_WEBUI_SETUP_EXAMPLE.md
├── docker-compose.yml
├── Dockerfile
├── .env.example
└── README.md
```

---

## Environment Variables (`.env.example`)

```env
OIDC_ISSUER=https://oidc-provider.example.com
OIDC_AUDIENCE=graph-mcp-vault
JWKS_CACHE_TTL=3600
METADATA_CACHE_TTL=3600
NEO4J_URI=bolt://neo4j:7687
NEO4J_USER=neo4j
NEO4J_PASSWORD=changeme
HOST=0.0.0.0
PORT=8000
DEFAULT_NAMESPACE=default
LOG_LEVEL=info
# Empty = deny all cross-origin. Set to * for local dev only.
ALLOWED_ORIGINS=
```

---

## Docker Compose

```yaml
services:
  neo4j:
    image: neo4j:5-community
    environment:
      NEO4J_AUTH: neo4j/${NEO4J_PASSWORD}
    volumes:
      - neo4j_data:/data
    ports:
      - "7474:7474"
      - "7687:7687"
    healthcheck:
      # Use wget — neo4j:5-community includes wget but not curl
      test: ["CMD", "sh", "-c", "wget -q --spider http://localhost:7474 || exit 1"]
      interval: 10s
      timeout: 5s
      retries: 12
      start_period: 30s

  graph-mcp-vault:
    build: .
    env_file: .env
    ports:
      - "8000:8000"
    depends_on:
      neo4j:
        condition: service_healthy
    restart: unless-stopped

volumes:
  neo4j_data:
```

---

## MCP Tool Specifications

### `create_resource`
- Params: `type`, `title`, `content`, `namespace?` (overrides session namespace)
- MERGE User node; CREATE Resource; CREATE OWNS relationship
- Returns: `{ id, created_at }`

### `get_resource`
- Params: `resource_id`
- Requires: `read`
- Returns: full resource + effective role

### `list_resources`
- Params: `namespace?`, `type?`, `limit=50`, `skip=0`
- Returns: all resources user can read (owned + shared) with ownership flag

### `update_resource`
- Params: `resource_id`, `title?`, `content?`
- Requires: `write`
- Updates `updated_at`

### `delete_resource`
- Params: `resource_id`
- Requires: `delete` (owner only)
- DETACH DELETE node and all relationships

### `share_resource`
- Params: `resource_id`, `target_user_id`, `role` (`"viewer"` | `"editor"`)
- Requires: `share`
- MERGE target User; `MERGE (u)-[r:HAS_ACCESS]->(res) SET r.role = $role, r.granted_at = now()`

### `revoke_access`
- Params: `resource_id`, `target_user_id`
- Requires: `share`
- If `target_user_id == requester` → PERMISSION_DENIED "Cannot revoke owner access"
- Otherwise: DELETE HAS_ACCESS relationship

### `list_sharing`
- Params: `resource_id`
- Requires: `read`
- Returns: `[{ user_id, role, granted_at }]`

---

## Test Scenarios (language-agnostic)

### auth.test
- Valid token → 200
- Expired token → 401
- Wrong audience → 401
- Wrong issuer → 401
- Missing Authorization header → 401
- Non-Bearer scheme → 401
- Unknown `kid` triggers JWKS force-refresh → succeeds with rotated key

### mcp-lifecycle.test
- Full happy path: initialize → `Mcp-Session-Id` header present → notifications/initialized (202) → tools/list → tools/call
- Protocol version mismatch → error with supported versions list
- Missing `Mcp-Session-Id` on tools/call → HTTP 400 INVALID_REQUEST
- Unknown/expired session ID → HTTP 404 SESSION_NOT_FOUND
- Origin blocked (ALLOWED_ORIGINS set) → HTTP 403
- Unknown method → METHOD_NOT_FOUND
- Malformed JSON → HTTP 400 PARSE_ERROR
- GET /mcp → 405
- Standalone notification (no `id`) → HTTP 202 empty
- Batch: 2 requests → JSON array with 2 results
- Batch: 1 request + 1 notification → array with 1 result
- Batch: notifications only → HTTP 202 empty

### tools.test
- create → get → list → update → delete lifecycle
- Viewer cannot write → PERMISSION_DENIED
- Viewer cannot delete → PERMISSION_DENIED
- Editor cannot delete → PERMISSION_DENIED
- Editor cannot share → PERMISSION_DENIED
- list pagination (limit + skip)
- list type filter
- delete removes all relationships

### sharing.test
- share → list_sharing → access as other user → revoke → access denied
- Duplicate share (same user, same resource) → idempotent; role updated
- Share to non-existent user → stub User created; HAS_ACCESS created
- Revoke own access → PERMISSION_DENIED "Cannot revoke owner access"

### namespace.test
- Namespace from `params.meta.namespace` → correct isolation
- Namespace from URL path → correct isolation
- Namespace from DEFAULT_NAMESPACE → correct isolation
- Resources from namespace A not visible in namespace B
- URL namespace ≠ session namespace → HTTP 404 SESSION_NAMESPACE_CONFLICT

---

## TDD Execution Order

1. Package config + error constants → unit tests → green
2. Auth (JWT + JWKS) → `auth.test` red → implement → green
3. Neo4j schema + client → basic connection test → implement
4. Session store → lifecycle tests (partial) → implement
5. OAuth metadata endpoint → test → implement
6. MCP transport: `initialize` + `tools/list` → lifecycle tests → implement
7. Resource tools → `tools.test` → implement
8. Sharing tools → `sharing.test` → implement
9. Namespace routing + conflict handling → `namespace.test` → implement
10. Batch JSON-RPC → extend lifecycle tests → implement
11. Docker Compose + Dockerfile
12. README
13. Full end-to-end MCP validation against the running Docker dev stack (Neo4j + Keycloak) and fix all discovered bugs before completion
14. Final quality gate: Codex performs a full code review of the complete codebase; Claude implements fixes for all accepted findings while preserving the core app goal and scope

---

## Current Implementation Priorities (Agreed)

1. **P0**: Fix the `list_resources` output bug so MCP clients/LLMs consistently receive usable tool output.
2. **P0**: Implement functional structured logging with real `LOG_LEVEL` enforcement.
3. **P1**: OIDC hardcoding cleanup.
   - Add optional `OIDC_DISCOVERY_URL` (fallback to `${OIDC_ISSUER}/.well-known/openid-configuration`).
   - Validate discovered `jwks_uri` with zod before use.
   - Remove hardcoded `scopes_supported` behavior; use pass-through by default or a configurable allowlist.
4. **P1**: Add full-text search without vectors (`search_resources` tool + Neo4j full-text index).
5. **P1**: Document an LLM smoke-test checklist for tool discovery, create/read/update flows, and namespace isolation checks. → See [`docs/SMOKE_TEST.md`](./SMOKE_TEST.md).
6. **P2**: Vector embeddings — future roadmap only, **not implemented**.
   - **Current state**: `search_resources` uses Neo4j full-text search (Lucene) over `title` and `content` fields. No embedding model, no vector index, no hybrid query is present anywhere in the codebase.
   - **Not implemented**: embedding generation, vector index (`CREATE VECTOR INDEX …`), cosine/dot-product similarity queries, or a semantic search tool.
   - **Future increment** (if needed): add an embedding-generation step on write, a Neo4j vector index, and a `semantic_search` tool that combines full-text and vector scores (hybrid search). This is deferred until there is a concrete need.
7. Final gate: run full end-to-end MCP validation against the active Docker dev stack (Neo4j + Keycloak) and fix all bugs found before completion.
8. Last step: Codex performs a full code review, then Claude fixes all accepted issues; ensure all fixes preserve the app's core purpose (MCP Neo4j proxy with namespace isolation and role-based access control).

---

## Out of Scope

- SSE / streaming responses
- Group-based access control (schema supports it, tools do not)
- Redis sessions / multi-worker deployment
- Refresh token handling (clients manage their own tokens)
- Neo4j Enterprise named databases
- Rate limiting per user
- Resource versioning / history
- Vector embeddings / semantic search (see roadmap item 6 above)

---

## Extension: API Key Authentication

> **Status**: Planned — extends but does not replace the OIDC/JWT path (D-006).
> The finalized architecture section ("Bearer JWT only — no API keys") is superseded by
> this extension. A corresponding DECISIONS.md entry (D-032) must be added before merging.

### Motivation

Bearer JWT authentication via OIDC works well for interactive clients (Claude Code, Open WebUI).
Some use cases require simpler, long-lived credentials:

- **Automation scripts and CI pipelines** that cannot perform interactive OIDC flows
- **Deployments without a public OIDC provider** (air-gapped, local-only installs)
- **Third-party integrations** that need a stable credential without token refresh complexity

API keys complement OIDC — they do not replace it. The JWT/OIDC path and all existing
middleware remain unchanged. `API_KEYS_ENABLED=false` (default) means no behaviour change for
current deployments.

---

### Authentication Flow

Both paths use the `Authorization: Bearer` header. The middleware inspects the token value to
determine which path to take:

```
if API_KEYS_ENABLED and token.startsWith("gmv_"):
  → validateApiKey()  (new path)
else:
  → validateBearerToken()  (existing path, unchanged)
```

The `gmv_` prefix is unambiguous: JWTs always start with `eyJ` (base64url-encoded `{"alg":…}`),
so there is no overlap.

If `API_KEYS_ENABLED=false` and the token starts with `gmv_`, the middleware returns HTTP 401
immediately without hitting any key-lookup logic.

---

### API Key Format

```
gmv_<64 lowercase hex characters>
```

- **`gmv_`** — literal prefix enabling fast identification and routing
- **64 hex chars** — 32 bytes from `crypto.randomBytes(32).toString("hex")` (256-bit entropy)
- **Total length**: 68 characters

**Key prefix for display**: first 12 characters of the raw key (e.g. `gmv_a1b2c3d4ef56`).
Stored in plaintext as `key_prefix` on the `ApiKey` node; never exposes the secret.

**Key hash**: `HMAC-SHA-256(raw_key, API_KEYS_HASH_SECRET)` encoded as lowercase hex, stored as `key_hash`. The server-side hash secret prevents offline verification of guessed keys if Neo4j is compromised, while preserving indexed lookup by digest. Changing `API_KEYS_HASH_SECRET` invalidates existing API keys.

---

### Neo4j Schema Changes (Migration v8)

**New node type**: `(:ApiKey)`

| Property | Type | Notes |
|---|---|---|
| `id` | `string` | UUID4 — internal identifier |
| `user_id` | `string` | matches `User.id` |
| `name` | `string` | human-readable label (max 100 chars) |
| `key_hash` | `string` | HMAC-SHA-256(raw_key, API_KEYS_HASH_SECRET), lowercase hex |
| `key_prefix` | `string` | first 12 chars of raw key (display only) |
| `namespaces` | `string[] \| null` | `null` = all namespaces allowed |
| `created_at` | `string` | ISO-8601 |
| `last_used_at` | `string \| null` | ISO-8601; updated asynchronously |
| `expires_at` | `string \| null` | ISO-8601; `null` = no expiry |
| `revoked` | `boolean` | set to `true` by `revoke_api_key` |

**New relationship**: `(:User)-[:OWNS_KEY]->(:ApiKey)`

**New schema statements** (migration v8):

```cypher
CREATE CONSTRAINT api_key_id_unique IF NOT EXISTS FOR (k:ApiKey) REQUIRE k.id IS UNIQUE;
CREATE INDEX api_key_hash IF NOT EXISTS FOR (k:ApiKey) ON (k.key_hash);
CREATE INDEX api_key_user IF NOT EXISTS FOR (k:ApiKey) ON (k.user_id);
```

**Schema version bumps from 7 → 8.**

---

### Environment Variables

```env
# Enable API key authentication. Must be opt-in (default: false).
API_KEYS_ENABLED=false
# Hard ceiling on active (non-revoked) API keys per user.
API_KEYS_MAX_PER_USER=20
# Required when API_KEYS_ENABLED=true; changing it invalidates existing API keys.
API_KEYS_HASH_SECRET=change-me-to-a-long-random-secret-at-least-32-chars
```

**Config additions**:
- `apiKeysEnabled: boolean` (parsed from `API_KEYS_ENABLED`)
- `apiKeysMaxPerUser: number` (parsed from `API_KEYS_MAX_PER_USER`)
- `apiKeysHashSecret: string | undefined` (parsed from `API_KEYS_HASH_SECRET`; required when API keys are enabled)

---

### Code Changes per Module

#### `src/auth.ts` — new exports

```typescript
// Returns raw key (shown once), HMAC digest (stored), and 12-char display prefix.
export function generateApiKey(hashSecret: string): { raw: string; hash: string; prefix: string }

// Validates a gmv_-prefixed token against the ApiKey table.
// Throws AuthError on unknown hash, revoked key, or expired key.
// Returns userId, apiKeyId, and the optional namespace allow-list.
export async function validateApiKey(
  token: string,
  neo4jClient: Neo4jClient,
  hashSecret: string,
): Promise<{ userId: string; apiKeyId: string; allowedNamespaces: string[] | null }>
```

#### `src/routers/mcp.ts` — auth middleware extension

Current: always calls `validateBearerToken`.

After this change the middleware conditionally branches:

```
const bearerToken = extractBearerToken(authHeader)  // existing helper

if (config.apiKeysEnabled && bearerToken.startsWith("gmv_")) {
  const { userId, apiKeyId, allowedNamespaces } = await validateApiKey(bearerToken, neo4jClient, config.apiKeysHashSecret)
  // name / email are null for API key auth (User node already holds profile from OIDC)
  requestIdentity = { userId, name: null, email: null, allowedNamespaces }
} else {
  const { userId, name, email } = await validateBearerToken(authHeader, config, jwksClient)
  requestIdentity = { userId, name, email, allowedNamespaces: null }
}
```

In `handleInitialize`, after namespace resolution, when `allowedNamespaces !== null`:

```
if (!allowedNamespaces.includes(resolvedNamespace)) {
  return HTTP 401 "API key not authorized for namespace: <resolvedNamespace>"
}
```

#### `src/neo4j-client.ts` — new query helpers

```typescript
createApiKey(params: {
  id: string; userId: string; name: string;
  keyHash: string; keyPrefix: string;
  namespaces: string[] | null; expiresAt: string | null;
}): Promise<ApiKeyRecord>

listApiKeys(userId: string): Promise<ApiKeyListItem[]>
  // Returns all keys owned by userId; never returns key_hash.
  // Items include: id, name, key_prefix, namespaces, created_at,
  //   last_used_at, expires_at, revoked.

getApiKeyByHash(keyHash: string): Promise<ApiKeyRecord | null>
  // Used by validateApiKey. Returns full record including revoked and expires_at.

revokeApiKey(userId: string, keyId: string): Promise<boolean>
  // Sets revoked=true on the ApiKey owned by userId. Returns false if not found.

countActiveApiKeys(userId: string): Promise<number>
  // Counts non-revoked keys for limit enforcement.

updateApiKeyLastUsed(keyId: string): Promise<void>
  // Fire-and-forget. Caller does not await.
```

#### `src/tools/api-keys.ts` — new file

Three tool handler functions:
- `handleCreateApiKey(ctx, args)` — generates key, enforces limit, stores hash, returns raw key once
- `handleListApiKeys(ctx, args)` — returns metadata list, never key_hash
- `handleRevokeApiKey(ctx, args)` — sets revoked=true, validates ownership

#### `src/tools/registry.ts` — register new tools

Add `knowledge_create_api_key`, `knowledge_list_api_keys`, `knowledge_revoke_api_key` to the
tool registry and to `tools/list` responses.

#### `src/schema.ts` — migration v8

Add `migrate_v8` function (constraint + two indexes) and bump `SCHEMA_VERSION` to `8`.

#### `src/config.ts` — two new env vars

Add `API_KEYS_ENABLED`, `API_KEYS_MAX_PER_USER`, and `API_KEYS_HASH_SECRET` to `envSchema` and `Config`.

---

### New MCP Tool Specifications

#### `knowledge_create_api_key`

- **Auth**: any (OIDC JWT or existing API key)
- **Params**:
  - `name: string` — label (1–100 chars, required)
  - `namespaces?: string[]` — namespace allow-list; omit for unrestricted access
  - `expires_in_days?: number` — expiry window (1–365); omit for no expiry
- **Behaviour**:
  1. Check `API_KEYS_ENABLED`; if false → PERMISSION_DENIED
  2. Count active keys for caller; if ≥ `API_KEYS_MAX_PER_USER` → INVALID_PARAMS
  3. Call `generateApiKey(config.apiKeysHashSecret)` → raw, hash, prefix
  4. Persist `ApiKey` node via `createApiKey()`
  5. Return `{ id, name, key, key_prefix, namespaces, expires_at }`
- **`key` is shown exactly once**; it is not stored and cannot be recovered

#### `knowledge_list_api_keys`

- **Auth**: any
- **Params**: none
- **Returns**: `[{ id, name, key_prefix, namespaces, created_at, last_used_at, expires_at, revoked }]`
- `key_hash` is never included in the response

#### `knowledge_revoke_api_key`

- **Auth**: any
- **Params**: `key_id: string`
- **Behaviour**:
  1. Call `revokeApiKey(userId, keyId)` — checks ownership in the same query
  2. If returns false → RESOURCE_NOT_FOUND (key does not exist or not owned by caller)
  3. If returns true → `{ revoked: true }`
- Revoking an already-revoked key is idempotent (returns `{ revoked: true }`)

---

### Bootstrap JSON Provisioning

> ⚠️ **Status: planned — not yet implemented.** The bootstrap feature is deferred to a future iteration. The current implementation requires OIDC to be configured; API keys complement OIDC rather than replacing it. See D-032 in DECISIONS.md.

> **Use case**: pre-seeding API keys into a fresh container without going through the MCP tool flow — useful for CI pipelines, air-gapped installs, or first-run admin setup.

**Flow**:

1. Admin drops one or more `.json` files into the bootstrap directory (default: `/run/secrets/api-keys/`, configurable via `API_KEYS_BOOTSTRAP_DIR`).
2. On startup, `src/bootstrap.ts` scans the directory, imports each key, then **deletes the file** so secrets are not left on disk.
3. If the bootstrap directory does not exist or is empty, startup proceeds normally — the scan is a no-op.

**JSON schema** (one file per key):

```json
{
  "name": "ci-pipeline",
  "user_id": "svc-ci@example.com",
  "namespaces": ["homelab", "work"],
  "expires_at": "2026-12-31T00:00:00Z"
}
```

| Field | Type | Required | Notes |
|---|---|---|---|
| `name` | `string` | Yes | Human-readable label (max 100 chars) |
| `user_id` | `string` | Yes | Maps to `User.id`; node is MERGE'd if absent |
| `namespaces` | `string[] \| null` | No | `null` or omitted = all namespaces; non-empty array = restricted (see below) |
| `expires_at` | `string \| null` | No | ISO-8601; `null` or omitted = no expiry |

**Environment variable**:

```env
# Directory scanned at startup for bootstrap API key JSON files.
# Files are deleted after import. Set to empty string to disable.
API_KEYS_BOOTSTRAP_DIR=/run/secrets/api-keys
```

**Security notes**:
- The directory must be mounted read-write so files can be deleted after import.
- Each file is processed atomically (import then delete); a crash between the two steps means the key already exists in Neo4j and the next startup attempt will fail the uniqueness constraint — this is safe (no duplicate key is created).
- The raw key is **only** returned in the startup log at `info` level, once, immediately after import. Operators must capture it from container logs before the container restarts.

---

### Namespace Optional Behavior (API Key Scope)

The `namespaces` field on `ApiKey` controls which namespaces a key can open a session in:

| Value | Meaning |
|---|---|
| `null` | Key is unrestricted — all namespaces are allowed |
| `[]` (empty array) | Treated identically to `null` — all namespaces are allowed |
| `["homelab", "work"]` | Key is restricted — only the listed namespaces are allowed |

The empty-array case is normalised to `null` on write so that the stored value is always either `null` or a non-empty array. This avoids an ambiguous state where the serialised form differs but the semantic meaning is the same.

Enforcement happens at `initialize` time in the auth middleware, not in Neo4j. A key that passes the hash/revoked/expiry checks but fails the namespace check returns HTTP 401 with `"API key not authorized for namespace: <resolvedNamespace>"`.

---

### Security Considerations

1. **Raw key shown only once** — `knowledge_create_api_key` includes `key` in the response.
   After the MCP session ends, the raw key is unrecoverable. Clients must store it securely.

2. **SHA-256 for key storage** — 256-bit CSPRNG entropy means brute-force and rainbow-table
   attacks are computationally infeasible. bcrypt/Argon2 provides no additional protection for
   randomly-generated keys and would impose 100–300 ms per request latency.

3. **Timing-safe lookup** — keys are looked up by hash equality using a Neo4j index (point
   lookup, not substring scan). No timing oracle exists for the hash value itself.

4. **Asynchronous `last_used_at`** — the timestamp update fires after the response is sent
   and is not awaited. A crash between response and write leaves `last_used_at` slightly stale;
   this is acceptable because `last_used_at` is an audit field, not a security control.

5. **Namespace restriction enforced at `initialize`** — a key with `namespaces: ["homelab"]`
   cannot open a session in any other namespace, regardless of the URL or meta parameter the
   client provides.

6. **Expiry checked on every validation** — an expired key returns HTTP 401 identically to a
   revoked key. No distinction is returned to the caller (avoids enumeration).

7. **`API_KEYS_ENABLED=false` by default** — existing deployments require no change. API key
   support is strictly opt-in.

8. **Per-user key limit** — `API_KEYS_MAX_PER_USER` (default: 20) prevents unbounded key
   proliferation. Revoked keys do not count toward the limit.

9. **HTTPS required** — API keys in Bearer tokens are as sensitive as passwords. Production
   deployments MUST terminate TLS before the server. This is the same requirement as JWT Bearer
   tokens and is not a new constraint.

10. **No built-in key rotation** — callers create a new key then revoke the old one. A rotation
    primitive is not provided; it would add complexity for no security gain in this deployment
    target.

11. **API key management tools are self-referential** — a caller authenticated via API key can
    create new keys and revoke existing ones. This is intentional: automation scripts need to
    rotate their own keys. If this is undesirable, set `API_KEYS_ENABLED=false` for those keys
    or restrict at the namespace level.

---

### Test Scenarios

#### `api-keys.test.ts` (new)

- `knowledge_create_api_key` returns raw key + metadata; raw key authenticates a subsequent request
- `knowledge_create_api_key` when `API_KEYS_ENABLED=false` → PERMISSION_DENIED
- `knowledge_create_api_key` when user already has `API_KEYS_MAX_PER_USER` active keys → INVALID_PARAMS
- `knowledge_create_api_key` with `namespaces` restriction — authenticated session limited to those namespaces
- `knowledge_create_api_key` with `expires_in_days=1` — key expires after 24 h (fast-forward time in test)
- `knowledge_list_api_keys` returns list without `key` or `key_hash` fields
- `knowledge_list_api_keys` shows revoked keys in the list (with `revoked: true`)
- `knowledge_revoke_api_key` → subsequent auth with that key returns 401
- `knowledge_revoke_api_key` for a key owned by a different user → RESOURCE_NOT_FOUND
- `knowledge_revoke_api_key` on already-revoked key → idempotent, returns `{ revoked: true }`

#### `auth.test.ts` extensions

- `gmv_` token with `API_KEYS_ENABLED=false` → HTTP 401
- Valid API key → HTTP 200 (session opens as correct userId)
- Unknown `key_hash` (not in DB) → HTTP 401
- Revoked API key → HTTP 401
- Expired API key → HTTP 401
- API key with `namespaces: ["homelab"]`, request to `/mcp/homelab` → 200
- API key with `namespaces: ["homelab"]`, request to `/mcp/work` → 401

---

### TDD Execution Order (API Key Extension)

Insert after existing step 3 (Neo4j schema + client):

| Step | Action | Test file |
|---|---|---|
| 3a | Config additions: `API_KEYS_ENABLED`, `API_KEYS_MAX_PER_USER`, `API_KEYS_HASH_SECRET` | `config.test.ts` (unit) |
| 3b | `generateApiKey()` — format, entropy, hash correctness | `auth.test.ts` (unit) |
| 3c | Schema migration v8 — ApiKey constraint + indexes | `schema.test.ts` (integration) |
| 3d | Neo4j query helpers — `createApiKey`, `getApiKeyByHash`, `revokeApiKey`, `listApiKeys`, `countActiveApiKeys`, `updateApiKeyLastUsed` | `neo4j-client.test.ts` (integration) |
| 3e | `validateApiKey()` — valid key, unknown hash, revoked, expired | `auth.test.ts` extensions (unit, mock queries) |
| 3f | Auth middleware routing — `gmv_` branch on/off, error cases | `auth.test.ts` extensions (integration) |
| 3g | Namespace restriction at `initialize` | `namespace.test.ts` extensions |
| 3h | MCP tools — `create_api_key`, `list_api_keys`, `revoke_api_key` | `api-keys.test.ts` (integration) |
| 3i | Register tools in registry; `tools/list` response | `mcp-lifecycle.test.ts` extension |

Each step follows the red-green-refactor cycle per AGENTS.md. No production code is written
before the test for that step is failing for the right reason.

---

## Co-dev Review with Codex (tmux workflow)

Run Codex in a dedicated tmux pane so it can perform a full code review in parallel with ongoing development in the main pane.

### Setup

```bash
# Create (or attach to) a named tmux session
tmux new-session -d -s codex-review -x 220 -y 50

# Open two panes: left = dev/Claude, right = Codex
tmux split-window -h -t codex-review

# In the right pane, start Codex with review instructions
tmux send-keys -t codex-review:0.1 \
  'codex "Review the full codebase in src/ for correctness, security, and TypeScript best-practice issues. Focus on: auth middleware routing, Neo4j query helpers, error taxonomy consistency, and the bootstrap provisioning flow. Report findings as a numbered list with file:line references."' \
  Enter
```

### Review prompt template

```
Review src/ for the following:
1. Security: timing-safe comparisons, secret exposure in logs, input validation at boundaries.
2. Correctness: auth middleware branch logic (gmv_ prefix, API_KEYS_ENABLED guard), session lifecycle, namespace enforcement.
3. TypeScript: missing type annotations, unsafe casts, unhandled promise rejections.
4. Test coverage gaps: list any code path in src/ not covered by a test in tests/.

Output a numbered finding list. For each finding include:
- File path and line number
- Severity: critical / high / medium / low
- Short description
- Suggested fix (one sentence)
```

### Workflow

1. Start the Codex review in the right tmux pane (command above).
2. Continue development or run tests in the left pane — the review runs concurrently.
3. When Codex finishes, copy the numbered finding list into a scratch file (`docs/codex-review-findings.md`).
4. Triage findings: accept, reject, or defer each one.
5. Claude implements fixes for all accepted findings, preserving the core app goal and scope.
6. Re-run the test suite after each fix batch: `pnpm vitest run`.

This is the workflow described in step 14 of the TDD Execution Order and step 8 of the Current Implementation Priorities.

---

## Verification

```bash
# Start stack
docker compose up -d

# Run test suite
pnpm vitest run

# Manual smoke test (requires a valid JWT from your OIDC provider)
curl -X POST http://localhost:8000/mcp \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '{
    "jsonrpc": "2.0",
    "id": 1,
    "method": "initialize",
    "params": {
      "protocolVersion": "2025-03-26",
      "capabilities": {},
      "clientInfo": { "name": "test", "version": "1.0" }
    }
  }'
# → HTTP 200, Mcp-Session-Id response header, protocolVersion "2025-03-26" in body

# OAuth discovery
curl http://localhost:8000/.well-known/oauth-authorization-server
# → JSON with issuer, authorization_endpoint, token_endpoint, jwks_uri, scopes_supported
```

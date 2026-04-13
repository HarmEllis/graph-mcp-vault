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

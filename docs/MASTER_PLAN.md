# MASTER_PLAN: graph-mcp-vault

## Goal

Build a FastAPI-based MCP proxy server that exposes Neo4j as a multi-tenant MCP
tool server. Identity is managed via a standards-compliant OIDC/OAuth2 provider
(Pocket ID is one example). Each user's data is
isolated by `(user_id, namespace)`. Namespaces are scoped per assistant/workspace
via the MCP `initialize` meta field, with URL-path as fallback. Users can share
resources with each other via a graph-native permission model inside Neo4j.

---

## Technology stack

- **Python 3.12** with **FastAPI** and **uvicorn**
- **neo4j** (official Python driver, async)
- **python-jose** or **PyJWT** for JWKS-based JWT validation
- **httpx** for async JWKS fetching
- **Docker** + **Docker Compose** for deployment
- Configuration via `.env` / environment variables

---

## Project structure

```
graph-mcp-vault/
├── app/
│   ├── main.py              # FastAPI app, lifespan, router registration
│   ├── config.py            # Settings via pydantic-settings
│   ├── auth.py              # JWT validation, JWKS cache
│   ├── session.py           # MCP session store (namespace per session)
│   ├── neo4j_client.py      # Async Neo4j driver, query helpers
│   ├── schema.py            # Neo4j schema init (constraints, indexes)
│   ├── routers/
│   │   ├── oauth_meta.py    # /.well-known/oauth-authorization-server
│   │   └── mcp.py           # /mcp and /mcp/{namespace} endpoints
│   └── tools/
│       ├── registry.py      # MCP tool registry
│       ├── resources.py     # create, get, list, delete tools
│       └── sharing.py       # share, revoke, list_shared tools
├── tests/
│   ├── test_auth.py
│   ├── test_tools.py
│   └── test_sharing.py
├── docker-compose.yml
├── Dockerfile
├── .env.example
└── README.md
```

---

## Configuration (`.env.example`)

```env
# OIDC
OIDC_ISSUER=https://oidc-provider.example.com
OIDC_AUDIENCE=graph-mcp-vault        # Client ID registered in your OIDC provider
JWKS_CACHE_TTL=3600                  # Seconds to cache JWKS keys

# Neo4j
NEO4J_URI=bolt://neo4j:7687
NEO4J_USER=neo4j
NEO4J_PASSWORD=changeme

# Server
HOST=0.0.0.0
PORT=8000
DEFAULT_NAMESPACE=default
LOG_LEVEL=info
```

---

## Phase 1 — OAuth metadata endpoint

### `routers/oauth_meta.py`

Expose `GET /.well-known/oauth-authorization-server`.

The response is a **passthrough** to the configured OIDC provider metadata. Fetch
`{OIDC_ISSUER}/.well-known/openid-configuration` at startup, cache it, and
re-expose the relevant OAuth fields. This way Claude Code and other MCP clients
can discover the full OAuth flow via the proxy endpoint without needing to know
the upstream provider URL directly.

Fields to include in response:
- `issuer`
- `authorization_endpoint`
- `token_endpoint`
- `jwks_uri`
- `response_types_supported`
- `grant_types_supported`
- `code_challenge_methods_supported`
- `scopes_supported` — extend provider scopes with `["neo4j:read", "neo4j:write"]`

Also expose `GET /.well-known/openid-configuration` returning the same payload
(some MCP clients try this endpoint).

---

## Phase 2 — JWT validation (`auth.py`)

Requirements:
- Fetch JWKS from `{OIDC_ISSUER}/.well-known/jwks.json` on first use
- Cache keys for `JWKS_CACHE_TTL` seconds (in-memory, refresh on miss)
- Validate: signature, `exp`, `aud` == `OIDC_AUDIENCE`, `iss` == `OIDC_ISSUER`
- Extract and return `sub` claim as `user_id`
- Raise HTTP 401 on any validation failure with a clear error message
- FastAPI dependency: `async def get_current_user(authorization: str = Header(...)) -> str`

Do NOT accept API keys or any other auth method — Bearer JWT only.

---

## Phase 3 — MCP session management (`session.py`)

The MCP protocol has an `initialize` request as the first message of every
session. The client may include a `meta` field with arbitrary data.

Session flow:
1. Client sends `initialize` → proxy extracts `meta.namespace` (if present)
2. Proxy creates a session: `{ session_id, user_id, namespace }`
3. Session is stored in-memory (dict, keyed by session_id)
4. All subsequent tool calls in that session use the stored `(user_id, namespace)`

Namespace resolution order (first match wins):
1. `initialize.meta.namespace`
2. URL path parameter `/mcp/{namespace}`
3. `DEFAULT_NAMESPACE` from config

Session ID: generate a UUID per `initialize` request. Return it in the
`initialize` response under `meta.sessionId` and require clients to send it as
a header (`Mcp-Session-Id`) on subsequent requests.

Sessions expire after 24 hours of inactivity (simple TTL via `asyncio` or
`datetime` check on access).

---

## Phase 4 — MCP transport (`routers/mcp.py`)

Implement **HTTP Streamable MCP** (the current MCP spec as of 2024-11-05).

Endpoints:
- `POST /mcp` — default namespace (uses URL fallback)
- `POST /mcp/{namespace}` — explicit URL namespace

Both endpoints:
1. Extract Bearer token → validate → get `user_id`
2. Parse JSON body as MCP message
3. Route to handler based on `method`:
   - `initialize` → create session, return capabilities
   - `tools/list` → return available tools
   - `tools/call` → validate session, dispatch to tool registry
4. Return MCP-spec JSON response

MCP capabilities to advertise in `initialize` response:
```json
{
  "capabilities": {
    "tools": {}
  }
}
```

---

## Phase 5 — Neo4j schema (`schema.py`)

Run at startup (idempotent). Create:

```cypher
// Constraints
CREATE CONSTRAINT user_id_unique IF NOT EXISTS
  FOR (u:User) REQUIRE u.id IS UNIQUE;

CREATE CONSTRAINT resource_id_unique IF NOT EXISTS
  FOR (r:Resource) REQUIRE r.id IS UNIQUE;

// Indexes for query performance
CREATE INDEX resource_scope IF NOT EXISTS
  FOR (r:Resource) ON (r.user_id, r.namespace);

CREATE INDEX resource_type IF NOT EXISTS
  FOR (r:Resource) ON (r.type);
```

Node schemas:

```
(:User { id, name? })

(:Resource {
  id,           // UUID
  user_id,      // owner's user_id (sub claim)
  namespace,    // e.g. "homelab", "personal", "work"
  type,         // e.g. "note", "memory", "document"
  title,
  content,
  created_at,
  updated_at
})
```

Relationships:

```
(:User)-[:OWNS]->(:Resource)
(:User)-[:HAS_ACCESS { role: "viewer"|"editor", granted_at }]->(:Resource)
(:Group)-[:HAS_ACCESS { role }]->(:Resource)   // optional, future
```

---

## Phase 6 — MCP tools

### Role hierarchy (enforce in proxy, not Neo4j)

```python
ROLE_PERMISSIONS = {
    "owner":  {"read", "write", "share", "delete"},
    "editor": {"read", "write"},
    "viewer": {"read"},
}
```

### Effective role query (reusable helper)

```cypher
MATCH (u:User {id: $user_id})
OPTIONAL MATCH (u)-[own:OWNS]->(r:Resource {id: $resource_id})
OPTIONAL MATCH (u)-[acc:HAS_ACCESS]->(r)
RETURN
  CASE
    WHEN own IS NOT NULL THEN 'owner'
    WHEN acc IS NOT NULL THEN acc.role
    ELSE null
  END AS role
```

### `tools/resources.py`

**`create_resource`**
- Parameters: `type`, `title`, `content`, `namespace?` (overrides session namespace)
- Creates `(:Resource)` node, creates `(:User)-[:OWNS]->(:Resource)` relation
- Auto-creates `(:User)` node if not exists (MERGE)
- Returns: resource id, created_at

**`get_resource`**
- Parameters: `resource_id`
- Checks effective role → requires `read`
- Returns: full resource data + effective role

**`list_resources`**
- Parameters: `namespace?`, `type?`
- Returns all resources the user can read in the given namespace:

```cypher
MATCH (u:User {id: $user_id})
MATCH (r:Resource)
WHERE (u)-[:OWNS]->(r) OR (u)-[:HAS_ACCESS]->(r)
  AND ($namespace IS NULL OR r.namespace = $namespace)
  AND ($type IS NULL OR r.type = $type)
RETURN r, 
  CASE WHEN (u)-[:OWNS]->(r) THEN 'owner' ELSE 'shared' END AS ownership
ORDER BY r.updated_at DESC
```

**`update_resource`**
- Parameters: `resource_id`, `title?`, `content?`
- Requires `write` permission
- Updates `updated_at`

**`delete_resource`**
- Parameters: `resource_id`
- Requires `delete` permission (owner only)
- Detach deletes the node and all relationships

### `tools/sharing.py`

**`share_resource`**
- Parameters: `resource_id`, `target_user_id`, `role` ("viewer"|"editor")
- Requires `share` permission (owner only)
- MERGE `(:User {id: target_user_id})` (creates stub if user doesn't exist yet)
- Creates or updates `[:HAS_ACCESS]` relationship

**`revoke_access`**
- Parameters: `resource_id`, `target_user_id`
- Requires `share` permission
- Deletes `[:HAS_ACCESS]` relationship

**`list_sharing`**
- Parameters: `resource_id`
- Requires `read` permission
- Returns: list of `{ user_id, role, granted_at }` for all HAS_ACCESS relationships

---

## Phase 7 — Docker Compose

```yaml
services:
  neo4j:
    image: neo4j:5-community
    environment:
      NEO4J_AUTH: neo4j/${NEO4J_PASSWORD}
    volumes:
      - neo4j_data:/data
    ports:
      - "7474:7474"   # Browser (optional, disable in prod)
      - "7687:7687"
    healthcheck:
      test: ["CMD", "neo4j", "status"]
      interval: 10s
      timeout: 5s
      retries: 10

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

Dockerfile: slim Python 3.12 image, non-root user, no dev dependencies in image.

---

## Phase 8 — Tests

Write pytest tests using `httpx.AsyncClient` with `app` as transport.

- `test_auth.py`: valid token, expired token, wrong audience, missing header
- `test_tools.py`: create → get → list → update → delete lifecycle
- `test_sharing.py`: share → list_sharing → access as other user → revoke → access denied
- `test_namespace.py`: same user, two namespaces, verify resources don't leak across

Use a real Neo4j test instance (via docker-compose or testcontainers-python).
Mock JWKS with a local RSA key pair generated at test startup.

---

## Phase 9 — README

Include:
1. Architecture diagram (ASCII)
2. OIDC client registration steps (Pocket ID example included)
3. Docker Compose quickstart
4. Open WebUI configuration (see below)
5. Claude Code configuration (see below)
6. Environment variable reference
7. MCP tool reference (all tools, parameters, required permissions)

---

## Coding standards

- All code in **English** (comments, docstrings, variable names)
- Type hints everywhere
- Async throughout (no sync Neo4j calls)
- No global mutable state except the JWKS cache and session store
- Return MCP error responses (not HTTP errors) for tool-level failures
- HTTP errors only for auth failures and malformed requests
- Log `user_id` and `namespace` in every tool call (not content)
- Keep tool implementations thin — business logic in `neo4j_client.py` helpers

---

## Out of scope (future work)

- Group-based access control (schema supports it, tools do not yet)
- Refresh token handling (clients manage their own tokens)
- Neo4j Enterprise named databases
- Rate limiting per user
- Resource versioning / history

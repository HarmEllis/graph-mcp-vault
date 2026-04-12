# Architectural Decisions

This file records all significant architectural and technical decisions made during the project.
Each entry includes the decision, the rationale, and any rejected alternatives.

New decisions are added here before merging the code that implements them.

---

## D-001 — Implementation language: TypeScript

**Date**: 2025-04-12
**Status**: Accepted

**Decision**: Implement in TypeScript (Node.js 24), not Python.

**Rationale**:
- The project owner works primarily in TypeScript; consistency across their stack.
- The official MCP SDK (`@modelcontextprotocol/sdk`) is TypeScript-first and handles protocol-level complexity (version negotiation, batch JSON-RPC, session headers, tool registry) — eliminating significant manual implementation work.
- `jose` (npm) is the standard for JWT/JWKS in Node.js — RS256, kid-lookup, JWKS refresh, all first-class.
- `neo4j-driver` has full official TypeScript support.
- Node.js 24 includes built-in `fetch`, removing the need for an HTTP client dependency.

**Rejected alternative**: Python (FastAPI + uvicorn + python-jose). Viable, but Python MCP SDK is less mature and inconsistent with the owner's preferred stack.

---

## D-002 — MCP transport: Streamable HTTP 2025-03-26, no SSE

**Date**: 2025-04-12
**Status**: Accepted

**Decision**: Implement the MCP **Streamable HTTP transport** as specified in `2025-03-26`. All responses are `application/json`. No SSE endpoints anywhere.

**Rationale**:
- The project owner explicitly requested: "I only want Streamable HTTP, no SSE."
- Streamable HTTP 2025-03-26 supports JSON-only responses — SSE is optional in the spec.
- Eliminates the complexity of SSE streaming, event ID tracking, and reconnection handling.
- Claude Code and Open WebUI both work with JSON-response Streamable HTTP.

**Rejected alternative**: HTTP+SSE (MCP 2024-11-05 spec) — separate GET /sse endpoint. Rejected because the owner does not want SSE.

---

## D-003 — Namespace routing via URL path

**Date**: 2025-04-12
**Status**: Accepted (deliberate non-standard extension)

**Decision**: Expose `POST /mcp/{namespace}` as an independent namespace-scoped MCP endpoint in addition to `POST /mcp`. Each URL path is treated as an independent MCP server endpoint.

**Rationale**:
- Open WebUI and Claude Code are configured with one URL per workspace/assistant (e.g., `/mcp/homelab`, `/mcp/personal`, `/mcp/work`). See `OPEN_WEBUI_SETUP_EXAMPLE.md`.
- Namespace in URL makes routing explicit and requires no client-side configuration beyond the URL.
- Simpler operational model than requiring all clients to send `meta.namespace` in the initialize body.

**Trade-off**: This deviates from the MCP Streamable HTTP spec, which defines a single canonical endpoint path. Documented explicitly to set interoperability expectations.

**Rejected alternative**: Single `/mcp` endpoint with namespace via `initialize.meta.namespace` only. Rejected because it requires all MCP clients to support custom `meta` fields, which not all clients do.

---

## D-004 — Namespace resolution order

**Date**: 2025-04-12
**Status**: Accepted

**Decision**: On `initialize`, resolve namespace using first match:
1. `params.meta.namespace` in the request body
2. `{namespace}` URL path parameter
3. `DEFAULT_NAMESPACE` environment variable

**Rationale**: Provides maximum flexibility — clients that support MCP meta can override the URL-level namespace; clients that do not will use the URL; the fallback ensures a namespace is always assigned.

---

## D-005 — Session storage: in-memory, single process

**Date**: 2025-04-12
**Status**: Accepted

**Decision**: Store MCP sessions in an in-memory Map, keyed by UUID session ID. Deploy with a single-process server (no clustering, no load balancing).

**Rationale**:
- Simplest correct implementation for a personal/homelab deployment.
- Avoids a Redis dependency for a use case with very few concurrent users.
- Single-process constraint is explicitly documented so it is not violated inadvertently.

**Constraint**: This must be deployed as a single uvicorn/Node process. A multi-instance deployment would require shared session storage (e.g., Redis).

**Future work**: Redis-backed sessions for multi-worker deployment.

---

## D-006 — Authentication: Bearer JWT only, RS256

**Date**: 2025-04-12
**Status**: Accepted

**Decision**: Accept only `Authorization: Bearer <jwt>` tokens. Validate using RS256 only. No API keys, no other schemes.

**Rationale**:
- The deployment target uses RS256 JWTs. Restricting to RS256 prevents algorithm confusion attacks (e.g., HS256 with the public key as secret).
- Bearer-only simplifies the auth surface; API keys would require a separate credential store.

**JWKS key rotation**: On unknown `kid`, force a JWKS refresh and retry once. This handles key rotation without downtime.

---

## D-007 — JWT validation parameters

**Date**: 2025-04-12
**Status**: Accepted

**Decision**:
- Validate: RS256 signature, `exp`, `nbf` (30s leeway), `aud == OIDC_AUDIENCE`, `iss == OIDC_ISSUER`
- Reject: any other algorithm
- Return: `sub` claim as `userId`
- On failure: HTTP 401 + `WWW-Authenticate: Bearer`

**Rationale**: Standard JWT validation per RFC 7519. The 30s `nbf` leeway accounts for minor clock skew between the OIDC provider and the proxy.

---

## D-008 — MCP session ID delivery

**Date**: 2025-04-12
**Status**: Accepted

**Decision**: On `initialize`, return the session ID in:
1. `Mcp-Session-Id` HTTP response header (spec-required for Streamable HTTP 2025-03-26)
2. `result.meta.sessionId` in the JSON body (convenience, for clients that don't inspect headers)

**Rationale**: The MCP 2025-03-26 spec requires the session ID in the `Mcp-Session-Id` header. The JSON body field is additive and does not conflict.

---

## D-009 — Session validation error behavior

**Date**: 2025-04-12
**Status**: Accepted

**Decision**:

| Condition | HTTP status | JSON-RPC error |
|-----------|-------------|----------------|
| `Mcp-Session-Id` header absent on session-required method | 400 | -32600 INVALID_REQUEST |
| Header present but session unknown or expired | 404 | -32000 SESSION_NOT_FOUND |
| URL namespace ≠ session namespace | 404 | -32001 SESSION_NAMESPACE_CONFLICT |

**Rationale**: Distinguishes "you forgot the header" (client bug, 400) from "your session expired" (expected lifecycle event, 404). The 404 for session errors is per MCP Streamable HTTP spec, which uses HTTP 404 for terminated sessions.

---

## D-010 — JSON-RPC batch support

**Date**: 2025-04-12
**Status**: Accepted

**Decision**: The server must accept a JSON array as the request body (JSON-RPC batch). Rules:
- Each request in the array is processed independently.
- Results are collected into a response array (in any order).
- Notifications (items without `id`) are processed but excluded from the response array.
- If all items are notifications → HTTP 202 Accepted, empty body.
- A malformed batch item produces an error object in the response array.

**Rationale**: Required by MCP 2025-03-26 base protocol compliance.

---

## D-011 — Error taxonomy

**Date**: 2025-04-12
**Status**: Accepted

**Decision**: Canonical error codes used consistently across all layers (transport, tools, tests):

| HTTP | JSON-RPC | Constant | When |
|------|----------|----------|------|
| 400 | -32700 | PARSE_ERROR | Malformed JSON body |
| 400 | -32600 | INVALID_REQUEST | Bad JSON-RPC envelope; missing session header |
| 200 | -32601 | METHOD_NOT_FOUND | Unknown MCP method |
| 200 | -32602 | INVALID_PARAMS | Tool parameter validation failure |
| 404 | -32000 | SESSION_NOT_FOUND | Header present but unknown or expired session |
| 404 | -32001 | SESSION_NAMESPACE_CONFLICT | URL namespace ≠ session namespace |
| 200 | -32002 | PERMISSION_DENIED | Insufficient role |
| 200 | -32003 | RESOURCE_NOT_FOUND | Resource does not exist |
| 500 | -32004 | INTERNAL_ERROR | Unexpected server/Neo4j error |

**Rationale**: A single source of truth prevents inconsistencies between implementation and tests. Discovered during Codex review (iteration 2) that having both -32600 and -32001 for namespace conflict in different sections caused confusion.

---

## D-012 — Role hierarchy

**Date**: 2025-04-12
**Status**: Accepted

**Decision**:
```
owner  → read, write, share, delete
editor → read, write
viewer → read
```

Enforced in application code, not in Neo4j constraints.

**Rationale**: Application-layer enforcement is simpler to change and test than database-layer enforcement. Neo4j stores the role value; the proxy decides what each role permits.

---

## D-013 — Neo4j schema: graph-native permissions

**Date**: 2025-04-12
**Status**: Accepted

**Decision**: Model permissions as Neo4j relationships:
- `(:User)-[:OWNS]->(:Resource)` — creator/owner
- `(:User)-[:HAS_ACCESS { role, granted_at }]->(:Resource)` — shared access

Use `MERGE` on `HAS_ACCESS` to prevent duplicate edges per `(user, resource)` pair.

**Rationale**: Graph-native model is idiomatic for Neo4j and allows efficient traversal queries. A separate ACL table would require joins; the relationship approach uses the graph directly.

---

## D-014 — Cypher: effective role query pattern

**Date**: 2025-04-12
**Status**: Accepted

**Decision**: Match `Resource` independently first, then optional-match ownership and access:

```cypher
MATCH (r:Resource {id: $resourceId})
OPTIONAL MATCH (u:User {id: $userId})-[:OWNS]->(r)
OPTIONAL MATCH (u2:User {id: $userId})-[acc:HAS_ACCESS]->(r)
RETURN
  CASE
    WHEN u IS NOT NULL THEN 'owner'
    WHEN acc IS NOT NULL THEN acc.role
    ELSE null
  END AS role
```

**Rationale**: The original MASTER_PLAN reused `r` from an OPTIONAL MATCH, which can leave `r` null and prevent the HAS_ACCESS match from resolving. Identified as a CRITICAL bug during Codex review.

---

## D-015 — Cypher: list_resources traversal pattern

**Date**: 2025-04-12
**Status**: Accepted

**Decision**: Start from the user node and traverse outward — never do a global `MATCH (r:Resource)` scan:

```cypher
MATCH (u:User {id: $userId})-[:OWNS|HAS_ACCESS]->(r:Resource)
WHERE ($namespace IS NULL OR r.namespace = $namespace)
  AND ($type IS NULL OR r.type = $type)
RETURN r,
  CASE WHEN (u)-[:OWNS]->(r) THEN 'owner' ELSE 'shared' END AS ownership
ORDER BY r.updated_at DESC
SKIP $skip LIMIT $limit
```

**Rationale**: A global `MATCH (r:Resource)` scans all resources regardless of user, which grows unboundedly. Traversal from the user is O(user's resources), not O(all resources). Also adds pagination via `SKIP`/`LIMIT`. Identified as MAJOR performance issue during Codex review.

---

## D-016 — Docker healthcheck for Neo4j

**Date**: 2025-04-12
**Status**: Accepted

**Decision**: Use `wget -q --spider http://localhost:7474 || exit 1` as the Neo4j container healthcheck.

**Rationale**: `neo4j status` is unreliable inside the official container image (does not accurately reflect readiness). `curl` is not available in `neo4j:5-community`. `wget` is available and the HTTP port 7474 is only reachable once Neo4j is fully started.

---

## D-017 — Origin validation (DNS rebinding mitigation)

**Date**: 2025-04-12
**Status**: Accepted

**Decision**: If `ALLOWED_ORIGINS` environment variable is non-empty and not `*`, validate the `Origin` request header against the allowlist. Return HTTP 403 on mismatch. Default is empty (deny all cross-origin).

**Rationale**: Required by MCP transport security guidelines to mitigate DNS rebinding attacks. The `*` value is available for local development only. Production deployments must set explicit origin values.

---

## D-018 — OAuth metadata: additive scope extension

**Date**: 2025-04-12
**Status**: Accepted

**Decision**: The `/.well-known/oauth-authorization-server` endpoint extends the upstream provider `scopes_supported` array with `["neo4j:read", "neo4j:write"]`. These are additive proxy-level metadata — the proxy does not issue tokens and does not enforce these scopes in JWT validation.

**Rationale**: Allows MCP clients that inspect the discovery document to see the proxy-specific scopes. The configured OIDC provider remains the authoritative token issuer; the proxy only reads the `sub` claim.

---

## D-019 — `protocolVersion` in initialize response

**Date**: 2025-04-12
**Status**: Accepted

**Decision**: Return `"protocolVersion": "2025-03-26"` in the `initialize` result. If the client sends an unsupported version, return a JSON-RPC error with `data: { "supported": ["2025-03-26"] }`.

**Rationale**: The original MASTER_PLAN incorrectly mixed the 2024-11-05 protocol version with the 2025 Streamable HTTP transport. These are separate spec revisions. Identified as CRITICAL during Codex review (iteration 2).

---

## D-020 — HTTP framework: Hono

**Date**: 2025-04-12
**Status**: Accepted

**Decision**: Use **Hono** as the HTTP framework.

**Rationale**:
- Lightweight, no overhead, TypeScript-first API.
- Works natively with Node.js (`@hono/node-server`).
- First-class support for returning custom HTTP headers (needed for `Mcp-Session-Id`) and status codes.
- No magic; transparent request/response model — suitable for TDD.

**Rejected alternatives**:
- Fastify: viable, but more configuration overhead for this use case.
- Express: too legacy, poor TypeScript ergonomics.

---

## D-021 — Test runner: Vitest

**Date**: 2025-04-12
**Status**: Accepted

**Decision**: Use **Vitest** for all tests.

**Rationale**:
- Native TypeScript and ESM support without transpilation config.
- Compatible with Node.js 24.
- `vi.fn()` for mocks, `beforeAll`/`afterAll` for fixtures.
- Fast watch mode for TDD cycle.

**Rejected alternative**: Jest — requires more configuration for TypeScript/ESM; slower.

---

## D-022 — JWKS caching strategy

**Date**: 2025-04-12
**Status**: Accepted

**Decision**: Cache JWKS keys in memory keyed by `kid`. TTL controlled by `JWKS_CACHE_TTL` (default 3600s). On unknown `kid`: invalidate cache, force a fresh JWKS fetch, retry key lookup once. If still not found: return HTTP 401.

**Rationale**: Handles key rotation gracefully without requiring a server restart. The single retry prevents cascading requests on rotation events.

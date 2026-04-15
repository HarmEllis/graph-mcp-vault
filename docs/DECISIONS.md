# Architectural Decisions

This file records all significant architectural and technical decisions made during the project.
Each entry includes the decision, the rationale, and any rejected alternatives.

New decisions are added here before merging the code that implements them.

---

## D-001 — Implementation language: TypeScript

**Date**: 2025-04-12
**Status**: Accepted

**Decision**: Implement in TypeScript (Node.js 24).

**Rationale**:
- The project owner works primarily in TypeScript; consistency across their stack.
- The official MCP SDK (`@modelcontextprotocol/sdk`) is TypeScript-first and handles protocol-level complexity (version negotiation, batch JSON-RPC, session headers, tool registry) — eliminating significant manual implementation work.
- `jose` (npm) is the standard for JWT/JWKS in Node.js — RS256, kid-lookup, JWKS refresh, all first-class.
- `neo4j-driver` has full official TypeScript support.
- Node.js 24 includes built-in `fetch`, removing the need for an HTTP client dependency.

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
- Open WebUI and Claude Code are configured with one URL per workspace/assistant (e.g., `/mcp/homelab`, `/mcp/personal`, `/mcp/work`). See `docs/OPEN_WEBUI_SETUP_EXAMPLE.md`.
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

**Constraint**: This must be deployed as a single Node.js process. A multi-instance deployment would require shared session storage (e.g., Redis).

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

**Rationale**: A single source of truth prevents inconsistencies between implementation and tests. Earlier drafts used both -32600 and -32001 for namespace conflict in different sections, which caused confusion.

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

**Rationale**: The original draft plan reused `r` from an OPTIONAL MATCH, which can leave `r` null and prevent the HAS_ACCESS match from resolving. This is a critical correctness issue.

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

**Rationale**: A global `MATCH (r:Resource)` scans all resources regardless of user, which grows unboundedly. Traversal from the user is O(user's resources), not O(all resources). Also adds pagination via `SKIP`/`LIMIT`. This prevents a major performance issue.

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

**Rationale**: The original draft plan incorrectly mixed the 2024-11-05 protocol version with the 2025 Streamable HTTP transport. These are separate spec revisions and must not be combined.

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

---

## D-023 — Bundled local OAuth provider for Docker Compose development

**Date**: 2026-04-13
**Status**: Accepted

**Decision**: Include a preconfigured Keycloak service in `docker-compose.yml` for local development. Import a fixed realm (`graph-mcp-vault`) with a dev client and user at startup.

**Rationale**:
- Removes the need to manually provision an external OIDC provider for local testing.
- Keeps production architecture unchanged (proxy remains provider-agnostic and bearer-token-only).
- Enables quick smoke tests for JWT validation and MCP calls directly after `docker compose up -d`.

---

## D-024 — Fuzzy search edit-distance policy

**Date**: 2026-04-14
**Status**: Accepted

**Decision**: Per-token fuzzy suffix policy for the `fuzzy` search mode:

| Token length (original) | Lucene suffix | Edit distance |
|-------------------------|---------------|---------------|
| < 3 chars               | none          | exact match   |
| 3–5 chars               | `~1`          | 1 edit        |
| > 5 chars               | `~2`          | 2 edits       |

Boolean operators (`AND`, `OR`, `NOT`) are stripped before applying the policy. If all tokens are stripped, the query short-circuits and returns an empty result set without hitting the Lucene index.

**Rationale**:
- Very short tokens (1–2 chars) produce noisy results with fuzzy matching; exact match is better.
- Medium tokens (3–5 chars) tolerate one typo (e.g., transposed characters).
- Longer tokens tolerate two edits, covering common spelling mistakes.
- Removing `AND`/`OR`/`NOT` prevents accidental Lucene boolean operators from narrowing/widening results unexpectedly.
- Short-circuiting on an empty token set avoids a vacuous Lucene query that would return all indexed documents.

**Rejected alternative**: uniform `~2` on all tokens — produces too many false positives for short tokens.

---

## D-025 — Version-gated schema migration policy

**Date**: 2026-04-14
**Status**: Accepted

**Decision**: Track schema state with a single `SchemaInfo` node in Neo4j (`s.version`). On startup, `initSchema` reads the version, runs any pending migration steps sequentially, then bumps the version. Subsequent restarts skip already-applied migrations.

Current schema version: **3**.

Migration v2 changes:
1. Rename the `type` property to `entry_type` on all `Resource` nodes.
2. Drop the `resource_type` index (was on `r.type`) and recreate as `resource_entry_type` on `r.entry_type`.
3. Drop the `resource_text` fulltext index and rebuild with `title`, `content`, `summary`, `topic`, `tags`.

Migration v3 changes:
1. Create relationship index `entry_relation_type` on `ENTRY_RELATION.relation_type`.

**Rationale**:
- Keeps startup idempotent: calling `initSchema` multiple times is safe.
- A single version counter is simpler than per-migration flags and covers the sequential nature of schema evolution.
- `IF NOT EXISTS` / `IF EXISTS` guards on index statements prevent errors on partial runs or concurrent restarts.
- Running migration on an empty database is a no-op (no `Resource` nodes to rename, no old indexes to drop) — safe for fresh installs.

**Rejected alternative**: always drop and recreate all indexes on startup — too slow for production databases with large datasets.

---

## D-026 — Entry relations: single relationship type with typed property

**Date**: 2026-04-14
**Status**: Accepted

**Decision**: Model inter-entry relations as native Neo4j relationships with a single label `ENTRY_RELATION` and a `relation_type` string property (e.g. `"DEPENDS_ON"`, `"RUNS_ON"`, `"CONNECTS_TO"`). An optional `label` property stores a human-readable description. A `created_at` timestamp is set on `ON CREATE`.

Relation type values are validated against `^[A-Z][A-Z0-9_]{1,63}$` (UPPER_SNAKE_CASE) at both the client and tool layer.

**Permission rules**:
- Create: caller must have at least read (viewer) access to both entries.
- List: caller must have at least read access to the anchor entry; counterpart entries the caller cannot read are silently filtered from results.
- Delete: caller must be the owner of the source (`from`) entry.
- Additional constraints: both entries must be in the same namespace; self-relations (`from_id == to_id`) are rejected.

**Rationale**:
- A single relationship label with a typed property is more flexible than one Neo4j relationship type per semantic (which would require schema changes for each new relation type). The `relation_type` property index (`entry_relation_type`, added in schema v3) keeps typed lookups efficient.
- MERGE semantics on create make the operation idempotent — calling it twice with the same `(from, to, relation_type)` tuple updates the label without duplicating the edge.
- Filtering counterpart visibility in `listEntryRelations` ensures users never discover entries they have no access to through the relation graph.

**Rejected alternative**: one Neo4j relationship type per semantic (e.g. `DEPENDS_ON`, `RUNS_ON` as labels). Rejected because it requires a schema migration for every new relation type a user wants to introduce.

---

## D-027 — tool_call log: replace `namespace` with `sessionNamespace` + `requestNamespace`

**Date**: 2026-04-14
**Status**: Accepted

**Decision**: The `tool_call` and `tool_call_internal_error` log events no longer emit a single `namespace` field. Instead they emit two explicit fields:

- `sessionNamespace` — the namespace bound to the MCP session at initialization time (from `ctx.namespace`).
- `requestNamespace` — the value of `arguments.namespace` in the tool call, if and only if it is a string; `null` in all other cases (field absent, value is `null`, or value is a non-string type).

**Rationale**: The legacy `namespace` field was ambiguous — it was silently set to the session namespace regardless of what the caller passed in `arguments.namespace`. This made it impossible to distinguish, from the log alone, whether a tool invocation included an explicit namespace override or inherited the session default. The two-field approach makes both dimensions observable without changing any runtime behavior (namespace resolution inside tool handlers is unchanged).

**Rejected alternative**: Keep `namespace` and add a separate `requestNamespace` field alongside it. Rejected because having two fields with overlapping semantics increases confusion; the clean split is easier to query in structured log systems.

---

## D-028 — Persist user name/email on (:User) at session initialization

**Date**: 2026-04-15
**Status**: Accepted

**Decision**: On every `initialize` request, after the JWT is validated and the session is created, upsert the `name` and `email` profile fields onto the `(:User {id})` node in Neo4j. The `name` and `email` claims are extracted from the JWT payload as strings; if a claim is absent or is not a string, `null` is passed. The Cypher pattern uses `coalesce` to preserve existing values when a claim is absent:

```cypher
MERGE (u:User {id: $userId})
SET u.name  = coalesce($name,  u.name),
    u.email = coalesce($email, u.email)
```

The `Neo4jClient` instance is passed into `createMcpRouter` as a required parameter so that `handleInitialize` can perform the upsert without exposing the client on `ToolContext`.

**Rationale**:
- OIDC providers include `name` and `email` as standard claims; persisting them makes users identifiable in the graph without a separate directory lookup.
- `coalesce` ensures that a session from a token lacking a claim does not blank out a value stored during an earlier session (e.g., a token without `name` does not overwrite a `name` that was captured previously).
- Upsert on `initialize` (once per session) keeps the write path simple and predictable; it does not add overhead to per-request tool calls.

**Rejected alternative**: Add `name`/`email` to `ToolContext` and upsert inside tool handlers. Rejected because the plan explicitly prohibits adding speculative fields to `ToolContext`, and the upsert is a session-lifecycle concern, not a tool concern.

---

## D-029 — Security scan: lockfile-native Trivy scan replaces `pnpm audit`

**Date**: 2026-04-15
**Status**: Accepted

**Decision**: Replace `pnpm audit --audit-level=high` in CI with a lockfile-native Trivy filesystem scan (`scan-type: fs`, `scan-ref: pnpm-lock.yaml`, `severity: CRITICAL,HIGH,MEDIUM`). The Trivy action is pinned to the same SHA already used in `docker-publish.yml` (`aquasecurity/trivy-action@76071ef0d7ec797419534a183b498b4d6366cf37`). Vulnerability threshold is raised from HIGH+ to MODERATE+.

**Rationale**:
- On 2026-04-15 the `pnpm audit` step began failing with HTTP 410 responses from the npm audit endpoints (`/-/npm/v1/security/audits/quick` and fallback `/-/npm/v1/security/audits`), indicating those endpoints have been retired. The step blocked every CI run with an error unrelated to actual dependency vulnerabilities.
- Trivy reads the `pnpm-lock.yaml` lockfile directly without making registry requests. It parses the resolved package graph and matches it against its bundled advisory database, making the scan reliable in air-gapped or endpoint-restricted environments.
- `pnpm audit` resolves the audit data through npm's shadow tree (the "bulk audits" endpoint), which does not accurately reflect the pnpm lockfile's resolved tree. Trivy's lockfile-native mode scans the actual resolved packages, avoiding false negatives from shadow-tree divergence.
- The threshold is expanded to MODERATE+ because Trivy's CVSS-based severity classification is more granular than npm's model; a HIGH-only threshold would undercount the same risk surface that `pnpm audit --audit-level=high` was intended to cover.

**Rejected alternative**: `pnpm audit --audit-level=high` against the npm registry endpoint — retired; not usable from CI.

**Follow-up (2026-04-15)**: The Trivy action was subsequently updated from v0.31.0 (`76071ef0d7ec797419534a183b498b4d6366cf37`) to v0.35.0 (`57a97c7e7821a5776cebc9bb87c984fa69cba8f1`) after CI bootstrap failures caused by default Trivy binary version drift. An explicit `version: v0.69.3` input is now required on all Trivy action steps; omitting it allows the action to download whatever Trivy binary version happens to be current at run time, which can break bootstrap silently when the upstream release changes.

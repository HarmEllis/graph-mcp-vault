# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.0.9] - 2026-04-17

Expands graph exploration with richer relationship tools, improves search behavior and guidance for LLM callers, and updates local development auth token defaults for longer sessions.

### Added

- New `knowledge_explain_relationship` tool to explain direct and indirect relationships between two entries, including formatted path strings and path ordering by shortest-first.
- `knowledge_find_paths` and relationship explanations now include richer path details, including node `entry_type`, relation endpoints (`from_id`/`to_id`), and deterministic path formatting.
- `knowledge_get_entry` now returns `relation_summary` with accessible outbound, inbound, and total relation counts.

### Changed

- `knowledge_search_entries` now searches all accessible namespaces by default. Use `namespace` to restrict scope; `all_namespaces` remains as a backwards-compatible no-op.
- `knowledge_find_paths` now accepts `direction` with default `both` (undirected traversal), and returns a hint when directional filters produce no results.
- Release runbook now includes an explicit `src/server-instructions.md` accuracy review before every release.

### Fixed

- Development Keycloak realm access tokens now default to a 24-hour lifespan to avoid frequent expiry during local sessions.
- Path deduplication in graph traversal now removes duplicate path variants while keeping shortest-first ordering deterministic.

**Full Changelog**: https://github.com/HarmEllis/graph-mcp-vault/compare/v0.0.8...v0.0.9

## [0.0.8] - 2026-04-16

Fixes a container startup crash caused by the compiled `dist/` directory missing the `server-instructions.md` file.

### Fixed

- `server-instructions.md` is now copied to `dist/src/` during the Docker build. The TypeScript compiler only processes `.ts` files, so the Markdown file was absent at runtime, causing an `ENOENT` crash on startup.

**Full Changelog**: https://github.com/harmEllis/graph-mcp-vault/compare/v0.0.7...v0.0.8

## [0.0.7] - 2026-04-16

Expands what the MCP server exposes to LLMs and users: richer sharing info, relation timestamps, editable entry type and namespace, and a structured instructions block that gives LLMs a full picture of the data model on session start.

### Added

- `knowledge_list_access` now returns `name` and `email` alongside `user_id` for each access grant, so users can identify who has access by name rather than opaque ID.
- `knowledge_list_relations` now includes `created_at` on each relation, showing when the link was established.
- `knowledge_update_entry` accepts `entry_type` (rename the category of an entry) and `namespace` (move an entry to a different namespace). Changing `namespace` is rejected with a clear error when the entry has existing relations, preserving the cross-namespace invariant.
- MCP `instructions` field in the `initialize` response: on every session start, LLMs receive a schema overview, namespace semantics (including per-tool override), a mandatory Markdown requirement for `content`, and a search workflow that instructs the model to retry with `all_namespaces: true` before creating a duplicate entry.
- `src/server-instructions.md`: the instructions text is stored in a plain Markdown file in the repo, making it easy to update without touching application code.
- Server name and version are now logged at startup.

**Full Changelog**: https://github.com/harmEllis/graph-mcp-vault/compare/v0.0.6...v0.0.7

## [0.0.6] - 2026-04-15

Fixes token validation failures caused by the `iss` claim mismatch between the upstream IdP's tokens and the previously overridden `issuer` in the OAuth authorization server metadata.

### Fixed

- Stop overriding `issuer` in the `/.well-known/oauth-authorization-server` response. MCP clients (e.g. Open WebUI) validate the `iss` claim of received tokens against the `issuer` advertised in the AS metadata. Because tokens are issued by the upstream IdP with its own issuer, overriding the field to `PUBLIC_URL` caused a claim mismatch and an `invalid_claim: Invalid claim 'iss'` error. The upstream issuer is now passed through unchanged. `registration_endpoint` and (when `INJECT_MISSING_SCOPE=true`) `authorization_endpoint` are still overridden.

**Full Changelog**: [v0.0.5...v0.0.6][0.0.6]

## [0.0.5] - 2026-04-15

Adds an authorization endpoint proxy that injects a missing `scope` parameter before forwarding to the upstream IdP. Opt-in via `INJECT_MISSING_SCOPE=true`.

### Added

- `GET /authorize` scope-injection proxy: when `INJECT_MISSING_SCOPE=true`, the server registers this endpoint and overrides `authorization_endpoint` in the OAuth authorization server metadata to point to it. Incoming requests without a `scope` parameter have one injected (from `SCOPES_ALLOWLIST`, or `"openid"` as fallback) before a 302 redirect to the real upstream authorization endpoint. This works around MCP clients that omit `scope` from the authorization request, causing providers like Pocket ID to reject with `Scope is required`.
- `INJECT_MISSING_SCOPE` environment variable (default: `false`).
- `PUBLIC_URL` documented in `.env.example` with description.

**Full Changelog**: [v0.0.4...v0.0.5][0.0.5]

## [0.0.4] - 2026-04-15

Include `scope` in the `WWW-Authenticate: Bearer` header on 401 responses so that MCP clients read the required scopes directly from the challenge and include them in the authorization request.

### Fixed

- Added `scope` to the `WWW-Authenticate: Bearer` challenge (RFC 6750) on unauthenticated requests. Clients such as Open WebUI did not forward the `scope` from the DCR response to the authorization URL, causing Pocket ID to reject the request with `Scope is required`. The challenge-level scope is the authoritative signal for what scopes the client must request.

**Full Changelog**: [v0.0.3...v0.0.4][0.0.4]

## [0.0.3] - 2026-04-15

This release focuses on OAuth scope compatibility improvements and a stricter release process.

### Changed

- Added an explicit release runbook reference to `AGENTS.md`.
- Reworked `docs/RELEASE.md` into a version-agnostic release flow with approval and CI gates before tag publication.
- Standardized changelog compare-link formatting for release notes extraction.

### Fixed

- OAuth metadata now consistently exposes usable scopes for MCP OAuth clients, preventing Pocket ID login failures with `Scope is required`.
- Added regression coverage for scope fallback behavior in OAuth metadata endpoints.

**Full Changelog**: [v0.0.2...v0.0.3][0.0.3]

## [0.0.2] - 2026-04-15

### Added

- OAuth metadata support for protected resources (`/.well-known/oauth-protected-resource`) and authorization server metadata (`/.well-known/oauth-authorization-server`) with upstream discovery caching.
- Dynamic Client Registration proxy endpoint (`POST /clients`) for MCP clients that require DCR in OAuth flows.
- Optional scope allowlist filtering for proxied OAuth metadata via `SCOPES_ALLOWLIST`.
- OpenCode MCP client configuration in `opencode.json`.

### Changed

- Updated local MCP client configuration in `.mcp.json` to use `oauth.callbackPort`.
- Bumped server and package version metadata to `0.0.2`.

### Fixed

- Docker publish workflow now correctly resolves annotated tag commit SHAs and image metadata.
- CI Trivy SARIF upload permissions now include `security-events: write`.

**Full Changelog**: [v0.0.1...v0.0.2][0.0.2]

## [0.0.1] - 2026-04-15

### Added

- Streamable HTTP MCP server (`/mcp` and `/mcp/{namespace}`) with JSON-RPC tool dispatch.
- OIDC-based bearer authentication with discovery and JWKS caching.
- Neo4j-backed knowledge tools for CRUD, search, relations, and traversal.
- Role-based sharing model (`owner`, `editor`, `viewer`) with namespace-aware access checks.
- Local development stack via Docker Compose (Neo4j + Keycloak + server).
- CI pipeline with linting, type checks, integration tests, Docker build checks, and pinned actions.

### Changed

- Aligned project and server runtime version metadata for the first public release (`0.0.1`).

### Security

- Added Trivy scans in CI and Docker publish workflows.

**Full Changelog**: [Initial release][0.0.1]

[0.0.3]: https://github.com/HarmEllis/graph-mcp-vault/compare/v0.0.2...v0.0.3
[0.0.2]: https://github.com/HarmEllis/graph-mcp-vault/compare/v0.0.1...v0.0.2
[0.0.1]: https://github.com/HarmEllis/graph-mcp-vault/releases/tag/v0.0.1

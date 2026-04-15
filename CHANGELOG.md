# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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

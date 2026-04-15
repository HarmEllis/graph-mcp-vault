# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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

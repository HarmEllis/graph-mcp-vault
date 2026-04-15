# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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


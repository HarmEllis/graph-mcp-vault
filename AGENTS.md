# Agent & Contributor Guide

This file defines the conventions, stack, and workflow for all contributors and AI agents working on this project.

---

## Language

**All project files are written in English** — without exception.

This applies to:
- Source code (variable names, function names, class names)
- Comments and docstrings
- Commit messages
- Documentation (README, PLAN, AGENTS, DECISIONS)
- Test descriptions and assertion messages
- Error messages and log output
- Configuration keys

The project owner may communicate in Dutch; all project artifacts must be in English regardless.

---

## Stack

| Concern | Choice |
|---------|--------|
| Runtime | Node.js 24 |
| Language | TypeScript 5.x (strict mode) |
| HTTP framework | Hono |
| MCP protocol | `@modelcontextprotocol/sdk` |
| Neo4j driver | `neo4j-driver` (official, async) |
| JWT / JWKS | `jose` |
| Schema validation | `zod` |
| HTTP client | Node.js built-in `fetch` (Node 24) |
| Configuration | `dotenv` + zod-validated env schema |
| Testing | Vitest + `testcontainers` |
| Package manager | pnpm |
| Linting / formatting | Biome |
| Build | `tsc` |
| Containerization | Docker + Docker Compose |

### TypeScript configuration

- `strict: true`
- `noUncheckedIndexedAccess: true`
- `exactOptionalPropertyTypes: true`
- Target: `ES2023`
- Module: `NodeNext`

---

## Collaboration Assignment

No fixed agent handoff order is prescribed in this repository. Task ownership and review order are decided at the start of each work session.

---

## Release Process

For any release activity, always follow [`docs/RELEASE.md`](./docs/RELEASE.md) as the source of truth.

This includes:
- Required preflight checks
- Release metadata updates
- Tag creation and push sequence
- GitHub draft release creation

---

## Development Workflow: TDD

**All features are developed using Test-Driven Development (TDD).**

Follow the red-green-refactor cycle strictly:

1. **Red** — Write a failing test that describes the desired behavior. The test must fail for the right reason (not a compile error or missing import).
2. **Green** — Write the minimum code needed to make the test pass. Do not over-engineer.
3. **Refactor** — Clean up the implementation without breaking the tests.

### Rules

- No production code without a failing test first.
- Tests live in `tests/` mirroring the `src/` structure.
- Test files are named `*.test.ts`.
- Use Vitest's `describe` / `it` / `expect` API.
- Mark async tests with `async`.
- Use `beforeAll` / `afterAll` for expensive fixtures (Neo4j testcontainer, RSA key pair).
- Test names must be descriptive: `it("returns 401 when the JWT is expired")` not `it("auth test 1")`.

### Test scope

- **Unit tests**: pure functions with no I/O (config parsing, error factory, role permission logic).
- **Integration tests**: anything touching Neo4j or HTTP — use the real Neo4j testcontainer and a test Hono app.
- **No mocking of Neo4j**. Use testcontainers for a real instance. Mock only external OIDC/JWKS endpoints using a locally generated RSA key pair.

### TDD execution order

Follow the order defined in [PLAN.md](./docs/PLAN.md#tdd-execution-order). Start with config and error constants, then work outward layer by layer.

---

## Project Structure

```
src/
  main.ts               Entry point, app setup, lifespan hooks
  config.ts             Zod-validated settings from environment
  auth.ts               JWT validation + JWKS cache
  session.ts            In-memory session store + background cleanup
  neo4j-client.ts       Async Neo4j driver + all query helpers
  schema.ts             Neo4j schema initialization (idempotent)
  errors.ts             JSON-RPC error constants + factory function
  routers/
    oauth-meta.ts       GET /.well-known/oauth-authorization-server
    mcp.ts              POST /mcp + POST /mcp/{namespace}
  tools/
    registry.ts         MCP tool registry + descriptor list
    resources.ts        create/get/list/update/delete resource tools
    sharing.ts          share/revoke/list_sharing tools

tests/
  setup.ts              Shared fixtures (testcontainer, RSA keys, test app, make_token)
  auth.test.ts
  mcp-lifecycle.test.ts
  tools.test.ts
  sharing.test.ts
  namespace.test.ts

docs/
  PLAN.md
  DECISIONS.md
  OPEN_WEBUI_SETUP_EXAMPLE.md
```

---

## Code Standards

- **Type hints everywhere** — no `any`, no `unknown` without a type guard.
- **Async throughout** — no synchronous Neo4j calls, no blocking I/O.
- **No global mutable state** except the JWKS key cache and the in-memory session dictionary.
- **Thin tool handlers** — all Neo4j query logic lives in `neo4j-client.ts`, not in tool files.
- **HTTP errors** for transport-level failures: 400, 401, 403, 404, 405, 500.
- **JSON-RPC errors** for MCP-level and tool-level failures. See [DECISIONS.md](./docs/DECISIONS.md) for the full error taxonomy.
- **Logging**: log `userId` and `namespace` on every tool call. Never log resource content.
- **No speculative abstractions** — build what the tests require, nothing more.
- **No backwards-compatibility shims** — delete unused code cleanly.

---

## Architectural Decisions

All architectural and technical decisions are recorded in [DECISIONS.md](./docs/DECISIONS.md).

When a new decision is made during development — a library choice, a design trade-off, a spec clarification — add an entry to `docs/DECISIONS.md` before merging.

# Graph MCP Vault

A self-hosted MCP knowledge graph for AI agents and the people and teams who operate them.

Agents and connected systems store notes, facts, decisions, and documentation in Neo4j; organise them in namespaces; connect them with typed relations; and retrieve the resulting context through Codex, Claude Code, or any Streamable HTTP MCP client.

## Why use it?

- **Useful memory, not a document dump.** Search entries before adding new knowledge, then link related entries so an agent can follow the context.
- **Your infrastructure, your identity provider.** Run the service and Neo4j yourself; authentication uses your existing OIDC provider.
- **Collaboration with access control.** Entries may be shared with other users as viewers or editors; creators remain owners.
- **Consistent structure without rigidity.** An operator can write a namespace template or ask an LLM to propose one; once saved, it guides future agent work without enforcing a hard schema.
- **Works with interactive and headless clients.** Use OAuth/OIDC for people, or optionally issue restricted API keys for automation.

## At a glance

| You want to... | Use this |
| --- | --- |
| Keep personal and work knowledge separate | A namespace such as personal or work |
| Let an agent remember a decision | knowledge_create_entry |
| Avoid duplicate knowledge | knowledge_search_entries before creating |
| Explain dependencies or blast radius | Relations, knowledge_expand_context, and knowledge_impact_analysis |
| Give a colleague access | knowledge_share_entry |
| Connect a CI job or headless agent | An optional, scoped API key |

## Quick start

The development stack includes Neo4j, this server, and a disposable Keycloak realm. It is for local evaluation only; use your own OIDC provider in production.

### Prerequisites

- Docker and Docker Compose
- curl; jq is needed only for the optional authenticated request below

### Start the local stack

~~~bash
cp .env.example .env
# Set a non-default value in .env:
# NEO4J_PASSWORD=replace-this-for-local-development

docker compose -f docker-compose.dev.yml up -d
~~~

The first start initializes and migrates the Neo4j schema. This is idempotent, so restarting the stack is safe.

Confirm that the server and its OAuth discovery endpoint are reachable:

~~~bash
curl --fail http://localhost:8000/.well-known/oauth-protected-resource
curl --fail http://localhost:8000/.well-known/oauth-authorization-server
~~~

For everyday use, connect Codex or Claude Code instead of calling JSON-RPC directly. A development token and raw MCP request are available in [the smoke-test checklist](docs/SMOKE_TEST.md).

## Deploy in production

The production Compose file starts the server and Neo4j. Neo4j is on an internal Docker network and is not exposed to the host.

~~~bash
cp .env.example .env
# Edit .env with the values below.
docker compose up -d
~~~

At minimum, set these values in .env:

~~~dotenv
OIDC_ISSUER=https://id.example.com
OIDC_AUDIENCE=graph-mcp-vault
PUBLIC_URL=https://vault.example.com
NEO4J_PASSWORD=use-a-unique-long-password
ALLOWED_ORIGINS=https://your-web-client.example.com
~~~

PUBLIC_URL must be the public HTTPS address that clients use. It is published in OAuth metadata, so a wrong value prevents client login.

### Configure the OIDC provider

Create an OIDC client in your identity provider with these properties:

- Its client ID/audience is the value of OIDC_AUDIENCE.
- It issues RS256-signed access tokens with an aud claim that includes that value.
- It supports Authorization Code with PKCE for a public client.
- It allows the scopes you expose in SCOPES_ALLOWLIST, normally openid, profile, and email.
- It permits the loopback callback URI requested by your MCP clients. Codex and Claude Code complete the browser flow locally. Prefer exact loopback rules or a provider-supported loopback pattern instead of broad redirect rules.

The server reads discovery from {OIDC_ISSUER}/.well-known/openid-configuration. Set OIDC_DISCOVERY_URL only when the server needs a different internal address to reach the provider, for example an OIDC provider in the same Docker network.

Put the server behind a TLS-terminating reverse proxy. Also rate-limit /mcp, enforce a request-body limit consistent with MAX_REQUEST_BODY_BYTES, and keep the Neo4j port private.

## Connect Codex or Claude Code

Replace https://vault.example.com with your PUBLIC_URL. Use a namespace in the URL when it is a useful session default:

~~~text
https://vault.example.com/mcp/work
~~~

The namespace in the path is only the session default. You may instead use https://vault.example.com/mcp, which uses the server's DEFAULT_NAMESPACE. Tools that accept a namespace argument can target another namespace explicitly. A normal OAuth session can access other namespaces it is permitted to read; add ?lock_namespace=true only when a client must be confined to one namespace.

### OAuth/OIDC: recommended for people

OAuth is the recommended option for interactive use. The client discovers this server's protected-resource and authorization-server metadata automatically, opens a browser, and stores refreshable credentials locally. No token needs to be copied into a config file.

#### Codex

Add this persistent entry to ~/.codex/config.toml:

~~~toml
[mcp_servers.graph-vault-work]
url = "https://vault.example.com/mcp/work"
~~~

Then run this one-time login yourself in a terminal:

~~~bash
codex mcp login graph-vault-work --scopes openid,profile,email
~~~

If your provider uses different scopes, replace that list with the values in SCOPES_ALLOWLIST. The URL namespace is only the default for this server entry; it does not prevent access to other permitted namespaces.

#### Claude Code

Add this to the project's .mcp.json, or add the same server through Claude Code's MCP settings:

~~~json
{
  "mcpServers": {
    "graph-vault-work": {
      "type": "http",
      "url": "https://vault.example.com/mcp/work"
    }
  }
}
~~~

Open Claude Code and use /mcp to authenticate the server in your browser. Project configuration does not contain an OAuth token, so it is suitable for version control. Claude Code asks for approval before using a project server.

### API key: for automation and headless clients

API keys are disabled by default. They are an alternative authentication method for clients without a browser flow, CI, or service accounts. They are not a replacement for the server's own OIDC configuration: first connect through OAuth, then have an agent or MCP client create the key.

Enable them on the server:

~~~dotenv
API_KEYS_ENABLED=true
# Generate and store this securely. It must be at least 32 characters.
API_KEYS_HASH_SECRET=replace-with-a-long-random-secret
~~~

Restart the server after changing the environment. Then, in an OIDC-authenticated MCP session, call knowledge_create_api_key. Set a meaningful name, a namespace allow-list when possible, and an expiry. The result contains a gmv_ key exactly once. Save it in your secret manager immediately; the server stores only a scrypt digest, so it cannot show the raw key again.

#### Codex with an API key

For a personal Codex setup, add this persistent entry to ~/.codex/config.toml:

~~~toml
[mcp_servers.graph-vault-work-key]
url = "https://vault.example.com/mcp/work?lock_namespace=true"

[mcp_servers.graph-vault-work-key.http_headers]
Authorization = "Bearer gmv_your_key_here"
~~~

This is the most reliable configuration for a local, single-user Codex installation. Treat ~/.codex/config.toml as a secret-bearing file: do not commit, copy, or share it.

For CI or a managed secret store, use the safer alternative instead:

~~~toml
[mcp_servers.graph-vault-work-key]
url = "https://vault.example.com/mcp/work?lock_namespace=true"
bearer_token_env_var = "GRAPH_MCP_VAULT_API_KEY"
~~~

#### Claude Code with an API key

For a personal Claude Code setup, add this to your private MCP configuration:

~~~json
{
  "mcpServers": {
    "graph-vault-work-key": {
      "type": "http",
      "url": "https://vault.example.com/mcp/work?lock_namespace=true",
      "headers": {
        "Authorization": "Bearer gmv_your_key_here"
      }
    }
  }
}
~~~

Do not commit a file containing a literal API key. For a shared project .mcp.json, use an environment-variable reference instead:

~~~json
{
  "mcpServers": {
    "graph-vault-work-key": {
      "type": "http",
      "url": "https://vault.example.com/mcp/work?lock_namespace=true",
      "headers": {
        "Authorization": "Bearer ${GRAPH_MCP_VAULT_API_KEY}"
      }
    }
  }
}
~~~

The secret then belongs in the user's environment, CI runner, or secret manager, not in the repository.

### Choose the right authentication method

| Situation | Recommended method |
| --- | --- |
| A developer using Codex or Claude Code interactively | OAuth/OIDC |
| A CI job or unattended automation | Restricted, expiring API key |
| A client that must only see one namespace | API key restricted to that namespace plus ?lock_namespace=true |
| An employee leaves or loses a device | Revoke OAuth access at the identity provider; revoke any API key separately |

## How agents use the knowledge graph

### A simple workflow for agents

1. List the available namespaces and read their templates, if present.
2. Choose a namespace, such as work, homelab, or personal.
3. Search before creating an entry, so similar knowledge is reused instead of duplicated.
4. Save a concise, descriptive title and Markdown content. Add a summary, tags, topic, and source when they help retrieval.
5. Create relations where they describe a real connection, such as DEPENDS_ON, RUNS_ON, or RELATES_TO.
6. Ask for context, paths, or impact when planning a change.

Example prompts for an MCP client:

- “Search the work namespace for our Kubernetes upgrade plan. Do not create a duplicate.”
- “Save this architecture decision in work with the source link, tags, and a one-sentence summary.”
- “What depends on the PostgreSQL cluster entry? Show the impact through three hops.”
- “Link the deployment runbook to the service it documents with RUNS_ON.”

### Namespace templates: consistent knowledge without rigid schemas

Each user can set a Markdown structure_template for a namespace. An operator can write the template directly or ask an LLM to propose it. It defines the preferred entry types, required metadata, naming conventions, tags, relation types, or a Markdown outline for that workspace. Once saved, it guides future agent work. This makes a work namespace feel like a lightweight, evolving knowledge standard while a personal namespace can stay simple.

The template is advisory, not a validation schema. It helps an agent create consistent entries without rejecting an exceptional entry that does not fit the usual format.

For example, a template for a work namespace could be:

~~~markdown
## Entry conventions

- Use entry_type: decision, runbook, service, incident, or reference.
- Start decision titles with "Decision: "; include context, decision, and consequences.
- Tag services with their team and environment, for example platform and production.
- Link runbooks to services with RUNS_ON and decisions with DEPENDS_ON.
- Include a source URL and last_verified_at for external documentation.
~~~

Set it with knowledge_update_namespace_config. You can supply the Markdown directly, or ask an MCP agent to turn your conventions into a proposal first. For example:

> Set the structure template for the work namespace to require decision records to include context, decision, and consequences; use the entry types decision, runbook, service, incident, and reference; and use RUNS_ON and DEPENDS_ON relations as described above.

knowledge_list_namespaces includes your configured template, and knowledge_get_namespace_config returns it for one namespace. Ask an agent to read those settings before creating entries in an unfamiliar namespace. The same namespace settings also hold the default versioning policy and optional automatic sharing rules.

### Entries, relations, and versions

An entry has a required entry_type, title, and content; content should be Markdown. The most useful optional fields are namespace, topic, tags, summary, source, and last_verified_at.

| Group | Tools |
| --- | --- |
| Entries and search | Create, get, list, update, delete, and search entries |
| Graph navigation | Create/list/delete relations; expand context; find paths; explain relationships; impact analysis |
| Collaboration | Share entries, revoke access, list access, and search users |
| Namespaces | List namespaces and get/update namespace conventions and version defaults |
| Version history | List, retrieve, and restore entry versions |
| API keys (optional) | Create, list, and revoke your own keys |

Use tools/list in any MCP client for the exact current schemas and descriptions.

### Namespaces and permissions

Every entry belongs to exactly one namespace. A session's namespace is chosen, in this order, by params.meta.namespace in initialize, the /mcp/{namespace} URL path, then DEFAULT_NAMESPACE.

Within the caller's namespace scope, entry permissions still apply:

| Role | Can do |
| --- | --- |
| Viewer | Read entries and inspect access |
| Editor | Viewer permissions plus update entries |
| Owner | Editor permissions plus delete and share entries |

Creating a relation requires read access to both entries. Deleting one requires owner access to its source entry. A relation may span namespaces, but scoped sessions cannot discover or traverse entries outside their scope.

## Authentication and access control

### OAuth/OIDC tokens

For ordinary access, send an access token as a Bearer token:

~~~text
Authorization: Bearer <access-token>
~~~

The server validates RS256 signatures, issuer, audience, expiration, not-before time, and maximum token lifetime. It uses the token's sub claim as the stable user ID. Signing keys are loaded from the provider's discovery document and cached; an unknown key ID triggers one controlled refresh.

The server publishes these public endpoints for MCP OAuth discovery:

~~~text
GET /.well-known/oauth-protected-resource
GET /.well-known/oauth-authorization-server
POST /clients
~~~

### API key limits and lifecycle

- Keys start with gmv_ and are shown only at creation time.
- Each key may be unrestricted or limited to an allow-list of namespaces.
- A key can expire in 1–365 days; expiry is optional.
- The default maximum is 20 active keys per user, configured by API_KEYS_MAX_PER_USER.
- Owners can use knowledge_list_api_keys and knowledge_revoke_api_key to audit and immediately revoke their own keys.

## Configuration reference

Copy [`.env.example`](.env.example) to .env. The table highlights the settings most operators need; the example file documents every setting and its default.

| Variable | Required | Purpose |
| --- | --- | --- |
| OIDC_ISSUER | Yes | Public issuer URL; must match the iss token claim |
| OIDC_AUDIENCE | Yes | Required audience/client ID in access tokens |
| OIDC_DISCOVERY_URL | No | Internal discovery URL override for split network setups |
| PUBLIC_URL | Production | Public HTTPS URL advertised to MCP clients |
| NEO4J_PASSWORD | Yes | Neo4j database password |
| NEO4J_URI | No | Defaults to bolt://neo4j:7687 in Docker |
| DEFAULT_NAMESPACE | No | Used when the client provides none; default default |
| SCOPES_ALLOWLIST | No | Comma-separated OAuth scopes advertised to clients |
| ALLOWED_ORIGINS | No | Comma-separated CORS origins; empty disables CORS; * is local-development only |
| API_KEYS_ENABLED | No | Enables optional API key authentication; default false |
| API_KEYS_HASH_SECRET | Conditional | At least 32 characters; required when API keys are enabled |
| API_KEYS_MAX_PER_USER | No | Active-key limit per user; default 20 |
| MAX_REQUEST_BODY_BYTES | No | Request-size limit; default 256 KiB |
| MAX_TOKEN_LIFETIME_SECONDS | No | Reject access tokens that live longer than this; default 3600 |
| LOG_LEVEL | No | trace, debug, info, warn, or error |

## Operations and troubleshooting

### Expected session behaviour

MCP sessions are held in memory. After initialize, clients send the returned Mcp-Session-Id header on later requests. Sessions expire after 24 hours of inactivity, and a server restart clears them. MCP clients normally reinitialize automatically.

### Check a deployment

~~~bash
curl --fail https://vault.example.com/.well-known/oauth-protected-resource
curl --fail https://vault.example.com/.well-known/oauth-authorization-server
docker compose ps
docker compose logs -f graph-mcp-vault
~~~

### Common problems

| Symptom | Check |
| --- | --- |
| The OAuth browser flow does not start | PUBLIC_URL is HTTPS and reachable; both discovery URLs return JSON; the client uses the /mcp endpoint. |
| The identity provider rejects login | Client ID/audience, PKCE support, allowed scopes, and loopback redirect URI configuration. |
| The server returns 401 after login | The access token has the expected iss, aud, RS256 signature, and acceptable lifetime. |
| A client can see too much | Use a namespace-restricted API key and ?lock_namespace=true; namespaces alone are not a hard boundary. |
| An API key is rejected | Confirm API_KEYS_ENABLED=true, the value begins with gmv_, it has not expired or been revoked, and the client process received the environment variable. |
| Cross-origin browser requests fail | Set the exact requesting origin in ALLOWED_ORIGINS; do not use * in production. |

For end-to-end manual verification, use the [LLM smoke-test checklist](docs/SMOKE_TEST.md).

## Development

### Requirements

- Node.js 24+
- pnpm
- Docker, for integration tests and the local stack

~~~bash
pnpm install
pnpm test
pnpm lint
pnpm build
~~~

Integration tests run against real temporary Neo4j containers through Testcontainers, so Docker must be available.

Useful commands:

~~~bash
pnpm dev                        # Run the TypeScript server with reload
pnpm test -- tests/auth.test.ts # Run one test file
docker compose up -d            # Run the production Compose stack
docker compose down             # Stop it; Neo4j data is retained
~~~

## Further reading

- [Open WebUI setup example](docs/OPEN_WEBUI_SETUP_EXAMPLE.md)
- [Smoke-test checklist](docs/SMOKE_TEST.md)
- [Architecture decisions](docs/DECISIONS.md)
- [Release runbook](docs/RELEASE.md)
- [Changelog](CHANGELOG.md)

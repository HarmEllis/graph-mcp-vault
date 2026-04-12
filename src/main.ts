import 'dotenv/config';
import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import neo4j from 'neo4j-driver';
import { parseConfig } from './config.js';
import { JwksClient } from './auth.js';
import { SessionStore } from './session.js';
import { initSchema } from './schema.js';
import { Neo4jClient } from './neo4j-client.js';
import { OidcMetadataClient, createOAuthMetaRouter } from './routers/oauth-meta.js';
import { createMcpRouter } from './routers/mcp.js';
import { createResourceTools } from './tools/resources.js';

const config = parseConfig(process.env as Record<string, string | undefined>);

// ── Neo4j ─────────────────────────────────────────────────────────────────────

const driver = neo4j.driver(
  config.neo4jUri,
  neo4j.auth.basic(config.neo4jUser, config.neo4jPassword),
);
await initSchema(driver);
const _neo4jClient = new Neo4jClient(driver);

// ── Auth + sessions ───────────────────────────────────────────────────────────

const jwksClient = new JwksClient(
  `${config.oidcIssuer}/.well-known/jwks.json`,
  config.jwksCacheTtl * 1000,
);

const sessionStore = new SessionStore();
sessionStore.startCleanup();

// ── Metadata client ───────────────────────────────────────────────────────────

const metadataClient = new OidcMetadataClient(config.oidcIssuer, config.metadataCacheTtl * 1000);

// ── Hono app ──────────────────────────────────────────────────────────────────

const app = new Hono();
app.route('/', createOAuthMetaRouter(metadataClient));
const tools = createResourceTools(_neo4jClient);
app.route('/', createMcpRouter(config, sessionStore, jwksClient, tools));

// ── Start server ──────────────────────────────────────────────────────────────

serve({ fetch: app.fetch, hostname: config.host, port: config.port }, (info) => {
  console.log(`graph-mcp-vault listening on ${info.address}:${info.port}`);
});

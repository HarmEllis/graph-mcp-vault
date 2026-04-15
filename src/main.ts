import "dotenv/config";
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import neo4j from "neo4j-driver";
import { z } from "zod";
import { JwksClient } from "./auth.js";
import { parseConfig } from "./config.js";
import { createLogger } from "./logger.js";
import { Neo4jClient } from "./neo4j-client.js";
import { createMcpRouter } from "./routers/mcp.js";
import {
  OidcMetadataClient,
  createOAuthMetaRouter,
} from "./routers/oauth-meta.js";
import { initSchema } from "./schema.js";
import { SessionStore } from "./session.js";
import { createResourceTools } from "./tools/resources.js";
import { createSharingTools } from "./tools/sharing.js";

const config = parseConfig(process.env as Record<string, string | undefined>);
const logger = createLogger(config.logLevel);

// ── Neo4j ─────────────────────────────────────────────────────────────────────

logger.info("startup", {
  neo4jUri: config.neo4jUri,
  port: config.port,
  logLevel: config.logLevel,
});

const driver = neo4j.driver(
  config.neo4jUri,
  neo4j.auth.basic(config.neo4jUser, config.neo4jPassword),
);
await initSchema(driver);
const _neo4jClient = new Neo4jClient(driver);

// ── Auth + sessions ───────────────────────────────────────────────────────────

// Resolve jwks_uri from the OIDC discovery document so we stay compatible
// with any issuer, not just those that put JWKS at /.well-known/jwks.json.
const discoveryUrl =
  config.oidcDiscoveryUrl ??
  `${config.oidcIssuer}/.well-known/openid-configuration`;
const oidcDiscovery = await fetch(discoveryUrl);
if (!oidcDiscovery.ok) {
  throw new Error(`OIDC discovery failed: HTTP ${oidcDiscovery.status}`);
}
const discoveryDoc = (await oidcDiscovery.json()) as Record<string, unknown>;
const { jwks_uri } = z
  .object({ jwks_uri: z.string().url() })
  .parse(discoveryDoc);
logger.debug("oidc_discovery_ok", { jwksUri: jwks_uri });

const jwksClient = new JwksClient(jwks_uri, config.jwksCacheTtl * 1000);

const sessionStore = new SessionStore();
sessionStore.startCleanup();

// ── Metadata client ───────────────────────────────────────────────────────────

const metadataClient = new OidcMetadataClient(
  config.oidcIssuer,
  config.metadataCacheTtl * 1000,
  config.oidcDiscoveryUrl,
);

// ── Hono app ──────────────────────────────────────────────────────────────────

const app = new Hono();
app.route("/", createOAuthMetaRouter(metadataClient, config.scopesAllowlist));
const tools = [
  ...createResourceTools(_neo4jClient),
  ...createSharingTools(_neo4jClient),
];
app.route(
  "/",
  createMcpRouter(
    config,
    sessionStore,
    jwksClient,
    tools,
    _neo4jClient,
    logger,
  ),
);

// ── Start server ──────────────────────────────────────────────────────────────

serve(
  { fetch: app.fetch, hostname: config.host, port: config.port },
  (info) => {
    logger.info("server_listening", { address: info.address, port: info.port });
  },
);

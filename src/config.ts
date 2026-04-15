import { z } from "zod";

const envSchema = z.object({
  OIDC_ISSUER: z.string().url(),
  OIDC_AUDIENCE: z.string().min(1),
  OIDC_DISCOVERY_URL: z.string().url().optional(),
  PUBLIC_URL: z.string().url().optional(),
  JWKS_CACHE_TTL: z.coerce.number().int().positive().default(3600),
  METADATA_CACHE_TTL: z.coerce.number().int().positive().default(3600),
  NEO4J_URI: z.string().min(1),
  NEO4J_USER: z.string().min(1),
  NEO4J_PASSWORD: z.string().min(1),
  HOST: z.string().default("0.0.0.0"),
  PORT: z.coerce.number().int().positive().default(8000),
  DEFAULT_NAMESPACE: z.string().default("default"),
  LOG_LEVEL: z
    .enum(["trace", "debug", "info", "warn", "error"])
    .default("info"),
  ALLOWED_ORIGINS: z.string().default(""),
  SCOPES_ALLOWLIST: z.string().optional(),
  INJECT_MISSING_SCOPE: z
    .string()
    .optional()
    .transform((v) => v !== undefined && (v === "true" || v === "1")),
});

export interface Config {
  oidcIssuer: string;
  oidcAudience: string;
  oidcDiscoveryUrl: string | undefined;
  publicUrl: string;
  jwksCacheTtl: number;
  metadataCacheTtl: number;
  neo4jUri: string;
  neo4jUser: string;
  neo4jPassword: string;
  host: string;
  port: number;
  defaultNamespace: string;
  logLevel: "trace" | "debug" | "info" | "warn" | "error";
  allowedOrigins: string;
  scopesAllowlist: string[] | undefined;
  injectMissingScope: boolean;
}

export function parseConfig(env: Record<string, string | undefined>): Config {
  const parsed = envSchema.parse(env);
  const scopesAllowlist = parsed.SCOPES_ALLOWLIST
    ? parsed.SCOPES_ALLOWLIST.split(",")
        .map((s) => s.trim())
        .filter((s) => s.length > 0)
    : undefined;

  return {
    oidcIssuer: parsed.OIDC_ISSUER,
    oidcAudience: parsed.OIDC_AUDIENCE,
    oidcDiscoveryUrl: parsed.OIDC_DISCOVERY_URL,
    publicUrl: parsed.PUBLIC_URL ?? `http://localhost:${parsed.PORT}`,
    jwksCacheTtl: parsed.JWKS_CACHE_TTL,
    metadataCacheTtl: parsed.METADATA_CACHE_TTL,
    neo4jUri: parsed.NEO4J_URI,
    neo4jUser: parsed.NEO4J_USER,
    neo4jPassword: parsed.NEO4J_PASSWORD,
    host: parsed.HOST,
    port: parsed.PORT,
    defaultNamespace: parsed.DEFAULT_NAMESPACE,
    logLevel: parsed.LOG_LEVEL,
    allowedOrigins: parsed.ALLOWED_ORIGINS,
    scopesAllowlist,
    injectMissingScope: parsed.INJECT_MISSING_SCOPE,
  };
}

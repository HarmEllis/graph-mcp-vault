import { z } from "zod";
import { NAMESPACE_ERROR_MESSAGE, NAMESPACE_REGEX } from "./namespace.js";

const envSchema = z.object({
  OIDC_ISSUER: z.string().url(),
  OIDC_AUDIENCE: z.string().min(1),
  OIDC_DISCOVERY_URL: z.string().url().optional(),
  PUBLIC_URL: z.string().url().optional(),
  JWKS_CACHE_TTL: z.coerce.number().int().positive().default(3600),
  JWKS_FORCE_REFRESH_MIN_INTERVAL_SECONDS: z.coerce
    .number()
    .int()
    .nonnegative()
    .default(30),
  JWKS_FETCH_TIMEOUT_MS: z.coerce.number().int().positive().default(5000),
  JWKS_ALLOW_STALE_ON_ERROR: z.enum(["true", "false"]).default("false"),
  MAX_TOKEN_LIFETIME_SECONDS: z.coerce.number().int().positive().default(3600),
  MAX_REQUEST_BODY_BYTES: z.coerce.number().int().positive().default(262144),
  METADATA_CACHE_TTL: z.coerce.number().int().positive().default(3600),
  NEO4J_URI: z.string().min(1),
  NEO4J_USER: z.string().min(1),
  NEO4J_PASSWORD: z.string().min(1),
  HOST: z.string().default("0.0.0.0"),
  PORT: z.coerce.number().int().positive().default(8000),
  DEFAULT_NAMESPACE: z
    .string()
    .regex(NAMESPACE_REGEX, NAMESPACE_ERROR_MESSAGE)
    .default("default"),
  LOG_LEVEL: z
    .enum(["trace", "debug", "info", "warn", "error"])
    .default("info"),
  ALLOWED_ORIGINS: z.string().default(""),
  SCOPES_ALLOWLIST: z.string().optional(),
  MAX_VERSIONS_LIMIT: z.coerce.number().int().min(0).default(10),
});

export interface Config {
  oidcIssuer: string;
  oidcAudience: string;
  oidcDiscoveryUrl: string | undefined;
  publicUrl: string;
  jwksCacheTtl: number;
  /** Minimum milliseconds between forced JWKS refreshes (flood protection). */
  jwksForceRefreshMinIntervalMs: number;
  jwksFetchTimeoutMs: number;
  jwksAllowStaleOnError: boolean;
  maxTokenLifetimeSeconds: number;
  maxRequestBodyBytes: number;
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
  /** Hard ceiling on stored versions per entry. 0 = versioning disabled globally. */
  maxVersionsLimit: number;
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
    jwksForceRefreshMinIntervalMs:
      parsed.JWKS_FORCE_REFRESH_MIN_INTERVAL_SECONDS * 1000,
    jwksFetchTimeoutMs: parsed.JWKS_FETCH_TIMEOUT_MS,
    jwksAllowStaleOnError: parsed.JWKS_ALLOW_STALE_ON_ERROR === "true",
    maxTokenLifetimeSeconds: parsed.MAX_TOKEN_LIFETIME_SECONDS,
    maxRequestBodyBytes: parsed.MAX_REQUEST_BODY_BYTES,
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
    maxVersionsLimit: parsed.MAX_VERSIONS_LIMIT,
  };
}

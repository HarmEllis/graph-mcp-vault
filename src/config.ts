import { z } from 'zod';

const envSchema = z.object({
  OIDC_ISSUER: z.string().url(),
  OIDC_AUDIENCE: z.string().min(1),
  JWKS_CACHE_TTL: z.coerce.number().int().positive().default(3600),
  METADATA_CACHE_TTL: z.coerce.number().int().positive().default(3600),
  NEO4J_URI: z.string().min(1),
  NEO4J_USER: z.string().min(1),
  NEO4J_PASSWORD: z.string().min(1),
  HOST: z.string().default('0.0.0.0'),
  PORT: z.coerce.number().int().positive().default(8000),
  DEFAULT_NAMESPACE: z.string().default('default'),
  LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error']).default('info'),
  ALLOWED_ORIGINS: z.string().default(''),
});

export interface Config {
  oidcIssuer: string;
  oidcAudience: string;
  jwksCacheTtl: number;
  metadataCacheTtl: number;
  neo4jUri: string;
  neo4jUser: string;
  neo4jPassword: string;
  host: string;
  port: number;
  defaultNamespace: string;
  logLevel: 'trace' | 'debug' | 'info' | 'warn' | 'error';
  allowedOrigins: string;
}

export function parseConfig(env: Record<string, string | undefined>): Config {
  const parsed = envSchema.parse(env);
  return {
    oidcIssuer: parsed.OIDC_ISSUER,
    oidcAudience: parsed.OIDC_AUDIENCE,
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
  };
}

import { describe, it, expect } from 'vitest';
import { parseConfig } from '../src/config.js';

const required = {
  OIDC_ISSUER: 'https://oidc.example.com',
  OIDC_AUDIENCE: 'graph-mcp-vault',
  NEO4J_URI: 'bolt://localhost:7687',
  NEO4J_USER: 'neo4j',
  NEO4J_PASSWORD: 'secret',
};

describe('parseConfig', () => {
  it('parses valid environment with all required fields', () => {
    const config = parseConfig(required);
    expect(config.oidcIssuer).toBe('https://oidc.example.com');
    expect(config.oidcAudience).toBe('graph-mcp-vault');
    expect(config.neo4jUri).toBe('bolt://localhost:7687');
    expect(config.neo4jUser).toBe('neo4j');
    expect(config.neo4jPassword).toBe('secret');
  });

  it('applies default values for all optional fields', () => {
    const config = parseConfig(required);
    expect(config.jwksCacheTtl).toBe(3600);
    expect(config.metadataCacheTtl).toBe(3600);
    expect(config.host).toBe('0.0.0.0');
    expect(config.port).toBe(8000);
    expect(config.defaultNamespace).toBe('default');
    expect(config.logLevel).toBe('info');
    expect(config.allowedOrigins).toBe('');
  });

  it('accepts overridden optional values', () => {
    const config = parseConfig({
      ...required,
      PORT: '3000',
      LOG_LEVEL: 'debug',
      DEFAULT_NAMESPACE: 'prod',
      ALLOWED_ORIGINS: '*',
    });
    expect(config.port).toBe(3000);
    expect(config.logLevel).toBe('debug');
    expect(config.defaultNamespace).toBe('prod');
    expect(config.allowedOrigins).toBe('*');
  });

  it('coerces JWKS_CACHE_TTL string to number', () => {
    const config = parseConfig({ ...required, JWKS_CACHE_TTL: '7200' });
    expect(config.jwksCacheTtl).toBe(7200);
  });

  it('throws when OIDC_ISSUER is missing', () => {
    const { OIDC_ISSUER: _omit, ...rest } = required;
    expect(() => parseConfig(rest)).toThrow();
  });

  it('throws when NEO4J_PASSWORD is missing', () => {
    const { NEO4J_PASSWORD: _omit, ...rest } = required;
    expect(() => parseConfig(rest)).toThrow();
  });

  it('throws when PORT is not a valid number', () => {
    expect(() => parseConfig({ ...required, PORT: 'not-a-number' })).toThrow();
  });

  it('throws when LOG_LEVEL is not a valid enum value', () => {
    expect(() => parseConfig({ ...required, LOG_LEVEL: 'verbose' })).toThrow();
  });
});

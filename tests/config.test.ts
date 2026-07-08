import { describe, expect, it } from "vitest";
import { parseConfig } from "../src/config.js";

const required = {
  OIDC_ISSUER: "https://oidc.example.com",
  OIDC_AUDIENCE: "graph-mcp-vault",
  NEO4J_URI: "bolt://localhost:7687",
  NEO4J_USER: "neo4j",
  NEO4J_PASSWORD: "secret",
};

describe("parseConfig", () => {
  it("parses valid environment with all required fields", () => {
    const config = parseConfig(required);
    expect(config.oidcIssuer).toBe("https://oidc.example.com");
    expect(config.oidcAudience).toBe("graph-mcp-vault");
    expect(config.neo4jUri).toBe("bolt://localhost:7687");
    expect(config.neo4jUser).toBe("neo4j");
    expect(config.neo4jPassword).toBe("secret");
  });

  it("applies default values for all optional fields", () => {
    const config = parseConfig(required);
    expect(config.jwksCacheTtl).toBe(3600);
    expect(config.metadataCacheTtl).toBe(3600);
    expect(config.host).toBe("0.0.0.0");
    expect(config.port).toBe(8000);
    expect(config.defaultNamespace).toBe("default");
    expect(config.logLevel).toBe("info");
    expect(config.allowedOrigins).toBe("");
    expect(config.apiKeysEnabled).toBe(false);
    expect(config.apiKeysMaxPerUser).toBe(20);
    expect(config.apiKeysHashSecret).toBeUndefined();
  });

  it("accepts overridden optional values", () => {
    const config = parseConfig({
      ...required,
      PORT: "3000",
      LOG_LEVEL: "debug",
      DEFAULT_NAMESPACE: "prod",
      ALLOWED_ORIGINS: "*",
    });
    expect(config.port).toBe(3000);
    expect(config.logLevel).toBe("debug");
    expect(config.defaultNamespace).toBe("prod");
    expect(config.allowedOrigins).toBe("*");
  });

  it("coerces JWKS_CACHE_TTL string to number", () => {
    const config = parseConfig({ ...required, JWKS_CACHE_TTL: "7200" });
    expect(config.jwksCacheTtl).toBe(7200);
  });

  it("throws when OIDC_ISSUER is missing", () => {
    const { OIDC_ISSUER: _omit, ...rest } = required;
    expect(() => parseConfig(rest)).toThrow();
  });

  it("throws when NEO4J_PASSWORD is missing", () => {
    const { NEO4J_PASSWORD: _omit, ...rest } = required;
    expect(() => parseConfig(rest)).toThrow();
  });

  it("throws when PORT is not a valid number", () => {
    expect(() => parseConfig({ ...required, PORT: "not-a-number" })).toThrow();
  });

  it("throws when LOG_LEVEL is not a valid enum value", () => {
    expect(() => parseConfig({ ...required, LOG_LEVEL: "verbose" })).toThrow();
  });

  // ── OIDC_DISCOVERY_URL ──────────────────────────────────────────────────────

  it("oidcDiscoveryUrl defaults to undefined when OIDC_DISCOVERY_URL is not set", () => {
    const config = parseConfig(required);
    expect(config.oidcDiscoveryUrl).toBeUndefined();
  });

  it("accepts and stores OIDC_DISCOVERY_URL", () => {
    const config = parseConfig({
      ...required,
      OIDC_DISCOVERY_URL:
        "https://custom.example.com/.well-known/openid-configuration",
    });
    expect(config.oidcDiscoveryUrl).toBe(
      "https://custom.example.com/.well-known/openid-configuration",
    );
  });

  it("throws when OIDC_DISCOVERY_URL is set but not a valid URL", () => {
    expect(() =>
      parseConfig({ ...required, OIDC_DISCOVERY_URL: "not-a-url" }),
    ).toThrow();
  });

  // ── SCOPES_ALLOWLIST ────────────────────────────────────────────────────────

  it("scopesAllowlist defaults to undefined when SCOPES_ALLOWLIST is not set", () => {
    const config = parseConfig(required);
    expect(config.scopesAllowlist).toBeUndefined();
  });

  it("parses SCOPES_ALLOWLIST into a trimmed string array", () => {
    const config = parseConfig({
      ...required,
      SCOPES_ALLOWLIST: "openid, profile, email",
    });
    expect(config.scopesAllowlist).toEqual(["openid", "profile", "email"]);
  });

  it("parses SCOPES_ALLOWLIST with no spaces", () => {
    const config = parseConfig({
      ...required,
      SCOPES_ALLOWLIST: "openid,profile",
    });
    expect(config.scopesAllowlist).toEqual(["openid", "profile"]);
  });

  // ── PUBLIC_URL ──────────────────────────────────────────────────────────────

  it("publicUrl defaults to http://localhost:<PORT> when PUBLIC_URL is not set", () => {
    const config = parseConfig(required);
    expect(config.publicUrl).toBe("http://localhost:8000");
  });

  it("publicUrl uses the configured PORT in the default", () => {
    const config = parseConfig({ ...required, PORT: "3000" });
    expect(config.publicUrl).toBe("http://localhost:3000");
  });

  it("accepts and stores PUBLIC_URL", () => {
    const config = parseConfig({
      ...required,
      PUBLIC_URL: "https://mcp.example.com",
    });
    expect(config.publicUrl).toBe("https://mcp.example.com");
  });

  it("throws when PUBLIC_URL is set but not a valid URL", () => {
    expect(() =>
      parseConfig({ ...required, PUBLIC_URL: "not-a-url" }),
    ).toThrow();
  });

  // ── DEFAULT_NAMESPACE format ────────────────────────────────────────────────

  it("throws when DEFAULT_NAMESPACE does not match the strict format", () => {
    expect(() =>
      parseConfig({ ...required, DEFAULT_NAMESPACE: "My_NS" }),
    ).toThrow();
  });

  it("accepts a hyphenated DEFAULT_NAMESPACE", () => {
    const config = parseConfig({ ...required, DEFAULT_NAMESPACE: "foo-bar" });
    expect(config.defaultNamespace).toBe("foo-bar");
  });

  // ── New hardening fields ────────────────────────────────────────────────────

  it("maxRequestBodyBytes defaults to 262144", () => {
    const config = parseConfig(required);
    expect(config.maxRequestBodyBytes).toBe(262144);
  });

  it("accepts a custom MAX_REQUEST_BODY_BYTES", () => {
    const config = parseConfig({
      ...required,
      MAX_REQUEST_BODY_BYTES: "1048576",
    });
    expect(config.maxRequestBodyBytes).toBe(1048576);
  });

  it("jwksForceRefreshMinIntervalMs defaults to 30000 ms", () => {
    const config = parseConfig(required);
    expect(config.jwksForceRefreshMinIntervalMs).toBe(30_000);
  });

  it("jwksForceRefreshMinIntervalMs converts seconds to ms", () => {
    const config = parseConfig({
      ...required,
      JWKS_FORCE_REFRESH_MIN_INTERVAL_SECONDS: "60",
    });
    expect(config.jwksForceRefreshMinIntervalMs).toBe(60_000);
  });

  it("jwksFetchTimeoutMs defaults to 5000", () => {
    const config = parseConfig(required);
    expect(config.jwksFetchTimeoutMs).toBe(5000);
  });

  it("jwksAllowStaleOnError defaults to false", () => {
    const config = parseConfig(required);
    expect(config.jwksAllowStaleOnError).toBe(false);
  });

  it("jwksAllowStaleOnError is true when JWKS_ALLOW_STALE_ON_ERROR=true", () => {
    const config = parseConfig({
      ...required,
      JWKS_ALLOW_STALE_ON_ERROR: "true",
    });
    expect(config.jwksAllowStaleOnError).toBe(true);
  });

  it("maxTokenLifetimeSeconds defaults to 3600", () => {
    const config = parseConfig(required);
    expect(config.maxTokenLifetimeSeconds).toBe(3600);
  });

  it("accepts a custom MAX_TOKEN_LIFETIME_SECONDS", () => {
    const config = parseConfig({
      ...required,
      MAX_TOKEN_LIFETIME_SECONDS: "7200",
    });
    expect(config.maxTokenLifetimeSeconds).toBe(7200);
  });

  it("throws when JWKS_ALLOW_STALE_ON_ERROR is not true or false", () => {
    expect(() =>
      parseConfig({ ...required, JWKS_ALLOW_STALE_ON_ERROR: "yes" }),
    ).toThrow();
  });

  // ── API key authentication fields ──────────────────────────────────────────

  it("apiKeysEnabled is true when API_KEYS_ENABLED=true and API_KEYS_HASH_SECRET is set", () => {
    const config = parseConfig({
      ...required,
      API_KEYS_ENABLED: "true",
      API_KEYS_HASH_SECRET: "test-api-key-hash-secret-at-least-32-chars",
    });
    expect(config.apiKeysEnabled).toBe(true);
    expect(config.apiKeysHashSecret).toBe(
      "test-api-key-hash-secret-at-least-32-chars",
    );
  });

  it("throws when API_KEYS_ENABLED=true without API_KEYS_HASH_SECRET", () => {
    expect(() =>
      parseConfig({ ...required, API_KEYS_ENABLED: "true" }),
    ).toThrow();
  });

  it("throws when API_KEYS_HASH_SECRET is too short", () => {
    expect(() =>
      parseConfig({
        ...required,
        API_KEYS_ENABLED: "true",
        API_KEYS_HASH_SECRET: "short",
      }),
    ).toThrow();
  });

  it("throws when API_KEYS_ENABLED is not true or false", () => {
    expect(() =>
      parseConfig({ ...required, API_KEYS_ENABLED: "yes" }),
    ).toThrow();
  });

  it("accepts a custom API_KEYS_MAX_PER_USER", () => {
    const config = parseConfig({
      ...required,
      API_KEYS_MAX_PER_USER: "5",
    });
    expect(config.apiKeysMaxPerUser).toBe(5);
  });

  it("throws when API_KEYS_MAX_PER_USER is less than one", () => {
    expect(() =>
      parseConfig({ ...required, API_KEYS_MAX_PER_USER: "0" }),
    ).toThrow();
  });
});

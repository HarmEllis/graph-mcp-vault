import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { SignJWT, exportJWK, generateKeyPair } from 'jose';
import type { KeyLike } from 'jose';
import { GenericContainer, Wait, type StartedTestContainer } from 'testcontainers';
import neo4j, { type Driver } from 'neo4j-driver';
import { Hono } from 'hono';
import { createMcpRouter } from '../src/routers/mcp.js';
import { JwksClient } from '../src/auth.js';
import { SessionStore } from '../src/session.js';
import { ErrorCode } from '../src/errors.js';
import { initSchema } from '../src/schema.js';
import { Neo4jClient } from '../src/neo4j-client.js';
import { createResourceTools } from '../src/tools/resources.js';
import { createSharingTools } from '../src/tools/sharing.js';
import type { Config } from '../src/config.js';

// ── Fixtures ──────────────────────────────────────────────────────────────────

const ISSUER = 'https://oidc.example.com';
const AUDIENCE = 'graph-mcp-vault';
const KID = 'sharing-test-key';
const JWKS_URI = `${ISSUER}/.well-known/jwks.json`;
const NEO4J_PASSWORD = 'testpassword';

const BASE_CONFIG: Config = {
  oidcIssuer: ISSUER,
  oidcAudience: AUDIENCE,
  jwksCacheTtl: 3600,
  metadataCacheTtl: 3600,
  neo4jUri: 'bolt://localhost:7687',
  neo4jUser: 'neo4j',
  neo4jPassword: NEO4J_PASSWORD,
  host: '0.0.0.0',
  port: 8000,
  defaultNamespace: 'default',
  logLevel: 'info',
  allowedOrigins: '',
};

let container: StartedTestContainer;
let driver: Driver;
let neo4jClient: Neo4jClient;
let app: Hono;
let privateKey: KeyLike;
let userCounter = 0;

beforeAll(async () => {
  container = await new GenericContainer('neo4j:5-community')
    .withEnvironment({ NEO4J_AUTH: `neo4j/${NEO4J_PASSWORD}` })
    .withExposedPorts(7687)
    .withWaitStrategy(Wait.forLogMessage('Bolt enabled on'))
    .start();

  const boltPort = container.getMappedPort(7687);
  driver = neo4j.driver(
    `bolt://localhost:${boltPort}`,
    neo4j.auth.basic('neo4j', NEO4J_PASSWORD),
  );
  await initSchema(driver);
  neo4jClient = new Neo4jClient(driver);

  const pair = await generateKeyPair('RS256');
  privateKey = pair.privateKey;
  const jwk = await exportJWK(pair.publicKey);
  const jwksDoc = { keys: [{ ...jwk, kid: KID, use: 'sig' }] };

  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => jwksDoc }),
  );

  const sessionStore = new SessionStore();
  const jwksClient = new JwksClient(JWKS_URI, BASE_CONFIG.jwksCacheTtl * 1000);
  const tools = [
    ...createResourceTools(neo4jClient),
    ...createSharingTools(neo4jClient),
  ];
  app = new Hono();
  app.route('/', createMcpRouter(BASE_CONFIG, sessionStore, jwksClient, tools));
}, 120_000);

afterAll(async () => {
  vi.unstubAllGlobals();
  await driver?.close();
  await container?.stop();
});

// ── Helpers ───────────────────────────────────────────────────────────────────

function uid(label: string): string {
  userCounter += 1;
  return `sharing-${label}-${userCounter}`;
}

async function makeToken(sub: string): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({ sub })
    .setProtectedHeader({ alg: 'RS256', kid: KID })
    .setIssuer(ISSUER)
    .setAudience(AUDIENCE)
    .setIssuedAt()
    .setExpirationTime(now + 3600)
    .sign(privateKey);
}

async function openSession(sub: string): Promise<string> {
  const token = await makeToken(sub);
  const res = await app.request('/mcp', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 0,
      method: 'initialize',
      params: {
        protocolVersion: '2025-03-26',
        capabilities: {},
        clientInfo: { name: 'test', version: '1.0' },
      },
    }),
  });
  const sid = res.headers.get('mcp-session-id');
  if (!sid) throw new Error(`initialize failed (status ${res.status})`);
  return sid;
}

async function callTool(
  toolName: string,
  args: Record<string, unknown>,
  sub: string,
  sessionId: string,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const token = await makeToken(sub);
  const res = await app.request('/mcp', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
      'Mcp-Session-Id': sessionId,
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: toolName, arguments: args },
    }),
  });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

/** Creates a resource as `owner` and returns its id. */
async function createResource(owner: string, ownerSid: string, title = 'Shared Resource'): Promise<string> {
  const { body } = await callTool(
    'create_resource',
    { type: 'note', title, content: '' },
    owner,
    ownerSid,
  );
  return ((body['result'] as Record<string, unknown>)['id']) as string;
}

// ── share_resource ────────────────────────────────────────────────────────────

describe('share_resource', () => {
  it('owner can share a resource with another user', async () => {
    const owner = uid('share-owner');
    const target = uid('share-target');
    const ownerSid = await openSession(owner);
    const id = await createResource(owner, ownerSid);

    const { status, body } = await callTool(
      'share_resource',
      { resource_id: id, target_user_id: target, role: 'viewer' },
      owner,
      ownerSid,
    );

    expect(status).toBe(200);
    expect(body['error']).toBeUndefined();
  });

  it('shared user can then read the resource', async () => {
    const owner = uid('share-read-owner');
    const viewer = uid('share-read-viewer');
    const ownerSid = await openSession(owner);
    const viewerSid = await openSession(viewer);
    const id = await createResource(owner, ownerSid);

    await callTool(
      'share_resource',
      { resource_id: id, target_user_id: viewer, role: 'viewer' },
      owner,
      ownerSid,
    );

    const { body } = await callTool('get_resource', { resource_id: id }, viewer, viewerSid);
    const result = body['result'] as Record<string, unknown>;
    expect(result['id']).toBe(id);
    expect(result['role']).toBe('viewer');
  });

  it('duplicate share updates the role (idempotent MERGE)', async () => {
    const owner = uid('share-idem-owner');
    const target = uid('share-idem-target');
    const ownerSid = await openSession(owner);
    const targetSid = await openSession(target);
    const id = await createResource(owner, ownerSid);

    // First share as viewer
    await callTool(
      'share_resource',
      { resource_id: id, target_user_id: target, role: 'viewer' },
      owner,
      ownerSid,
    );
    // Upgrade to editor
    await callTool(
      'share_resource',
      { resource_id: id, target_user_id: target, role: 'editor' },
      owner,
      ownerSid,
    );

    const { body } = await callTool('get_resource', { resource_id: id }, target, targetSid);
    expect((body['result'] as Record<string, unknown>)['role']).toBe('editor');
  });

  it('share to a user who has never been created — stubs User node', async () => {
    const owner = uid('share-stub-owner');
    const brand_new = `never-seen-user-${Date.now()}`;
    const ownerSid = await openSession(owner);
    const id = await createResource(owner, ownerSid);

    const { status } = await callTool(
      'share_resource',
      { resource_id: id, target_user_id: brand_new, role: 'viewer' },
      owner,
      ownerSid,
    );
    expect(status).toBe(200);

    // Confirm the role was granted via neo4jClient
    const role = await neo4jClient.getEffectiveRole(brand_new, id);
    expect(role).toBe('viewer');
  });

  it('editor cannot share — returns PERMISSION_DENIED', async () => {
    const owner = uid('share-ed-owner');
    const editor = uid('share-ed-editor');
    const victim = uid('share-ed-victim');
    const ownerSid = await openSession(owner);
    const editorSid = await openSession(editor);
    const id = await createResource(owner, ownerSid);

    await neo4jClient.shareResource(id, editor, 'editor');

    const { body } = await callTool(
      'share_resource',
      { resource_id: id, target_user_id: victim, role: 'viewer' },
      editor,
      editorSid,
    );
    expect((body['error'] as Record<string, unknown>)['code']).toBe(ErrorCode.PERMISSION_DENIED);
  });

  it('viewer cannot share — returns PERMISSION_DENIED', async () => {
    const owner = uid('share-view-owner');
    const viewer = uid('share-view-viewer');
    const victim = uid('share-view-victim');
    const ownerSid = await openSession(owner);
    const viewerSid = await openSession(viewer);
    const id = await createResource(owner, ownerSid);

    await neo4jClient.shareResource(id, viewer, 'viewer');

    const { body } = await callTool(
      'share_resource',
      { resource_id: id, target_user_id: victim, role: 'viewer' },
      viewer,
      viewerSid,
    );
    expect((body['error'] as Record<string, unknown>)['code']).toBe(ErrorCode.PERMISSION_DENIED);
  });

  it('returns RESOURCE_NOT_FOUND for a non-existent resource', async () => {
    const owner = uid('share-missing-owner');
    const target = uid('share-missing-target');
    const ownerSid = await openSession(owner);

    const { body } = await callTool(
      'share_resource',
      { resource_id: '00000000-0000-0000-0000-000000000000', target_user_id: target, role: 'viewer' },
      owner,
      ownerSid,
    );
    expect((body['error'] as Record<string, unknown>)['code']).toBe(ErrorCode.RESOURCE_NOT_FOUND);
  });
});

// ── revoke_access ─────────────────────────────────────────────────────────────

describe('revoke_access', () => {
  it('owner can revoke a shared user\'s access', async () => {
    const owner = uid('revoke-owner');
    const viewer = uid('revoke-viewer');
    const ownerSid = await openSession(owner);
    const viewerSid = await openSession(viewer);
    const id = await createResource(owner, ownerSid);

    await callTool(
      'share_resource',
      { resource_id: id, target_user_id: viewer, role: 'viewer' },
      owner,
      ownerSid,
    );

    const { status } = await callTool(
      'revoke_access',
      { resource_id: id, target_user_id: viewer },
      owner,
      ownerSid,
    );
    expect(status).toBe(200);

    // Viewer can no longer access
    const { body } = await callTool('get_resource', { resource_id: id }, viewer, viewerSid);
    expect((body['error'] as Record<string, unknown>)['code']).toBe(ErrorCode.PERMISSION_DENIED);
  });

  it('revoke own access returns PERMISSION_DENIED with "Cannot revoke owner access"', async () => {
    const owner = uid('revoke-self-owner');
    const ownerSid = await openSession(owner);
    const id = await createResource(owner, ownerSid);

    const { body } = await callTool(
      'revoke_access',
      { resource_id: id, target_user_id: owner },
      owner,
      ownerSid,
    );

    const error = body['error'] as Record<string, unknown>;
    expect(error['code']).toBe(ErrorCode.PERMISSION_DENIED);
    expect(error['message']).toContain('Cannot revoke owner access');
  });

  it('editor cannot revoke access — returns PERMISSION_DENIED', async () => {
    const owner = uid('revoke-ed-owner');
    const editor = uid('revoke-ed-editor');
    const viewer = uid('revoke-ed-viewer');
    const ownerSid = await openSession(owner);
    const editorSid = await openSession(editor);
    const id = await createResource(owner, ownerSid);

    await neo4jClient.shareResource(id, editor, 'editor');
    await neo4jClient.shareResource(id, viewer, 'viewer');

    const { body } = await callTool(
      'revoke_access',
      { resource_id: id, target_user_id: viewer },
      editor,
      editorSid,
    );
    expect((body['error'] as Record<string, unknown>)['code']).toBe(ErrorCode.PERMISSION_DENIED);
  });

  it('returns RESOURCE_NOT_FOUND for a non-existent resource', async () => {
    const owner = uid('revoke-missing-owner');
    const target = uid('revoke-missing-target');
    const ownerSid = await openSession(owner);

    const { body } = await callTool(
      'revoke_access',
      { resource_id: '00000000-0000-0000-0000-000000000000', target_user_id: target },
      owner,
      ownerSid,
    );
    expect((body['error'] as Record<string, unknown>)['code']).toBe(ErrorCode.RESOURCE_NOT_FOUND);
  });
});

// ── list_sharing ──────────────────────────────────────────────────────────────

describe('list_sharing', () => {
  it('returns empty array when no users have been granted access', async () => {
    const owner = uid('list-empty-owner');
    const ownerSid = await openSession(owner);
    const id = await createResource(owner, ownerSid);

    const { status, body } = await callTool('list_sharing', { resource_id: id }, owner, ownerSid);

    expect(status).toBe(200);
    const result = body['result'] as Record<string, unknown>;
    expect(result['sharing']).toEqual([]);
  });

  it('returns all HAS_ACCESS entries with user_id, role, granted_at', async () => {
    const owner = uid('list-entries-owner');
    const viewer = uid('list-entries-viewer');
    const editor = uid('list-entries-editor');
    const ownerSid = await openSession(owner);
    const id = await createResource(owner, ownerSid);

    await callTool(
      'share_resource',
      { resource_id: id, target_user_id: viewer, role: 'viewer' },
      owner,
      ownerSid,
    );
    await callTool(
      'share_resource',
      { resource_id: id, target_user_id: editor, role: 'editor' },
      owner,
      ownerSid,
    );

    const { body } = await callTool('list_sharing', { resource_id: id }, owner, ownerSid);
    const sharing = (body['result'] as Record<string, unknown>)['sharing'] as Array<
      Record<string, unknown>
    >;

    expect(sharing).toHaveLength(2);
    expect(sharing.some((s) => s['user_id'] === viewer && s['role'] === 'viewer')).toBe(true);
    expect(sharing.some((s) => s['user_id'] === editor && s['role'] === 'editor')).toBe(true);
    expect(sharing.every((s) => typeof s['granted_at'] === 'string')).toBe(true);
  });

  it('a viewer can call list_sharing (requires only read)', async () => {
    const owner = uid('list-viewer-owner');
    const viewer = uid('list-viewer-viewer');
    const ownerSid = await openSession(owner);
    const viewerSid = await openSession(viewer);
    const id = await createResource(owner, ownerSid);

    await callTool(
      'share_resource',
      { resource_id: id, target_user_id: viewer, role: 'viewer' },
      owner,
      ownerSid,
    );

    const { status } = await callTool('list_sharing', { resource_id: id }, viewer, viewerSid);
    expect(status).toBe(200);
  });

  it('user with no access cannot list_sharing — returns PERMISSION_DENIED', async () => {
    const owner = uid('list-denied-owner');
    const stranger = uid('list-denied-stranger');
    const ownerSid = await openSession(owner);
    const strangerSid = await openSession(stranger);
    const id = await createResource(owner, ownerSid);

    const { body } = await callTool('list_sharing', { resource_id: id }, stranger, strangerSid);
    expect((body['error'] as Record<string, unknown>)['code']).toBe(ErrorCode.PERMISSION_DENIED);
  });

  it('returns RESOURCE_NOT_FOUND for a non-existent resource', async () => {
    const owner = uid('list-missing-owner');
    const ownerSid = await openSession(owner);

    const { body } = await callTool(
      'list_sharing',
      { resource_id: '00000000-0000-0000-0000-000000000000' },
      owner,
      ownerSid,
    );
    expect((body['error'] as Record<string, unknown>)['code']).toBe(ErrorCode.RESOURCE_NOT_FOUND);
  });
});

// ── Full sharing workflow ─────────────────────────────────────────────────────

describe('full sharing workflow', () => {
  it('share → list_sharing → access as viewer → revoke → access denied', async () => {
    const owner = uid('workflow-owner');
    const viewer = uid('workflow-viewer');
    const ownerSid = await openSession(owner);
    const viewerSid = await openSession(viewer);
    const id = await createResource(owner, ownerSid, 'Workflow Resource');

    // share
    await callTool(
      'share_resource',
      { resource_id: id, target_user_id: viewer, role: 'viewer' },
      owner,
      ownerSid,
    );

    // list_sharing shows the grant
    const { body: lb } = await callTool('list_sharing', { resource_id: id }, owner, ownerSid);
    const sharing = (lb['result'] as Record<string, unknown>)['sharing'] as Array<
      Record<string, unknown>
    >;
    expect(sharing.some((s) => s['user_id'] === viewer)).toBe(true);

    // viewer can read
    const { body: gb } = await callTool('get_resource', { resource_id: id }, viewer, viewerSid);
    expect((gb['result'] as Record<string, unknown>)['role']).toBe('viewer');

    // revoke
    await callTool(
      'revoke_access',
      { resource_id: id, target_user_id: viewer },
      owner,
      ownerSid,
    );

    // viewer access denied
    const { body: gb2 } = await callTool('get_resource', { resource_id: id }, viewer, viewerSid);
    expect((gb2['error'] as Record<string, unknown>)['code']).toBe(ErrorCode.PERMISSION_DENIED);
  });
});

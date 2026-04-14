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
  oidcDiscoveryUrl: undefined,
  scopesAllowlist: undefined,
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

// ── MCP content format helpers ────────────────────────────────────────────────

interface McpContentItem {
  type: string;
  text: string;
}

function parseToolSuccess(body: Record<string, unknown>): Record<string, unknown> {
  const result = body['result'] as Record<string, unknown>;
  const content = result['content'] as McpContentItem[];
  return JSON.parse(content[0]!.text) as Record<string, unknown>;
}

function parseToolError(body: Record<string, unknown>): { code: number; message: string } {
  const result = body['result'] as Record<string, unknown>;
  const content = result['content'] as McpContentItem[];
  return JSON.parse(content[0]!.text) as { code: number; message: string };
}

/** Creates an entry as `owner` and returns its id. */
async function createEntry(owner: string, ownerSid: string, title = 'Shared Resource'): Promise<string> {
  const { body } = await callTool(
    'knowledge_create_entry',
    { entry_type: 'note', title, content: '' },
    owner,
    ownerSid,
  );
  return parseToolSuccess(body)['id'] as string;
}

// ── knowledge_share_entry ─────────────────────────────────────────────────────

describe('knowledge_share_entry', () => {
  it('owner can share an entry with another user', async () => {
    const owner = uid('share-owner');
    const target = uid('share-target');
    const ownerSid = await openSession(owner);
    const id = await createEntry(owner, ownerSid);

    const { status, body } = await callTool(
      'knowledge_share_entry',
      { entry_id: id, target_user_id: target, role: 'viewer' },
      owner,
      ownerSid,
    );

    expect(status).toBe(200);
    expect(body['error']).toBeUndefined();
  });

  it('shared user can then read the entry', async () => {
    const owner = uid('share-read-owner');
    const viewer = uid('share-read-viewer');
    const ownerSid = await openSession(owner);
    const viewerSid = await openSession(viewer);
    const id = await createEntry(owner, ownerSid);

    await callTool(
      'knowledge_share_entry',
      { entry_id: id, target_user_id: viewer, role: 'viewer' },
      owner,
      ownerSid,
    );

    const { body } = await callTool('knowledge_get_entry', { entry_id: id }, viewer, viewerSid);
    const data = parseToolSuccess(body);
    expect(data['id']).toBe(id);
    expect(data['role']).toBe('viewer');
  });

  it('duplicate share updates the role (idempotent MERGE)', async () => {
    const owner = uid('share-idem-owner');
    const target = uid('share-idem-target');
    const ownerSid = await openSession(owner);
    const targetSid = await openSession(target);
    const id = await createEntry(owner, ownerSid);

    // First share as viewer
    await callTool(
      'knowledge_share_entry',
      { entry_id: id, target_user_id: target, role: 'viewer' },
      owner,
      ownerSid,
    );
    // Upgrade to editor
    await callTool(
      'knowledge_share_entry',
      { entry_id: id, target_user_id: target, role: 'editor' },
      owner,
      ownerSid,
    );

    const { body } = await callTool('knowledge_get_entry', { entry_id: id }, target, targetSid);
    expect(parseToolSuccess(body)['role']).toBe('editor');
  });

  it('share to a user who has never been created — stubs User node', async () => {
    const owner = uid('share-stub-owner');
    const brand_new = `never-seen-user-${Date.now()}`;
    const ownerSid = await openSession(owner);
    const id = await createEntry(owner, ownerSid);

    const { status } = await callTool(
      'knowledge_share_entry',
      { entry_id: id, target_user_id: brand_new, role: 'viewer' },
      owner,
      ownerSid,
    );
    expect(status).toBe(200);

    const role = await neo4jClient.getEffectiveRole(brand_new, id);
    expect(role).toBe('viewer');
  });

  it('editor cannot share — returns PERMISSION_DENIED', async () => {
    const owner = uid('share-ed-owner');
    const editor = uid('share-ed-editor');
    const victim = uid('share-ed-victim');
    const ownerSid = await openSession(owner);
    const editorSid = await openSession(editor);
    const id = await createEntry(owner, ownerSid);

    await neo4jClient.shareResource(id, editor, 'editor');

    const { body } = await callTool(
      'knowledge_share_entry',
      { entry_id: id, target_user_id: victim, role: 'viewer' },
      editor,
      editorSid,
    );
    expect(parseToolError(body)['code']).toBe(ErrorCode.PERMISSION_DENIED);
  });

  it('viewer cannot share — returns PERMISSION_DENIED', async () => {
    const owner = uid('share-view-owner');
    const viewer = uid('share-view-viewer');
    const victim = uid('share-view-victim');
    const ownerSid = await openSession(owner);
    const viewerSid = await openSession(viewer);
    const id = await createEntry(owner, ownerSid);

    await neo4jClient.shareResource(id, viewer, 'viewer');

    const { body } = await callTool(
      'knowledge_share_entry',
      { entry_id: id, target_user_id: victim, role: 'viewer' },
      viewer,
      viewerSid,
    );
    expect(parseToolError(body)['code']).toBe(ErrorCode.PERMISSION_DENIED);
  });

  it('returns RESOURCE_NOT_FOUND for a non-existent entry', async () => {
    const owner = uid('share-missing-owner');
    const target = uid('share-missing-target');
    const ownerSid = await openSession(owner);

    const { body } = await callTool(
      'knowledge_share_entry',
      { entry_id: '00000000-0000-0000-0000-000000000000', target_user_id: target, role: 'viewer' },
      owner,
      ownerSid,
    );
    expect(parseToolError(body)['code']).toBe(ErrorCode.RESOURCE_NOT_FOUND);
  });
});

// ── knowledge_revoke_access ───────────────────────────────────────────────────

describe('knowledge_revoke_access', () => {
  it('owner can revoke a shared user\'s access', async () => {
    const owner = uid('revoke-owner');
    const viewer = uid('revoke-viewer');
    const ownerSid = await openSession(owner);
    const viewerSid = await openSession(viewer);
    const id = await createEntry(owner, ownerSid);

    await callTool(
      'knowledge_share_entry',
      { entry_id: id, target_user_id: viewer, role: 'viewer' },
      owner,
      ownerSid,
    );

    const { status } = await callTool(
      'knowledge_revoke_access',
      { entry_id: id, target_user_id: viewer },
      owner,
      ownerSid,
    );
    expect(status).toBe(200);

    // Viewer can no longer access
    const { body } = await callTool('knowledge_get_entry', { entry_id: id }, viewer, viewerSid);
    expect(parseToolError(body)['code']).toBe(ErrorCode.PERMISSION_DENIED);
  });

  it('revoke own access returns PERMISSION_DENIED with "Cannot revoke owner access"', async () => {
    const owner = uid('revoke-self-owner');
    const ownerSid = await openSession(owner);
    const id = await createEntry(owner, ownerSid);

    const { body } = await callTool(
      'knowledge_revoke_access',
      { entry_id: id, target_user_id: owner },
      owner,
      ownerSid,
    );

    const err = parseToolError(body);
    expect(err['code']).toBe(ErrorCode.PERMISSION_DENIED);
    expect(err['message']).toContain('Cannot revoke owner access');
  });

  it('editor cannot revoke access — returns PERMISSION_DENIED', async () => {
    const owner = uid('revoke-ed-owner');
    const editor = uid('revoke-ed-editor');
    const viewer = uid('revoke-ed-viewer');
    const ownerSid = await openSession(owner);
    const editorSid = await openSession(editor);
    const id = await createEntry(owner, ownerSid);

    await neo4jClient.shareResource(id, editor, 'editor');
    await neo4jClient.shareResource(id, viewer, 'viewer');

    const { body } = await callTool(
      'knowledge_revoke_access',
      { entry_id: id, target_user_id: viewer },
      editor,
      editorSid,
    );
    expect(parseToolError(body)['code']).toBe(ErrorCode.PERMISSION_DENIED);
  });

  it('returns RESOURCE_NOT_FOUND for a non-existent entry', async () => {
    const owner = uid('revoke-missing-owner');
    const target = uid('revoke-missing-target');
    const ownerSid = await openSession(owner);

    const { body } = await callTool(
      'knowledge_revoke_access',
      { entry_id: '00000000-0000-0000-0000-000000000000', target_user_id: target },
      owner,
      ownerSid,
    );
    expect(parseToolError(body)['code']).toBe(ErrorCode.RESOURCE_NOT_FOUND);
  });
});

// ── knowledge_list_access ─────────────────────────────────────────────────────

describe('knowledge_list_access', () => {
  it('returns empty array when no users have been granted access', async () => {
    const owner = uid('list-empty-owner');
    const ownerSid = await openSession(owner);
    const id = await createEntry(owner, ownerSid);

    const { status, body } = await callTool('knowledge_list_access', { entry_id: id }, owner, ownerSid);

    expect(status).toBe(200);
    expect(parseToolSuccess(body)['sharing']).toEqual([]);
  });

  it('returns all HAS_ACCESS entries with user_id, role, granted_at', async () => {
    const owner = uid('list-entries-owner');
    const viewer = uid('list-entries-viewer');
    const editor = uid('list-entries-editor');
    const ownerSid = await openSession(owner);
    const id = await createEntry(owner, ownerSid);

    await callTool(
      'knowledge_share_entry',
      { entry_id: id, target_user_id: viewer, role: 'viewer' },
      owner,
      ownerSid,
    );
    await callTool(
      'knowledge_share_entry',
      { entry_id: id, target_user_id: editor, role: 'editor' },
      owner,
      ownerSid,
    );

    const { body } = await callTool('knowledge_list_access', { entry_id: id }, owner, ownerSid);
    const sharing = parseToolSuccess(body)['sharing'] as Array<Record<string, unknown>>;

    expect(sharing).toHaveLength(2);
    expect(sharing.some((s) => s['user_id'] === viewer && s['role'] === 'viewer')).toBe(true);
    expect(sharing.some((s) => s['user_id'] === editor && s['role'] === 'editor')).toBe(true);
    expect(sharing.every((s) => typeof s['granted_at'] === 'string')).toBe(true);
  });

  it('a viewer can call knowledge_list_access (requires only read)', async () => {
    const owner = uid('list-viewer-owner');
    const viewer = uid('list-viewer-viewer');
    const ownerSid = await openSession(owner);
    const viewerSid = await openSession(viewer);
    const id = await createEntry(owner, ownerSid);

    await callTool(
      'knowledge_share_entry',
      { entry_id: id, target_user_id: viewer, role: 'viewer' },
      owner,
      ownerSid,
    );

    const { status } = await callTool('knowledge_list_access', { entry_id: id }, viewer, viewerSid);
    expect(status).toBe(200);
  });

  it('user with no access cannot list_access — returns PERMISSION_DENIED', async () => {
    const owner = uid('list-denied-owner');
    const stranger = uid('list-denied-stranger');
    const ownerSid = await openSession(owner);
    const strangerSid = await openSession(stranger);
    const id = await createEntry(owner, ownerSid);

    const { body } = await callTool('knowledge_list_access', { entry_id: id }, stranger, strangerSid);
    expect(parseToolError(body)['code']).toBe(ErrorCode.PERMISSION_DENIED);
  });

  it('returns RESOURCE_NOT_FOUND for a non-existent entry', async () => {
    const owner = uid('list-missing-owner');
    const ownerSid = await openSession(owner);

    const { body } = await callTool(
      'knowledge_list_access',
      { entry_id: '00000000-0000-0000-0000-000000000000' },
      owner,
      ownerSid,
    );
    expect(parseToolError(body)['code']).toBe(ErrorCode.RESOURCE_NOT_FOUND);
  });
});

// ── Full sharing workflow ─────────────────────────────────────────────────────

describe('full sharing workflow', () => {
  it('share → list_access → access as viewer → revoke → access denied', async () => {
    const owner = uid('workflow-owner');
    const viewer = uid('workflow-viewer');
    const ownerSid = await openSession(owner);
    const viewerSid = await openSession(viewer);
    const id = await createEntry(owner, ownerSid, 'Workflow Resource');

    // share
    await callTool(
      'knowledge_share_entry',
      { entry_id: id, target_user_id: viewer, role: 'viewer' },
      owner,
      ownerSid,
    );

    // list_access shows the grant
    const { body: lb } = await callTool('knowledge_list_access', { entry_id: id }, owner, ownerSid);
    const sharing = parseToolSuccess(lb)['sharing'] as Array<Record<string, unknown>>;
    expect(sharing.some((s) => s['user_id'] === viewer)).toBe(true);

    // viewer can read
    const { body: gb } = await callTool('knowledge_get_entry', { entry_id: id }, viewer, viewerSid);
    expect(parseToolSuccess(gb)['role']).toBe('viewer');

    // revoke
    await callTool(
      'knowledge_revoke_access',
      { entry_id: id, target_user_id: viewer },
      owner,
      ownerSid,
    );

    // viewer access denied
    const { body: gb2 } = await callTool('knowledge_get_entry', { entry_id: id }, viewer, viewerSid);
    expect(parseToolError(gb2)['code']).toBe(ErrorCode.PERMISSION_DENIED);
  });
});

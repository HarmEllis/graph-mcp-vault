import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
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
import type { Config } from '../src/config.js';

// ── Fixtures ──────────────────────────────────────────────────────────────────

const ISSUER = 'https://oidc.example.com';
const AUDIENCE = 'graph-mcp-vault';
const KID = 'tools-test-key';
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
  // Start Neo4j
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

  // RSA key pair
  const pair = await generateKeyPair('RS256');
  privateKey = pair.privateKey;
  const jwk = await exportJWK(pair.publicKey);
  const jwksDoc = { keys: [{ ...jwk, kid: KID, use: 'sig' }] };

  // Stub fetch globally for the duration of this suite
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => jwksDoc }),
  );

  // Build app
  const sessionStore = new SessionStore();
  const jwksClient = new JwksClient(JWKS_URI, BASE_CONFIG.jwksCacheTtl * 1000);
  const tools = createResourceTools(neo4jClient);
  app = new Hono();
  app.route('/', createMcpRouter(BASE_CONFIG, sessionStore, jwksClient, tools));
}, 120_000);

afterAll(async () => {
  vi.unstubAllGlobals();
  await driver?.close();
  await container?.stop();
});

// ── Helpers ───────────────────────────────────────────────────────────────────

function uniqueUser(label: string): string {
  userCounter += 1;
  return `tools-${label}-${userCounter}`;
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

async function openSession(sub: string, namespace = 'default'): Promise<string> {
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
        meta: { namespace },
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
  const body = (await res.json()) as Record<string, unknown>;
  return { status: res.status, body };
}

// ── create_resource ───────────────────────────────────────────────────────────

describe('create_resource', () => {
  it('returns id and created_at on success', async () => {
    const sub = uniqueUser('create');
    const sid = await openSession(sub);
    const { status, body } = await callTool(
      'create_resource',
      { type: 'note', title: 'Hello', content: 'World' },
      sub,
      sid,
    );

    expect(status).toBe(200);
    const result = body['result'] as Record<string, unknown>;
    expect(typeof result['id']).toBe('string');
    expect(typeof result['created_at']).toBe('string');
  });

  it('uses namespace from args when provided', async () => {
    const sub = uniqueUser('create-ns');
    const sid = await openSession(sub, 'default');
    const { body } = await callTool(
      'create_resource',
      { type: 'note', title: 'NS Test', content: '', namespace: 'custom-ns' },
      sub,
      sid,
    );

    const result = body['result'] as Record<string, unknown>;
    const id = result['id'] as string;

    // verify the resource was stored in the custom namespace
    const resource = await neo4jClient.getResource(id);
    expect(resource?.namespace).toBe('custom-ns');
  });

  it('returns INVALID_PARAMS when required args are missing', async () => {
    const sub = uniqueUser('create-bad');
    const sid = await openSession(sub);
    const { body } = await callTool('create_resource', { type: 'note' }, sub, sid);

    const error = body['error'] as Record<string, unknown>;
    expect(error['code']).toBe(ErrorCode.INVALID_PARAMS);
  });
});

// ── get_resource ──────────────────────────────────────────────────────────────

describe('get_resource', () => {
  it('returns the resource and role "owner" for the creator', async () => {
    const sub = uniqueUser('get-owner');
    const sid = await openSession(sub);
    const { body: createBody } = await callTool(
      'create_resource',
      { type: 'note', title: 'My Resource', content: 'some content' },
      sub,
      sid,
    );
    const id = (createBody['result'] as Record<string, unknown>)['id'] as string;

    const { status, body } = await callTool('get_resource', { resource_id: id }, sub, sid);

    expect(status).toBe(200);
    const result = body['result'] as Record<string, unknown>;
    expect(result['id']).toBe(id);
    expect(result['title']).toBe('My Resource');
    expect(result['content']).toBe('some content');
    expect(result['role']).toBe('owner');
  });

  it('returns RESOURCE_NOT_FOUND for a non-existent id', async () => {
    const sub = uniqueUser('get-missing');
    const sid = await openSession(sub);
    const { body } = await callTool(
      'get_resource',
      { resource_id: '00000000-0000-0000-0000-000000000000' },
      sub,
      sid,
    );

    const error = body['error'] as Record<string, unknown>;
    expect(error['code']).toBe(ErrorCode.RESOURCE_NOT_FOUND);
  });

  it('returns PERMISSION_DENIED when the user has no access', async () => {
    const owner = uniqueUser('get-noac-owner');
    const stranger = uniqueUser('get-noac-stranger');
    const ownerSid = await openSession(owner);
    const strangerSid = await openSession(stranger);

    const { body: cb } = await callTool(
      'create_resource',
      { type: 'note', title: 'Private', content: '' },
      owner,
      ownerSid,
    );
    const id = (cb['result'] as Record<string, unknown>)['id'] as string;

    const { body } = await callTool('get_resource', { resource_id: id }, stranger, strangerSid);
    const error = body['error'] as Record<string, unknown>;
    expect(error['code']).toBe(ErrorCode.PERMISSION_DENIED);
  });
});

// ── list_resources ────────────────────────────────────────────────────────────

describe('list_resources', () => {
  it('returns resources owned by the user', async () => {
    const sub = uniqueUser('list-owner');
    const sid = await openSession(sub);
    await callTool('create_resource', { type: 'note', title: 'R1', content: '' }, sub, sid);
    await callTool('create_resource', { type: 'note', title: 'R2', content: '' }, sub, sid);

    const { status, body } = await callTool('list_resources', {}, sub, sid);

    expect(status).toBe(200);
    const result = body['result'] as Record<string, unknown>;
    const resources = result['resources'] as unknown[];
    expect(resources.length).toBeGreaterThanOrEqual(2);
  });

  it('filters resources by type', async () => {
    const sub = uniqueUser('list-type');
    const sid = await openSession(sub);
    await callTool('create_resource', { type: 'note', title: 'Note', content: '' }, sub, sid);
    await callTool('create_resource', { type: 'task', title: 'Task', content: '' }, sub, sid);

    const { body } = await callTool('list_resources', { type: 'note' }, sub, sid);
    const result = body['result'] as Record<string, unknown>;
    const resources = result['resources'] as Array<Record<string, unknown>>;

    expect(resources.every((r) => r['type'] === 'note')).toBe(true);
  });

  it('respects limit and skip for pagination', async () => {
    const sub = uniqueUser('list-page');
    const sid = await openSession(sub);
    for (let i = 0; i < 5; i++) {
      await callTool(
        'create_resource',
        { type: 'note', title: `Page Item ${i}`, content: '' },
        sub,
        sid,
      );
    }

    const { body: b1 } = await callTool('list_resources', { limit: 2, skip: 0 }, sub, sid);
    const { body: b2 } = await callTool('list_resources', { limit: 2, skip: 2 }, sub, sid);

    const r1 = (b1['result'] as Record<string, unknown>)['resources'] as unknown[];
    const r2 = (b2['result'] as Record<string, unknown>)['resources'] as unknown[];
    expect(r1).toHaveLength(2);
    expect(r2).toHaveLength(2);
  });
});

// ── update_resource ───────────────────────────────────────────────────────────

describe('update_resource', () => {
  it('owner can update title and content', async () => {
    const sub = uniqueUser('update-owner');
    const sid = await openSession(sub);
    const { body: cb } = await callTool(
      'create_resource',
      { type: 'note', title: 'Old', content: 'Old content' },
      sub,
      sid,
    );
    const id = (cb['result'] as Record<string, unknown>)['id'] as string;

    const { status } = await callTool(
      'update_resource',
      { resource_id: id, title: 'New', content: 'New content' },
      sub,
      sid,
    );
    expect(status).toBe(200);

    const { body: gb } = await callTool('get_resource', { resource_id: id }, sub, sid);
    const result = gb['result'] as Record<string, unknown>;
    expect(result['title']).toBe('New');
    expect(result['content']).toBe('New content');
  });

  it('editor can update', async () => {
    const owner = uniqueUser('update-ed-owner');
    const editor = uniqueUser('update-ed-editor');
    const ownerSid = await openSession(owner);
    const editorSid = await openSession(editor);

    const { body: cb } = await callTool(
      'create_resource',
      { type: 'note', title: 'Editable', content: 'v1' },
      owner,
      ownerSid,
    );
    const id = (cb['result'] as Record<string, unknown>)['id'] as string;

    await neo4jClient.shareResource(id, editor, 'editor');

    const { status } = await callTool(
      'update_resource',
      { resource_id: id, title: 'Updated by editor' },
      editor,
      editorSid,
    );
    expect(status).toBe(200);
  });

  it('viewer cannot update — returns PERMISSION_DENIED', async () => {
    const owner = uniqueUser('update-view-owner');
    const viewer = uniqueUser('update-view-viewer');
    const ownerSid = await openSession(owner);
    const viewerSid = await openSession(viewer);

    const { body: cb } = await callTool(
      'create_resource',
      { type: 'note', title: 'Read-only', content: '' },
      owner,
      ownerSid,
    );
    const id = (cb['result'] as Record<string, unknown>)['id'] as string;

    await neo4jClient.shareResource(id, viewer, 'viewer');

    const { body } = await callTool(
      'update_resource',
      { resource_id: id, title: 'Hacked' },
      viewer,
      viewerSid,
    );
    const error = body['error'] as Record<string, unknown>;
    expect(error['code']).toBe(ErrorCode.PERMISSION_DENIED);
  });
});

// ── delete_resource ───────────────────────────────────────────────────────────

describe('delete_resource', () => {
  it('owner can delete — resource is gone afterward', async () => {
    const sub = uniqueUser('delete-owner');
    const sid = await openSession(sub);
    const { body: cb } = await callTool(
      'create_resource',
      { type: 'note', title: 'Deletable', content: '' },
      sub,
      sid,
    );
    const id = (cb['result'] as Record<string, unknown>)['id'] as string;

    const { status } = await callTool('delete_resource', { resource_id: id }, sub, sid);
    expect(status).toBe(200);

    const { body: gb } = await callTool('get_resource', { resource_id: id }, sub, sid);
    const error = gb['error'] as Record<string, unknown>;
    expect(error['code']).toBe(ErrorCode.RESOURCE_NOT_FOUND);
  });

  it('viewer cannot delete — returns PERMISSION_DENIED', async () => {
    const owner = uniqueUser('delete-view-owner');
    const viewer = uniqueUser('delete-view-viewer');
    const ownerSid = await openSession(owner);
    const viewerSid = await openSession(viewer);

    const { body: cb } = await callTool(
      'create_resource',
      { type: 'note', title: 'Protected', content: '' },
      owner,
      ownerSid,
    );
    const id = (cb['result'] as Record<string, unknown>)['id'] as string;
    await neo4jClient.shareResource(id, viewer, 'viewer');

    const { body } = await callTool('delete_resource', { resource_id: id }, viewer, viewerSid);
    const error = body['error'] as Record<string, unknown>;
    expect(error['code']).toBe(ErrorCode.PERMISSION_DENIED);
  });

  it('editor cannot delete — returns PERMISSION_DENIED', async () => {
    const owner = uniqueUser('delete-ed-owner');
    const editor = uniqueUser('delete-ed-editor');
    const ownerSid = await openSession(owner);
    const editorSid = await openSession(editor);

    const { body: cb } = await callTool(
      'create_resource',
      { type: 'note', title: 'Editor Target', content: '' },
      owner,
      ownerSid,
    );
    const id = (cb['result'] as Record<string, unknown>)['id'] as string;
    await neo4jClient.shareResource(id, editor, 'editor');

    const { body } = await callTool('delete_resource', { resource_id: id }, editor, editorSid);
    const error = body['error'] as Record<string, unknown>;
    expect(error['code']).toBe(ErrorCode.PERMISSION_DENIED);
  });

  it('delete removes all sharing relationships', async () => {
    const owner = uniqueUser('delete-rel-owner');
    const viewer = uniqueUser('delete-rel-viewer');
    const ownerSid = await openSession(owner);
    const viewerSid = await openSession(viewer);

    const { body: cb } = await callTool(
      'create_resource',
      { type: 'note', title: 'Shared Then Deleted', content: '' },
      owner,
      ownerSid,
    );
    const id = (cb['result'] as Record<string, unknown>)['id'] as string;
    await neo4jClient.shareResource(id, viewer, 'viewer');

    // delete as owner
    await callTool('delete_resource', { resource_id: id }, owner, ownerSid);

    // viewer can no longer see the resource
    const resource = await neo4jClient.getResource(id);
    expect(resource).toBeNull();
  });
});

// ── Full lifecycle ────────────────────────────────────────────────────────────

describe('full lifecycle', () => {
  it('create → get → list → update → get updated → delete → gone', async () => {
    const sub = uniqueUser('lifecycle');
    const sid = await openSession(sub);

    // create
    const { body: cb } = await callTool(
      'create_resource',
      { type: 'note', title: 'Lifecycle', content: 'v1' },
      sub,
      sid,
    );
    const id = (cb['result'] as Record<string, unknown>)['id'] as string;
    expect(typeof id).toBe('string');

    // get
    const { body: gb1 } = await callTool('get_resource', { resource_id: id }, sub, sid);
    expect((gb1['result'] as Record<string, unknown>)['title']).toBe('Lifecycle');
    expect((gb1['result'] as Record<string, unknown>)['role']).toBe('owner');

    // list — resource appears
    const { body: lb } = await callTool('list_resources', {}, sub, sid);
    const resources = (lb['result'] as Record<string, unknown>)['resources'] as Array<
      Record<string, unknown>
    >;
    expect(resources.some((r) => r['id'] === id)).toBe(true);

    // update
    await callTool('update_resource', { resource_id: id, title: 'Lifecycle v2', content: 'v2' }, sub, sid);

    // get updated
    const { body: gb2 } = await callTool('get_resource', { resource_id: id }, sub, sid);
    expect((gb2['result'] as Record<string, unknown>)['title']).toBe('Lifecycle v2');
    expect((gb2['result'] as Record<string, unknown>)['content']).toBe('v2');

    // delete
    const { status: ds } = await callTool('delete_resource', { resource_id: id }, sub, sid);
    expect(ds).toBe(200);

    // confirm gone
    const { body: gb3 } = await callTool('get_resource', { resource_id: id }, sub, sid);
    expect((gb3['error'] as Record<string, unknown>)['code']).toBe(ErrorCode.RESOURCE_NOT_FOUND);
  });
});

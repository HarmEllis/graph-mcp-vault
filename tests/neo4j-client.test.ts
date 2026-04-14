import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { GenericContainer, Wait, type StartedTestContainer } from 'testcontainers';
import neo4j, { type Driver } from 'neo4j-driver';
import { initSchema } from '../src/schema.js';
import { Neo4jClient } from '../src/neo4j-client.js';

// ── Container setup ───────────────────────────────────────────────────────────

const NEO4J_PASSWORD = 'testpassword';

let container: StartedTestContainer;
let driver: Driver;
let client: Neo4jClient;

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
  client = new Neo4jClient(driver);
}, 120_000);

afterAll(async () => {
  await driver?.close();
  await container?.stop();
});

// ── initSchema ────────────────────────────────────────────────────────────────

describe('initSchema', () => {
  it('creates constraints and indexes without error', async () => {
    await expect(initSchema(driver)).resolves.toBeUndefined();
  });

  it('is idempotent — can be called multiple times without error', async () => {
    await expect(initSchema(driver)).resolves.toBeUndefined();
    await expect(initSchema(driver)).resolves.toBeUndefined();
  });
});

// ── createResource ────────────────────────────────────────────────────────────

describe('Neo4jClient.createResource', () => {
  it('creates a resource and returns id and created_at', async () => {
    const result = await client.createResource({
      userId: 'user-create-a',
      namespace: 'default',
      type: 'note',
      title: 'My Note',
      content: 'Hello world',
    });

    expect(typeof result.id).toBe('string');
    expect(result.id.length).toBeGreaterThan(0);
    expect(typeof result.created_at).toBe('string');
  });
});

// ── getResource ───────────────────────────────────────────────────────────────

describe('Neo4jClient.getResource', () => {
  it('returns the resource for an existing id', async () => {
    const created = await client.createResource({
      userId: 'user-get-b',
      namespace: 'default',
      type: 'note',
      title: 'Fetch Me',
      content: 'Content here',
    });

    const resource = await client.getResource(created.id);

    expect(resource).not.toBeNull();
    expect(resource?.id).toBe(created.id);
    expect(resource?.title).toBe('Fetch Me');
    expect(resource?.content).toBe('Content here');
    expect(resource?.user_id).toBe('user-get-b');
    expect(resource?.namespace).toBe('default');
    expect(resource?.type).toBe('note');
  });

  it('returns null for a non-existent resource id', async () => {
    const result = await client.getResource('00000000-0000-0000-0000-000000000000');
    expect(result).toBeNull();
  });
});

// ── listResources ─────────────────────────────────────────────────────────────

describe('Neo4jClient.listResources', () => {
  it('returns resources owned by the user', async () => {
    const userId = 'user-list-owned';
    await client.createResource({ userId, namespace: 'ns1', type: 'note', title: 'R1', content: '' });
    await client.createResource({ userId, namespace: 'ns1', type: 'note', title: 'R2', content: '' });

    const resources = await client.listResources({ userId, namespace: 'ns1' });

    expect(resources.length).toBeGreaterThanOrEqual(2);
    expect(resources.every((r) => r.user_id === userId)).toBe(true);
    expect(resources.every((r) => r.ownership === 'owner')).toBe(true);
  });

  it('filters resources by namespace', async () => {
    const userId = 'user-ns-filter';
    await client.createResource({ userId, namespace: 'ns-a', type: 'note', title: 'In A', content: '' });
    await client.createResource({ userId, namespace: 'ns-b', type: 'note', title: 'In B', content: '' });

    const resources = await client.listResources({ userId, namespace: 'ns-a' });

    expect(resources.every((r) => r.namespace === 'ns-a')).toBe(true);
    expect(resources.some((r) => r.title === 'In A')).toBe(true);
    expect(resources.some((r) => r.title === 'In B')).toBe(false);
  });

  it('filters resources by type', async () => {
    const userId = 'user-type-filter';
    await client.createResource({ userId, namespace: 'default', type: 'note', title: 'Note', content: '' });
    await client.createResource({ userId, namespace: 'default', type: 'task', title: 'Task', content: '' });

    const notes = await client.listResources({ userId, type: 'note' });

    expect(notes.every((r) => r.type === 'note')).toBe(true);
  });

  it('respects limit and skip for pagination', async () => {
    const userId = 'user-pagination';
    for (let i = 0; i < 5; i++) {
      await client.createResource({ userId, namespace: 'default', type: 'note', title: `Item ${i}`, content: '' });
    }

    const page1 = await client.listResources({ userId, limit: 2, skip: 0 });
    const page2 = await client.listResources({ userId, limit: 2, skip: 2 });

    expect(page1.length).toBe(2);
    expect(page2.length).toBe(2);
    expect(page1[0]?.id).not.toBe(page2[0]?.id);
  });
});

// ── updateResource ────────────────────────────────────────────────────────────

describe('Neo4jClient.updateResource', () => {
  it('updates title and content of an existing resource', async () => {
    const created = await client.createResource({
      userId: 'user-update',
      namespace: 'default',
      type: 'note',
      title: 'Original Title',
      content: 'Original Content',
    });

    await client.updateResource(created.id, { title: 'New Title', content: 'New Content' });

    const updated = await client.getResource(created.id);
    expect(updated?.title).toBe('New Title');
    expect(updated?.content).toBe('New Content');
  });

  it('updates updated_at timestamp on modification', async () => {
    const created = await client.createResource({
      userId: 'user-update-ts',
      namespace: 'default',
      type: 'note',
      title: 'Title',
      content: 'Content',
    });

    const before = await client.getResource(created.id);
    await new Promise((r) => setTimeout(r, 10));
    await client.updateResource(created.id, { title: 'Updated' });
    const after = await client.getResource(created.id);

    expect(after?.updated_at).not.toBe(before?.updated_at);
  });
});

// ── deleteResource ────────────────────────────────────────────────────────────

describe('Neo4jClient.deleteResource', () => {
  it('removes the resource from the database', async () => {
    const created = await client.createResource({
      userId: 'user-delete',
      namespace: 'default',
      type: 'note',
      title: 'To Delete',
      content: '',
    });

    await client.deleteResource(created.id);

    const result = await client.getResource(created.id);
    expect(result).toBeNull();
  });

  it('detaches and deletes all relationships', async () => {
    const ownerId = 'user-delete-rel';
    const viewerId = 'user-delete-rel-viewer';
    const created = await client.createResource({
      userId: ownerId,
      namespace: 'default',
      type: 'note',
      title: 'Has Relations',
      content: '',
    });

    await client.shareResource(created.id, viewerId, 'viewer');
    await client.deleteResource(created.id);

    const result = await client.getResource(created.id);
    expect(result).toBeNull();
  });
});

// ── getEffectiveRole ──────────────────────────────────────────────────────────

describe('Neo4jClient.getEffectiveRole', () => {
  it('returns "owner" for the user who created the resource', async () => {
    const userId = 'user-role-owner';
    const created = await client.createResource({
      userId,
      namespace: 'default',
      type: 'note',
      title: 'Owned',
      content: '',
    });

    const role = await client.getEffectiveRole(userId, created.id);
    expect(role).toBe('owner');
  });

  it('returns null for a user with no relationship to the resource', async () => {
    const created = await client.createResource({
      userId: 'user-role-creator',
      namespace: 'default',
      type: 'note',
      title: 'Not Shared',
      content: '',
    });

    const role = await client.getEffectiveRole('unrelated-user-xyz', created.id);
    expect(role).toBeNull();
  });

  it('returns "viewer" for a user granted viewer access', async () => {
    const ownerId = 'user-role-grantor-viewer';
    const viewerId = 'user-role-viewer';
    const created = await client.createResource({
      userId: ownerId,
      namespace: 'default',
      type: 'note',
      title: 'Viewer Access',
      content: '',
    });

    await client.shareResource(created.id, viewerId, 'viewer');
    const role = await client.getEffectiveRole(viewerId, created.id);
    expect(role).toBe('viewer');
  });

  it('returns "editor" for a user granted editor access', async () => {
    const ownerId = 'user-role-grantor-editor';
    const editorId = 'user-role-editor';
    const created = await client.createResource({
      userId: ownerId,
      namespace: 'default',
      type: 'note',
      title: 'Editor Access',
      content: '',
    });

    await client.shareResource(created.id, editorId, 'editor');
    const role = await client.getEffectiveRole(editorId, created.id);
    expect(role).toBe('editor');
  });
});

// ── shareResource ─────────────────────────────────────────────────────────────

describe('Neo4jClient.shareResource', () => {
  it('creates a HAS_ACCESS relationship with the specified role', async () => {
    const ownerId = 'user-share-owner';
    const targetId = 'user-share-target';
    const created = await client.createResource({
      userId: ownerId,
      namespace: 'default',
      type: 'note',
      title: 'Shareable',
      content: '',
    });

    await client.shareResource(created.id, targetId, 'editor');

    const role = await client.getEffectiveRole(targetId, created.id);
    expect(role).toBe('editor');
  });

  it('is idempotent — sharing the same user twice updates the role', async () => {
    const ownerId = 'user-share-idem-owner';
    const targetId = 'user-share-idem-target';
    const created = await client.createResource({
      userId: ownerId,
      namespace: 'default',
      type: 'note',
      title: 'Idempotent Share',
      content: '',
    });

    await client.shareResource(created.id, targetId, 'viewer');
    await client.shareResource(created.id, targetId, 'editor');

    const role = await client.getEffectiveRole(targetId, created.id);
    expect(role).toBe('editor');
  });

  it('creates the target User node if it does not exist', async () => {
    const ownerId = 'user-share-creates-user';
    const newUserId = 'brand-new-user-' + Date.now();
    const created = await client.createResource({
      userId: ownerId,
      namespace: 'default',
      type: 'note',
      title: 'New User Target',
      content: '',
    });

    await client.shareResource(created.id, newUserId, 'viewer');

    const role = await client.getEffectiveRole(newUserId, created.id);
    expect(role).toBe('viewer');
  });
});

// ── revokeAccess ──────────────────────────────────────────────────────────────

describe('Neo4jClient.revokeAccess', () => {
  it('removes the HAS_ACCESS relationship', async () => {
    const ownerId = 'user-revoke-owner';
    const targetId = 'user-revoke-target';
    const created = await client.createResource({
      userId: ownerId,
      namespace: 'default',
      type: 'note',
      title: 'Revokable',
      content: '',
    });

    await client.shareResource(created.id, targetId, 'viewer');
    await client.revokeAccess(created.id, targetId);

    const role = await client.getEffectiveRole(targetId, created.id);
    expect(role).toBeNull();
  });
});

// ── searchResources ───────────────────────────────────────────────────────────

describe('Neo4jClient.searchResources', () => {
  it('returns resources matching the query keyword', async () => {
    const userId = 'user-search-basic';
    await client.createResource({ userId, namespace: 'default', type: 'note', title: 'Quantum Physics', content: 'Schrodinger equation' });
    await client.createResource({ userId, namespace: 'default', type: 'note', title: 'Cooking Recipe', content: 'how to bake bread' });

    const results = await client.searchResources({ userId, query: 'Quantum' });

    expect(results.some((r) => r.title === 'Quantum Physics')).toBe(true);
    expect(results.every((r) => r.title !== 'Cooking Recipe')).toBe(true);
  });

  it('respects namespace filtering', async () => {
    const userId = 'user-search-ns';
    await client.createResource({ userId, namespace: 'ns-search-a', type: 'note', title: 'Nebula Discovery', content: 'astronomy' });
    await client.createResource({ userId, namespace: 'ns-search-b', type: 'note', title: 'Nebula Notes', content: 'more astronomy' });

    const results = await client.searchResources({ userId, query: 'Nebula', namespace: 'ns-search-a' });

    expect(results.every((r) => r.namespace === 'ns-search-a')).toBe(true);
    expect(results.some((r) => r.title === 'Nebula Discovery')).toBe(true);
    expect(results.some((r) => r.title === 'Nebula Notes')).toBe(false);
  });

  it('only returns resources the user has access to', async () => {
    const ownerId = 'user-search-perm-owner';
    const searcherId = 'user-search-perm-seeker';
    await client.createResource({ userId: ownerId, namespace: 'default', type: 'note', title: 'Classified Photon', content: '' });

    const results = await client.searchResources({ userId: searcherId, query: 'Photon' });

    expect(results.some((r) => r.user_id === ownerId)).toBe(false);
  });

  it('returns shared resources the user has been granted access to', async () => {
    const ownerId = 'user-search-shared-owner';
    const viewerId = 'user-search-shared-viewer';
    const created = await client.createResource({ userId: ownerId, namespace: 'default', type: 'note', title: 'Shared Quasar Content', content: '' });
    await client.shareResource(created.id, viewerId, 'viewer');

    const results = await client.searchResources({ userId: viewerId, query: 'Quasar' });

    expect(results.some((r) => r.id === created.id)).toBe(true);
    expect(results.find((r) => r.id === created.id)?.ownership).toBe('shared');
  });

  it('filters results by type', async () => {
    const userId = 'user-search-type';
    await client.createResource({ userId, namespace: 'default', type: 'note', title: 'Electron Note', content: '' });
    await client.createResource({ userId, namespace: 'default', type: 'task', title: 'Electron Task', content: '' });

    const results = await client.searchResources({ userId, query: 'Electron', type: 'note' });

    expect(results.every((r) => r.type === 'note')).toBe(true);
    expect(results.some((r) => r.title === 'Electron Note')).toBe(true);
  });

  it('respects limit and skip for pagination', async () => {
    const userId = 'user-search-page';
    const tag = `Paginate${Date.now()}`;
    for (let i = 0; i < 4; i++) {
      await client.createResource({ userId, namespace: 'default', type: 'note', title: `${tag} Item ${i}`, content: '' });
    }

    const page1 = await client.searchResources({ userId, query: tag, limit: 2, skip: 0 });
    const page2 = await client.searchResources({ userId, query: tag, limit: 2, skip: 2 });

    expect(page1.length).toBe(2);
    expect(page2.length).toBe(2);
    const ids1 = page1.map((r) => r.id);
    const ids2 = page2.map((r) => r.id);
    expect(ids1.some((id) => ids2.includes(id))).toBe(false);
  });

  it('returns ownership "owner" for resources the caller owns', async () => {
    const userId = 'user-search-ownership-owner';
    const created = await client.createResource({ userId, namespace: 'default', type: 'note', title: 'Ownership Proton', content: '' });

    const results = await client.searchResources({ userId, query: 'Proton' });

    const found = results.find((r) => r.id === created.id);
    expect(found).toBeDefined();
    expect(found?.ownership).toBe('owner');
  });

  it('does not throw and returns an empty array when the query contains Lucene special characters', async () => {
    const userId = 'user-search-lucene-special';

    await expect(
      client.searchResources({ userId, query: '(broken query' }),
    ).resolves.toEqual([]);
  });

  it('does not throw for other Lucene operators: *, :, [, ^, ~', async () => {
    const userId = 'user-search-lucene-ops';

    for (const q of ['*', 'field:value', '[a TO z]', 'term^2', 'fuzzy~']) {
      await expect(
        client.searchResources({ userId, query: q }),
      ).resolves.toBeDefined();
    }
  });
});

// ── listNamespaces ────────────────────────────────────────────────────────────

describe('Neo4jClient.listNamespaces', () => {
  it('converts Neo4j integer counts to JS numbers', async () => {
    const userId = 'user-ns-int-conv';
    await client.createResource({ userId, namespace: 'ns-int', type: 'note', title: 'T', content: '' });

    const result = await client.listNamespaces({ userId });

    const ns = result.find((n) => n.namespace === 'ns-int');
    expect(ns).toBeDefined();
    expect(typeof ns!.owned_count).toBe('number');
    expect(typeof ns!.shared_count).toBe('number');
  });

  it('returns owned and shared counts split correctly', async () => {
    const owner = 'user-ns-owned-split';
    const sharer = 'user-ns-shared-split';
    const r1 = await client.createResource({ userId: owner, namespace: 'ns-split', type: 'note', title: 'Owned', content: '' });
    const r2 = await client.createResource({ userId: sharer, namespace: 'ns-split', type: 'note', title: 'Shared', content: '' });
    await client.shareResource(r2.id, owner, 'viewer');

    const result = await client.listNamespaces({ userId: owner });
    const ns = result.find((n) => n.namespace === 'ns-split');

    expect(ns).toBeDefined();
    expect(ns!.owned_count).toBe(1);
    expect(ns!.shared_count).toBe(1);
  });

  it('counts mixed owned and shared within the same namespace', async () => {
    const owner = 'user-ns-mixed-owner';
    const other = 'user-ns-mixed-other';
    await client.createResource({ userId: owner, namespace: 'ns-mixed', type: 'note', title: 'O1', content: '' });
    await client.createResource({ userId: owner, namespace: 'ns-mixed', type: 'note', title: 'O2', content: '' });
    const shared1 = await client.createResource({ userId: other, namespace: 'ns-mixed', type: 'note', title: 'S1', content: '' });
    const shared2 = await client.createResource({ userId: other, namespace: 'ns-mixed', type: 'note', title: 'S2', content: '' });
    await client.shareResource(shared1.id, owner, 'viewer');
    await client.shareResource(shared2.id, owner, 'editor');

    const result = await client.listNamespaces({ userId: owner });
    const ns = result.find((n) => n.namespace === 'ns-mixed');

    expect(ns).toBeDefined();
    expect(ns!.owned_count).toBe(2);
    expect(ns!.shared_count).toBe(2);
  });

  it('excludes self-shared resources from shared_count', async () => {
    const userId = 'user-ns-selfshare';
    const other = 'user-ns-selfshare-other';
    const r = await client.createResource({ userId, namespace: 'ns-selfshare', type: 'note', title: 'Mine', content: '' });
    // Owner self-shares — should not double-count
    await client.shareResource(r.id, userId, 'editor');

    const result = await client.listNamespaces({ userId });
    const ns = result.find((n) => n.namespace === 'ns-selfshare');

    expect(ns).toBeDefined();
    expect(ns!.owned_count).toBe(1);
    expect(ns!.shared_count).toBe(0);
  });

  it('returns namespaces in alphabetical order', async () => {
    const userId = 'user-ns-alpha';
    await client.createResource({ userId, namespace: 'zz-last', type: 'note', title: 'Z', content: '' });
    await client.createResource({ userId, namespace: 'aa-first', type: 'note', title: 'A', content: '' });
    await client.createResource({ userId, namespace: 'mm-mid', type: 'note', title: 'M', content: '' });

    const result = await client.listNamespaces({ userId });
    const ownedNamespaces = result.filter((n) =>
      ['zz-last', 'aa-first', 'mm-mid'].includes(n.namespace),
    );

    expect(ownedNamespaces.map((n) => n.namespace)).toEqual(['aa-first', 'mm-mid', 'zz-last']);
  });
});

// ── listSharing ───────────────────────────────────────────────────────────────

describe('Neo4jClient.listSharing', () => {
  it('returns all users granted HAS_ACCESS to the resource', async () => {
    const ownerId = 'user-list-sharing-owner';
    const viewer1 = 'user-list-sharing-v1';
    const editor1 = 'user-list-sharing-e1';
    const created = await client.createResource({
      userId: ownerId,
      namespace: 'default',
      type: 'note',
      title: 'Shared With Many',
      content: '',
    });

    await client.shareResource(created.id, viewer1, 'viewer');
    await client.shareResource(created.id, editor1, 'editor');

    const sharing = await client.listSharing(created.id);

    expect(sharing).toHaveLength(2);
    expect(sharing.some((s) => s.user_id === viewer1 && s.role === 'viewer')).toBe(true);
    expect(sharing.some((s) => s.user_id === editor1 && s.role === 'editor')).toBe(true);
    expect(sharing.every((s) => typeof s.granted_at === 'string')).toBe(true);
  });

  it('returns an empty array when no users have been granted access', async () => {
    const created = await client.createResource({
      userId: 'user-no-sharing',
      namespace: 'default',
      type: 'note',
      title: 'Private',
      content: '',
    });

    const sharing = await client.listSharing(created.id);
    expect(sharing).toHaveLength(0);
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SessionStore } from "../src/session.js";

// ── Helpers ───────────────────────────────────────────────────────────────────

/** A store with an effectively infinite TTL for tests that don't need expiry. */
function freshStore(): SessionStore {
  return new SessionStore(24 * 60 * 60 * 1000);
}

afterEach(() => {
  vi.useRealTimers();
});

// ── create ────────────────────────────────────────────────────────────────────

describe("SessionStore.create", () => {
  it("returns a non-empty UUID-shaped string", () => {
    const store = freshStore();
    const id = store.create("user-a", "default");

    expect(typeof id).toBe("string");
    expect(id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
  });

  it("returns a unique ID on each call", () => {
    const store = freshStore();
    const ids = new Set(
      Array.from({ length: 10 }, () => store.create("user-a", "default")),
    );
    expect(ids.size).toBe(10);
  });

  it("stores the userId and namespace on the session", () => {
    const store = freshStore();
    const id = store.create("user-xyz", "workspace-1");
    const session = store.get(id);

    expect(session?.userId).toBe("user-xyz");
    expect(session?.namespace).toBe("workspace-1");
  });

  it("defaults readonly and lockedNamespace to false when flags are omitted", () => {
    const store = freshStore();
    const id = store.create("user-a", "default");
    const session = store.get(id);
    expect(session?.readonly).toBe(false);
    expect(session?.lockedNamespace).toBe(false);
  });

  it("stores readonly and lockedNamespace flags when provided", () => {
    const store = freshStore();
    const id = store.create("user-a", "default", {
      readonly: true,
      lockedNamespace: true,
    });
    const session = store.get(id);
    expect(session?.readonly).toBe(true);
    expect(session?.lockedNamespace).toBe(true);
  });

  it("allows partial flags (only readonly)", () => {
    const store = freshStore();
    const id = store.create("user-a", "default", { readonly: true });
    const session = store.get(id);
    expect(session?.readonly).toBe(true);
    expect(session?.lockedNamespace).toBe(false);
  });
});

// ── get ───────────────────────────────────────────────────────────────────────

describe("SessionStore.get", () => {
  it("returns the session for a valid, non-expired id", () => {
    const store = freshStore();
    const id = store.create("user-a", "ns");
    expect(store.get(id)).not.toBeNull();
  });

  it("returns null for an unknown session id", () => {
    const store = freshStore();
    expect(store.get("00000000-0000-0000-0000-000000000000")).toBeNull();
  });

  it("returns null for an expired session", async () => {
    const store = new SessionStore(1); // 1 ms TTL
    const id = store.create("user-ttl", "ns");

    await new Promise((r) => setTimeout(r, 20));

    expect(store.get(id)).toBeNull();
  });

  it("removes the session from storage when it is found to be expired", async () => {
    const store = new SessionStore(1);
    const id = store.create("user-clean", "ns");

    await new Promise((r) => setTimeout(r, 20));
    store.get(id); // triggers lazy eviction

    expect(store.size()).toBe(0);
  });

  it("refreshes lastActiveAt on every successful get", () => {
    // Use fake time to avoid CI jitter around short TTL windows.
    vi.useFakeTimers();
    const store = new SessionStore(60);
    const id = store.create("user-refresh", "ns");

    vi.advanceTimersByTime(40);
    expect(store.get(id)).not.toBeNull(); // resets TTL

    vi.advanceTimersByTime(40);
    expect(store.get(id)).not.toBeNull(); // still alive thanks to refresh
  });

  it("returns the same id that was used to look it up", () => {
    const store = freshStore();
    const id = store.create("user-a", "ns");
    const session = store.get(id);

    expect(session?.id).toBe(id);
  });
});

// ── delete ────────────────────────────────────────────────────────────────────

describe("SessionStore.delete", () => {
  it("removes the session so subsequent get returns null", () => {
    const store = freshStore();
    const id = store.create("user-del", "ns");

    store.delete(id);

    expect(store.get(id)).toBeNull();
  });

  it("is a no-op for an unknown id", () => {
    const store = freshStore();
    expect(() => store.delete("no-such-id")).not.toThrow();
  });

  it("decrements the stored session count", () => {
    const store = freshStore();
    const id = store.create("user-a", "ns");
    expect(store.size()).toBe(1);

    store.delete(id);
    expect(store.size()).toBe(0);
  });
});

// ── size ──────────────────────────────────────────────────────────────────────

describe("SessionStore.size", () => {
  it("reflects the number of currently stored sessions", () => {
    const store = freshStore();
    expect(store.size()).toBe(0);

    store.create("u1", "ns");
    expect(store.size()).toBe(1);

    store.create("u2", "ns");
    expect(store.size()).toBe(2);
  });
});

// ── purgeExpired ──────────────────────────────────────────────────────────────

describe("SessionStore.purgeExpired", () => {
  it("removes only expired sessions and leaves active ones", async () => {
    const store = new SessionStore(30); // 30 ms TTL

    store.create("user-old", "ns"); // will expire
    await new Promise((r) => setTimeout(r, 50));
    store.create("user-new", "ns"); // still fresh

    store.purgeExpired();

    expect(store.size()).toBe(1);
  });

  it("is a no-op when there are no expired sessions", () => {
    const store = freshStore();
    store.create("u", "ns");

    expect(() => store.purgeExpired()).not.toThrow();
    expect(store.size()).toBe(1);
  });

  it("removes all sessions when all are expired", async () => {
    const store = new SessionStore(1);
    store.create("u1", "ns");
    store.create("u2", "ns");

    await new Promise((r) => setTimeout(r, 20));
    store.purgeExpired();

    expect(store.size()).toBe(0);
  });
});

// ── cleanup timer ─────────────────────────────────────────────────────────────

describe("SessionStore cleanup timer", () => {
  it("startCleanup and stopCleanup do not throw", () => {
    const store = new SessionStore(24 * 60 * 60 * 1000, 1000);
    expect(() => store.startCleanup()).not.toThrow();
    expect(() => store.stopCleanup()).not.toThrow();
  });

  it("stopCleanup is a no-op when the timer has not been started", () => {
    const store = freshStore();
    expect(() => store.stopCleanup()).not.toThrow();
  });

  it("stopCleanup is safe to call multiple times", () => {
    const store = new SessionStore(24 * 60 * 60 * 1000, 1000);
    store.startCleanup();
    store.stopCleanup();
    expect(() => store.stopCleanup()).not.toThrow();
  });

  it("automatically purges expired sessions when the cleanup fires", async () => {
    vi.useFakeTimers();

    const store = new SessionStore(1, 100); // 1 ms TTL, 100 ms cleanup interval
    store.startCleanup();

    // Advance time so the session is expired
    vi.advanceTimersByTime(50);
    store.create("u", "ns");
    vi.advanceTimersByTime(200); // fires the cleanup interval at least once

    store.stopCleanup();
    vi.useRealTimers();

    // All sessions were expired at cleanup time
    expect(store.size()).toBe(0);
  });
});

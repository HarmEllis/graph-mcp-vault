import { randomUUID } from 'node:crypto';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface Session {
  id: string;
  userId: string;
  namespace: string;
  createdAt: number;
  lastActiveAt: number;
}

// ── SessionStore ──────────────────────────────────────────────────────────────

/**
 * Single-process, in-memory session store with inactivity-based TTL expiry.
 *
 * - Sessions expire after `ttlMs` milliseconds of inactivity.
 * - A background cleanup timer (started via `startCleanup`) sweeps and removes
 *   expired sessions on a configurable interval.
 * - Expiry is also evaluated lazily on every `get` call.
 *
 * Deployment note: single-process only — see DECISIONS.md.
 */
export class SessionStore {
  private readonly sessions = new Map<string, Session>();
  private cleanupTimer: ReturnType<typeof setInterval> | null = null;

  /**
   * @param ttlMs            Inactivity TTL in milliseconds. Default: 24 h.
   * @param cleanupIntervalMs Interval between background sweeps. Default: 1 h.
   */
  constructor(
    private readonly ttlMs: number = 24 * 60 * 60 * 1000,
    private readonly cleanupIntervalMs: number = 60 * 60 * 1000,
  ) {}

  // ── Public API ───────────────────────────────────────────────────────────────

  /**
   * Creates a new session for the given user and namespace.
   * Returns the UUID4 session ID.
   */
  create(userId: string, namespace: string): string {
    const id = randomUUID();
    const now = Date.now();
    this.sessions.set(id, { id, userId, namespace, createdAt: now, lastActiveAt: now });
    return id;
  }

  /**
   * Returns the session for the given ID, or null if it does not exist or has
   * expired. On a successful lookup, `lastActiveAt` is refreshed (inactivity
   * TTL reset). Expired sessions are lazily evicted on access.
   */
  get(sessionId: string): Session | null {
    const session = this.sessions.get(sessionId);
    if (!session) return null;

    if (Date.now() - session.lastActiveAt > this.ttlMs) {
      this.sessions.delete(sessionId);
      return null;
    }

    session.lastActiveAt = Date.now();
    return session;
  }

  /** Removes a session unconditionally. No-op for unknown IDs. */
  delete(sessionId: string): void {
    this.sessions.delete(sessionId);
  }

  /** Returns the number of currently stored sessions (including expired ones not yet swept). */
  size(): number {
    return this.sessions.size;
  }

  /**
   * Sweeps all sessions and removes any that have exceeded the inactivity TTL.
   * Called automatically by the background timer; can also be called directly.
   */
  purgeExpired(): void {
    const now = Date.now();
    for (const [id, session] of this.sessions) {
      if (now - session.lastActiveAt > this.ttlMs) {
        this.sessions.delete(id);
      }
    }
  }

  /**
   * Starts the background cleanup timer.
   * The timer is unreffed so it does not prevent the Node.js process from
   * exiting when no other work is pending.
   * Calling this more than once is safe — the previous timer is replaced.
   */
  startCleanup(): void {
    this.stopCleanup();
    const timer = setInterval(() => this.purgeExpired(), this.cleanupIntervalMs);
    // Allow the process to exit even if the timer is still running.
    if (typeof timer.unref === 'function') timer.unref();
    this.cleanupTimer = timer;
  }

  /** Stops the background cleanup timer. Safe to call when never started. */
  stopCleanup(): void {
    if (this.cleanupTimer !== null) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
  }
}

import { randomBytes } from 'node:crypto';
import type { Session } from '../domain/models.js';
import type { MemoryStore } from '../store/memory-store.js';

export function createSessionService(store: MemoryStore, options: { ttlMs?: number } = {}) {
  const ttlMs = options.ttlMs ?? 86_400_000;
  if (!Number.isSafeInteger(ttlMs) || ttlMs <= 0) throw new Error('Invalid session lifetime');

  const revocationListeners = new Set<(session: Session) => void>();
  function onRevoke(listener: (session: Session) => void): () => void {
    revocationListeners.add(listener);
    return () => {
      revocationListeners.delete(listener);
    };
  }

  function create(userId: string): Session {
    if (store.users.get(userId)?.kind !== 'USER') throw new Error('Session requires a human user');
    const createdAt = store.now();
    const session: Session = {
      id: randomBytes(32).toString('hex'),
      userId,
      createdAt,
      expiresAt: createdAt + ttlMs,
    };
    store.sessions.set(session.id, session);
    return session;
  }
  function revoke(id: string | undefined): void {
    if (!id) return;
    const session = store.sessions.get(id);
    if (!session) return;
    store.sessions.delete(id);
    for (const listener of revocationListeners) {
      try {
        listener(session);
      } catch {
        // Revocation is already committed; an observer cannot restore a session or fail logout.
      }
    }
  }
  function resolve(id: string | undefined): Session | null {
    if (!id) return null;
    const session = store.sessions.get(id);
    if (!session) return null;
    if (session.expiresAt <= store.now() || store.users.get(session.userId)?.kind !== 'USER') {
      revoke(id);
      return null;
    }
    return session;
  }
  function pruneExpired(): number {
    let removed = 0;
    for (const id of store.sessions.keys()) {
      if (!resolve(id)) removed++;
    }
    return removed;
  }
  return { create, resolve, revoke, pruneExpired, onRevoke };
}
export type SessionService = ReturnType<typeof createSessionService>;

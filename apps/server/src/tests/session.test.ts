import { describe, expect, it, vi } from 'vitest';
import { createMemoryStore } from '../store/memory-store.js';
import { createSessionService } from '../services/session.service.js';
import { SYSTEM_USER_ID } from '../store/seed.js';

function setup() {
  const clock = { now: 1_700_000_000_000 };
  const store = createMemoryStore({ now: () => clock.now });
  store.users.set('user-a', {
    id: 'user-a',
    username: 'alice',
    kind: 'USER',
    passwordHash: 'test',
    passwordSalt: 'test',
    createdAt: new Date(clock.now).toISOString(),
  });
  const sessions = createSessionService(store, { ttlMs: 1_000 });
  return { clock, store, sessions };
}

describe('in-memory sessions', () => {
  it('issues unpredictable, unique tokens and resolves the owning user', () => {
    const { sessions } = setup();
    const a = sessions.create('user-a');
    const b = sessions.create('user-a');
    expect(a.id).toMatch(/^[a-f0-9]{64}$/);
    expect(a.id).not.toBe(b.id);
    expect(sessions.resolve(a.id)?.userId).toBe('user-a');
    expect(a.expiresAt).toBe(1_700_000_001_000);
  });

  it('expires exactly at the deadline and removes the expired session', () => {
    const { sessions, clock, store } = setup();
    const session = sessions.create('user-a');
    clock.now += 999;
    expect(sessions.resolve(session.id)).not.toBeNull();
    clock.now += 1;
    expect(sessions.resolve(session.id)).toBeNull();
    expect(store.sessions.has(session.id)).toBe(false);
  });

  it('revokes only the specified session and is safe to repeat', () => {
    const { sessions } = setup();
    const a = sessions.create('user-a');
    const b = sessions.create('user-a');
    sessions.revoke(a.id);
    sessions.revoke(a.id);
    expect(sessions.resolve(a.id)).toBeNull();
    expect(sessions.resolve(b.id)).not.toBeNull();
  });

  it('prunes expired sessions while keeping newer sessions', () => {
    const { sessions, clock, store } = setup();
    const a = sessions.create('user-a');
    clock.now += 500;
    const b = sessions.create('user-a');
    clock.now += 500;
    expect(sessions.pruneExpired()).toBe(1);
    expect(store.sessions.has(a.id)).toBe(false);
    expect(sessions.resolve(b.id)).not.toBeNull();
  });

  it('rejects unknown tokens and users removed from the store', () => {
    const { sessions, store } = setup();
    expect(sessions.resolve('forged')).toBeNull();
    expect(sessions.resolve(undefined)).toBeNull();
    const session = sessions.create('user-a');
    store.users.delete('user-a');
    expect(sessions.resolve(session.id)).toBeNull();
    expect(store.sessions.has(session.id)).toBe(false);
  });

  it('cannot create a session for a system account or missing user', () => {
    const { sessions } = setup();
    expect(() => sessions.create(SYSTEM_USER_ID)).toThrow();
    expect(() => sessions.create('missing')).toThrow();
  });
});

it('notifies revocation observers exactly once, supports unsubscribe and isolates failed observers', () => {
  const { sessions, clock } = setup();
  const listener = vi.fn();
  sessions.onRevoke(() => {
    throw new Error('failed observer');
  });
  const unsubscribe = sessions.onRevoke(listener);
  const first = sessions.create('user-a');
  sessions.revoke(first.id);
  sessions.revoke(first.id);
  expect(listener).toHaveBeenCalledExactlyOnceWith(first);
  const expired = sessions.create('user-a');
  clock.now += 1000;
  expect(sessions.resolve(expired.id)).toBeNull();
  expect(listener).toHaveBeenLastCalledWith(expired);
  unsubscribe();
  sessions.revoke(sessions.create('user-a').id);
  expect(listener).toHaveBeenCalledTimes(2);
});

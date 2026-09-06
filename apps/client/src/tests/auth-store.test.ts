// @vitest-environment jsdom
import { createPinia, disposePinia, setActivePinia } from 'pinia';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises } from '@vue/test-utils';
import { useAuthStore } from '../stores/auth.js';

let pinia: ReturnType<typeof createPinia>;
let fetchMock: ReturnType<typeof vi.fn>;
const user = { id: 'user-alice', username: 'alice' };
const state = () => ({
  userId: user.id,
  serverEpoch: 'epoch-a',
  accountVersion: 0,
  account: { cashBalanceCents: 100_000_000, frozenCashCents: 0, availableCashCents: 100_000_000 },
  positions: [],
  activeOrders: [],
  recentClosedOrders: [],
  recentTrades: [],
});
const identity = () => ({
  user,
  serverEpoch: 'epoch-a',
  expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
});
const ok = (data: unknown) => new Response(JSON.stringify({ data }), { status: 200 });
const unauthorized = () =>
  new Response(
    JSON.stringify({
      error: { code: 'UNAUTHENTICATED', message: '请先登录' },
      requestId: 'test',
    }),
    { status: 401 },
  );

function mockAuthenticated() {
  fetchMock.mockImplementation(async (path: string) => {
    if (path === '/api/me/snapshot') return ok(state());
    if (path === '/api/stocks') return ok({ serverEpoch: 'epoch-a', marketVersion: 0, quotes: [] });
    if (path === '/api/auth/logout') return new Response(null, { status: 204 });
    return ok(identity());
  });
}
beforeEach(() => {
  pinia = createPinia();
  setActivePinia(pinia);
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => {
  disposePinia(pinia);
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('client identity state', () => {
  it('restores the user and account from the server after a page reload', async () => {
    mockAuthenticated();
    const auth = useAuthStore();
    await auth.restoreSession();
    expect(auth.user).toEqual(user);
    expect(auth.account?.account.availableCashCents).toBe(100_000_000);
    expect(auth.initialized).toBe(true);
    expect(localStorage.length).toBe(0);
    expect(sessionStorage.length).toBe(0);
  });

  it('deduplicates concurrent startup checks', async () => {
    mockAuthenticated();
    const auth = useAuthStore();
    await Promise.all([auth.ensureSession(), auth.ensureSession()]);
    expect(fetchMock.mock.calls.filter(([path]) => path === '/api/auth/me')).toHaveLength(1);
  });

  it.each(['login', 'register'] as const)(
    'uses %s and fetches the resulting private state',
    async (action) => {
      mockAuthenticated();
      const auth = useAuthStore();
      await auth[action]({ username: 'alice', password: 'password123' });
      expect(auth.user).toEqual(user);
      const call = fetchMock.mock.calls.find(([path]) => path === '/api/auth/' + action)!;
      expect(call[1].method).toBe('POST');
      expect(call[1].credentials).toBe('same-origin');
      expect(JSON.parse(call[1].body)).toEqual({ username: 'alice', password: 'password123' });
    },
  );

  it('clears all private state on an expired or invalid session', async () => {
    mockAuthenticated();
    const auth = useAuthStore();
    await auth.restoreSession();
    fetchMock.mockResolvedValue(unauthorized());
    await auth.restoreSession();
    expect(auth.user).toBeNull();
    expect(auth.account).toBeNull();
    expect(auth.quotes).toEqual([]);
    expect(auth.serverEpoch).toBeNull();
  });

  it('clears state on confirmed logout, without treating a failed logout as successful', async () => {
    mockAuthenticated();
    const auth = useAuthStore();
    await auth.restoreSession();
    fetchMock.mockRejectedValueOnce(new TypeError('network'));
    await expect(auth.logout()).rejects.toThrow();
    expect(auth.user).toEqual(user);
    mockAuthenticated();
    await auth.logout();
    expect(auth.user).toBeNull();
    expect(auth.account).toBeNull();
  });

  it('treats already-expired logout as logged out', async () => {
    mockAuthenticated();
    const auth = useAuthStore();
    await auth.restoreSession();
    fetchMock.mockResolvedValueOnce(unauthorized());
    await auth.logout();
    expect(auth.user).toBeNull();
  });

  it('does not overwrite logout with a late in-flight session response', async () => {
    let resolveIdentity!: (value: Response) => void;
    mockAuthenticated();
    const auth = useAuthStore();
    fetchMock.mockImplementationOnce(
      () =>
        new Promise<Response>((resolve) => {
          resolveIdentity = resolve;
        }),
    );
    const restore = auth.restoreSession();
    await auth.logout();
    resolveIdentity(ok(identity()));
    await restore;
    expect(auth.user).toBeNull();
    expect(auth.account).toBeNull();
  });

  it.each(['epoch', 'user'])(
    'rejects a mixed %s snapshot without showing private data',
    async (mismatch) => {
      mockAuthenticated();
      fetchMock.mockImplementation(async (path: string) => {
        if (path === '/api/me/snapshot')
          return ok({
            ...state(),
            ...(mismatch === 'epoch' ? { serverEpoch: 'epoch-b' } : { userId: 'user-bravo' }),
          });
        if (path === '/api/stocks')
          return ok({ serverEpoch: 'epoch-a', marketVersion: 0, quotes: [] });
        return ok(identity());
      });
      const auth = useAuthStore();
      await auth.restoreSession();
      expect(auth.user).toBeNull();
      expect(auth.account).toBeNull();
      expect(auth.error).toBeTruthy();
    },
  );

  it('clears the session at its known expiry time', async () => {
    vi.useFakeTimers();
    mockAuthenticated();
    fetchMock.mockImplementationOnce(async () =>
      ok({
        ...identity(),
        expiresAt: new Date(Date.now() + 1_000).toISOString(),
      }),
    );
    const auth = useAuthStore();
    await auth.restoreSession();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(auth.user).toBeNull();
    expect(auth.account).toBeNull();
    expect(auth.error).toContain('过期');
  });

  it('reports connection failures without fabricating an authenticated state', async () => {
    fetchMock.mockRejectedValue(new TypeError('network'));
    const auth = useAuthStore();
    await auth.restoreSession();
    expect(auth.user).toBeNull();
    expect(auth.error).toBeTruthy();
  });
});

describe('exclusive session changes', () => {
  const credentials = { username: 'alice', password: 'password123' };
  const actions = ['login', 'register', 'logout'] as const;
  const pairs = actions.flatMap((first) => actions.map((second) => [first, second] as const));
  it.each(pairs)(
    'blocks %s followed by %s until the first operation settles',
    async (first, second) => {
      mockAuthenticated();
      const auth = useAuthStore();
      let complete!: (value: Response) => void;
      fetchMock.mockImplementationOnce(
        () =>
          new Promise<Response>((resolve) => {
            complete = resolve;
          }),
      );
      const pending = auth[first](credentials);
      const rejected = await auth[second](credentials).then(
        () => null,
        (cause: unknown) => cause,
      );
      const busyBeforeCompletion = auth.busy;
      complete(first === 'logout' ? new Response(null, { status: 204 }) : ok(identity()));
      await pending;
      expect(rejected).toBeInstanceOf(Error);
      expect(busyBeforeCompletion).toBe(true);
      expect(fetchMock.mock.calls.filter(([, options]) => options.method === 'POST')).toHaveLength(
        1,
      );
      expect(auth.busy).toBe(false);
      expect(auth.user).toEqual(first === 'logout' ? null : user);
      expect(auth.account?.userId ?? null).toBe(first === 'logout' ? null : user.id);
    },
  );

  it('keeps the session exclusive until its private snapshot has loaded', async () => {
    mockAuthenticated();
    const auth = useAuthStore();
    let complete!: (value: Response) => void;
    let arrived!: () => void;
    const snapshotStarted = new Promise<void>((resolve) => {
      arrived = resolve;
    });
    fetchMock.mockImplementation(async (path: string) => {
      if (path === '/api/me/snapshot')
        return new Promise<Response>((resolve) => {
          complete = resolve;
          arrived();
        });
      if (path === '/api/stocks')
        return ok({ serverEpoch: 'epoch-a', marketVersion: 0, quotes: [] });
      return ok(identity());
    });
    const pending = auth.login(credentials);
    await snapshotStarted;
    const rejected = await auth.logout().then(
      () => null,
      (cause: unknown) => cause,
    );
    complete(ok(state()));
    await pending;
    expect(rejected).toBeInstanceOf(Error);
    expect(fetchMock.mock.calls.some(([path]) => path === '/api/auth/logout')).toBe(false);
    expect(auth.user).toEqual(user);
  });

  it('waits for an active login before restoring identity without another request', async () => {
    mockAuthenticated();
    const auth = useAuthStore();
    let complete!: (value: Response) => void;
    let arrived!: () => void;
    const loginStarted = new Promise<void>((resolve) => {
      arrived = resolve;
    });
    fetchMock.mockImplementationOnce(
      () =>
        new Promise<Response>((resolve) => {
          complete = resolve;
          arrived();
        }),
    );
    const pending = auth.login(credentials);
    await loginStarted;
    const restore = auth.restoreSession();
    const identityReads = fetchMock.mock.calls.filter(([path]) => path === '/api/auth/me').length;
    complete(ok(identity()));
    await Promise.all([pending, restore]);
    expect(identityReads).toBe(0);
    expect(auth.user).toEqual(user);
    expect(auth.account?.userId).toBe(user.id);
  });

  it('releases the operation after failure so credentials can be corrected', async () => {
    mockAuthenticated();
    const auth = useAuthStore();
    fetchMock.mockRejectedValueOnce(new TypeError('network'));
    await expect(auth.login(credentials)).rejects.toThrow();
    expect(auth.busy).toBe(false);
    await auth.login(credentials);
    expect(auth.user).toEqual(user);
    expect(auth.busy).toBe(false);
  });

  it('releases a pending logout even if the known session expires meanwhile', async () => {
    vi.useFakeTimers();
    mockAuthenticated();
    const auth = useAuthStore();
    fetchMock.mockResolvedValueOnce(
      ok({ ...identity(), expiresAt: new Date(Date.now() + 1_000).toISOString() }),
    );
    await auth.restoreSession();
    let complete!: (value: Response) => void;
    fetchMock.mockImplementationOnce(
      () =>
        new Promise<Response>((resolve) => {
          complete = resolve;
        }),
    );
    const pending = auth.logout();
    await vi.advanceTimersByTimeAsync(1_000);
    complete(new Response(null, { status: 204 }));
    await pending;
    expect(auth.user).toBeNull();
    expect(auth.busy).toBe(false);
    await auth.login(credentials);
    expect(auth.user).toEqual(user);
  });
});

it('keeps authentication exclusive until both private reads finish even when one fails', async () => {
  mockAuthenticated();
  const auth = useAuthStore();
  let completeMarket!: (value: Response) => void;
  let arrived!: () => void;
  const marketStarted = new Promise<void>((resolve) => {
    arrived = resolve;
  });
  fetchMock
    .mockResolvedValueOnce(ok(identity()))
    .mockRejectedValueOnce(new TypeError('snapshot unavailable'))
    .mockImplementationOnce(
      () =>
        new Promise<Response>((resolve) => {
          completeMarket = resolve;
          arrived();
        }),
    );
  const first = auth
    .login({ username: 'alice', password: 'password123' })
    .catch((cause: unknown) => cause);
  await marketStarted;
  await flushPromises();
  const busyAfterFailure = auth.busy;
  const blocked = await auth.register({ username: 'bravo', password: 'password123' }).then(
    () => null,
    (cause: unknown) => cause,
  );
  completeMarket(ok({ serverEpoch: 'epoch-a', marketVersion: 0, quotes: [] }));
  const failure = await first;
  expect(busyAfterFailure).toBe(true);
  expect(blocked).toBeInstanceOf(Error);
  expect(failure).toBeInstanceOf(Error);
  expect(auth.busy).toBe(false);
  expect(auth.user).toBeNull();
  await auth.login({ username: 'alice', password: 'password123' });
  expect(auth.user).toEqual(user);
});

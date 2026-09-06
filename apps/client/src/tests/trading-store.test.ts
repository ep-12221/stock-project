import { createPinia, disposePinia, setActivePinia } from 'pinia';
import { flushPromises } from '@vue/test-utils';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { useTradingStore } from '../stores/trading.js';
import { useMarketStore } from '../stores/market.js';
import { authenticated, failure, input, ok, order, quote, snapshot } from './trading-fixture.js';
import { installOrderStorage } from './pending-fixture.js';
let pinia: ReturnType<typeof createPinia>;
let fetchMock: ReturnType<typeof vi.fn>;
beforeEach(() => {
  installOrderStorage();
  pinia = createPinia();
  setActivePinia(pinia);
  authenticated();
  fetchMock = vi.fn(async (url: string) => {
    if (url === '/api/auth/me')
      return ok({
        user: { id: 'alice', username: 'alice' },
        serverEpoch: 'epoch',
        expiresAt: new Date(Date.now() + 60000).toISOString(),
      });
    if (url === '/api/me/snapshot') return ok(snapshot(3));
    if (url === '/api/stocks')
      return ok({ serverEpoch: 'epoch', marketVersion: 3, quotes: [quote()] });
    return ok({
      userId: 'alice',
      serverEpoch: 'epoch',
      accountVersion: 3,
      marketVersion: 3,
      items: [],
      nextCursor: null,
    });
  });
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => {
  disposePinia(pinia);
  vi.unstubAllGlobals();
});
it('sends only business fields plus an idempotency key and waits for the server before changing money', async () => {
  const auth = authenticated();
  const store = useTradingStore();
  let finish!: (r: Response) => void;
  fetchMock.mockImplementationOnce(
    () =>
      new Promise<Response>((resolve) => {
        finish = resolve;
      }),
  );
  const pending = store.submit(input);
  await flushPromises();
  expect(auth.account).toEqual(snapshot());
  expect(store.submitting).toBe(true);
  const next = snapshot(2);
  next.account.availableCashCents = 99899900;
  next.account.cashBalanceCents = 99899900;
  finish(ok({ order: { ...order(), status: 'FILLED', filledQuantity: 100 }, snapshot: next }));
  expect(await pending).toBe(true);
  expect(auth.account).toEqual(next);
  expect(JSON.parse(fetchMock.mock.calls[0]![1].body)).toEqual({
    ...input,
    clientOrderId: expect.any(String),
  });
  expect(store.notice).toContain('全部成交');
});
it.each([
  ['OPEN', '已挂单'],
  ['PARTIALLY_FILLED', '部分成交'],
  ['FILLED', '全部成交'],
] as const)('reports %s accurately', async (status, message) => {
  fetchMock.mockResolvedValueOnce(ok({ order: { ...order(), status }, snapshot: snapshot(2) }));
  const store = useTradingStore();
  expect(await store.submit(input)).toBe(true);
  expect(store.notice).toContain(message);
});
it('blocks duplicate submissions without retrying the POST', async () => {
  let finish!: (r: Response) => void;
  fetchMock.mockImplementationOnce(
    () =>
      new Promise<Response>((resolve) => {
        finish = resolve;
      }),
  );
  const store = useTradingStore();
  const first = store.submit(input);
  await flushPromises();
  expect(await store.submit(input)).toBe(false);
  finish(ok({ order: order(), snapshot: snapshot(2) }));
  await first;
  expect(fetchMock.mock.calls.filter(([, options]) => options?.method === 'POST')).toHaveLength(1);
});
it('refreshes the account after a balance rejection and keeps its reason', async () => {
  const auth = authenticated();
  fetchMock.mockResolvedValueOnce(failure(409));
  const store = useTradingStore();
  expect(await store.submit(input)).toBe(false);
  expect(store.error).toContain('可用资金不足');
  expect(auth.account?.accountVersion).toBe(3);
  expect(fetchMock.mock.calls.some(([url]) => url === '/api/me/snapshot')).toBe(true);
});
it.each([400, 429])(
  'does not classify a known %s rejection as an uncertain trade',
  async (status) => {
    fetchMock.mockResolvedValueOnce(failure(status));
    const store = useTradingStore();
    expect(await store.submit(input)).toBe(false);
    expect(store.uncertain).toBe(false);
  },
);
it.each(['network', 'server'])(
  'keeps an uncertain %s outcome locked after history review until same-key retry succeeds',
  async (kind) => {
    if (kind === 'network') fetchMock.mockRejectedValueOnce(new TypeError('network'));
    else fetchMock.mockResolvedValueOnce(failure(500, 'INTERNAL_ERROR', '服务暂时不可用'));
    const store = useTradingStore();
    await store.submit(input);
    expect(store.uncertain).toBe(true);
    expect(await store.submit(input)).toBe(false);
    expect(store.acknowledgeOutcome()).toBe(false);
    await store.refresh();
    expect(store.acknowledgeOutcome()).toBe(false);
    expect(store.uncertain).toBe(true);
    expect(fetchMock.mock.calls.filter(([, options]) => options?.method === 'POST')).toHaveLength(
      1,
    );
    fetchMock.mockResolvedValueOnce(ok({ order: order(), snapshot: snapshot(4) }));
    expect(await store.retryPending()).toBe(true);
    expect(store.uncertain).toBe(false);
    const posts = fetchMock.mock.calls.filter(([, options]) => options?.method === 'POST');
    expect(posts).toHaveLength(2);
    expect(posts[1]![1].body).toBe(posts[0]![1].body);
  },
);
it('clears private records and identity on 401', async () => {
  const auth = authenticated();
  const store = useTradingStore();
  store.orders.items = [order()];
  fetchMock.mockResolvedValueOnce(failure(401, 'UNAUTHENTICATED', '请先登录'));
  await store.submit(input);
  expect(auth.user).toBeNull();
  expect(auth.account).toBeNull();
  expect(store.orders.items).toEqual([]);
});
it('ignores a late order response after identity invalidation', async () => {
  const auth = authenticated();
  const store = useTradingStore();
  let finish!: (r: Response) => void;
  fetchMock.mockImplementationOnce(
    () =>
      new Promise<Response>((resolve) => {
        finish = resolve;
      }),
  );
  const pending = store.submit(input);
  await flushPromises();
  auth.invalidateSession();
  finish(ok({ order: order(), snapshot: snapshot(9) }));
  await pending;
  expect(auth.user).toBeNull();
  expect(auth.account).toBeNull();
  expect(store.notice).toBeNull();
});
it.each([{ userId: 'bravo' }, { serverEpoch: 'other' }])(
  'rejects an unexpected order response identity %j',
  async (change) => {
    const auth = authenticated();
    const store = useTradingStore();
    fetchMock.mockResolvedValueOnce(
      ok({ order: order(), snapshot: { ...snapshot(2), ...change } }),
    );
    expect(await store.submit(input)).toBe(false);
    expect(auth.user).toBeNull();
  },
);
it('does not replace a newer account with a delayed order response', async () => {
  const auth = authenticated();
  const store = useTradingStore();
  auth.account = snapshot(8);
  fetchMock.mockResolvedValueOnce(ok({ order: order(), snapshot: snapshot(2) }));
  await store.submit(input);
  expect(auth.account?.accountVersion).toBe(8);
});
it('preserves newer account and market snapshots during identity refresh', async () => {
  const auth = authenticated();
  auth.account = snapshot(8);
  const market = useMarketStore();
  market.applySnapshot(
    { serverEpoch: 'epoch', marketVersion: 8, quotes: [quote('SIM001', 1500)] },
    'epoch',
  );
  await auth.restoreSession();
  expect(auth.account?.accountVersion).toBe(8);
  expect(auth.quotes[0]?.lastPriceCents).toBe(1500);
});
it('paginates after filtering and merges duplicate IDs once', async () => {
  const store = useTradingStore();
  fetchMock.mockResolvedValueOnce(
    ok({
      userId: 'alice',
      serverEpoch: 'epoch',
      accountVersion: 1,
      items: [order('three', 3), order('two', 2)],
      nextCursor: 2,
    }),
  );
  await store.orders.load({ symbol: 'SIM001', status: 'OPEN' });
  fetchMock.mockResolvedValueOnce(
    ok({
      userId: 'alice',
      serverEpoch: 'epoch',
      accountVersion: 1,
      items: [order('two', 2), order('one', 1)],
      nextCursor: null,
    }),
  );
  await store.orders.load({ symbol: 'SIM001', status: 'OPEN' }, true);
  expect(store.orders.items.map((item) => item.id)).toEqual(['three', 'two', 'one']);
  expect(fetchMock.mock.calls[1]![0]).toContain('cursor=2');
  expect(fetchMock.mock.calls[1]![0]).toContain('status=OPEN');
  expect(store.orders.nextCursor).toBeNull();
});
it('ignores a slow page from an earlier filter', async () => {
  const store = useTradingStore();
  let finish!: (r: Response) => void;
  fetchMock.mockImplementationOnce(
    () =>
      new Promise<Response>((resolve) => {
        finish = resolve;
      }),
  );
  const old = store.orders.load({ symbol: 'SIM001' });
  await flushPromises();
  fetchMock.mockResolvedValueOnce(
    ok({
      userId: 'alice',
      serverEpoch: 'epoch',
      accountVersion: 1,
      items: [{ ...order('new'), symbol: 'SIM002' }],
      nextCursor: null,
    }),
  );
  await store.orders.load({ symbol: 'SIM002' });
  finish(
    ok({
      userId: 'alice',
      serverEpoch: 'epoch',
      accountVersion: 1,
      items: [order('old')],
      nextCursor: null,
    }),
  );
  await old;
  expect(store.orders.items.map((item) => item.id)).toEqual(['new']);
});
it('clears identity when a history request returns 401', async () => {
  const auth = authenticated();
  const store = useTradingStore();
  fetchMock.mockResolvedValueOnce(failure(401));
  await store.personalTrades.load();
  expect(auth.user).toBeNull();
});
it('discards pages that arrive after logout', async () => {
  const auth = authenticated();
  const store = useTradingStore();
  let finish!: (r: Response) => void;
  fetchMock.mockImplementationOnce(
    () =>
      new Promise<Response>((resolve) => {
        finish = resolve;
      }),
  );
  const pending = store.orders.load();
  await flushPromises();
  auth.invalidateSession();
  finish(
    ok({
      userId: 'alice',
      serverEpoch: 'epoch',
      accountVersion: 1,
      items: [order()],
      nextCursor: null,
    }),
  );
  await pending;
  expect(store.orders.items).toEqual([]);
});
it('retains successful submission status if subsequent market refresh fails', async () => {
  const store = useTradingStore();
  fetchMock
    .mockResolvedValueOnce(ok({ order: order(), snapshot: snapshot(2) }))
    .mockRejectedValueOnce(new TypeError('market network'));
  expect(await store.submit(input)).toBe(true);
  expect(store.notice).toContain('已挂单');
  expect(store.stale).toBe(true);
});

it('keeps valid history and uncertain-order protection after a failed logout', async () => {
  const auth = authenticated();
  const store = useTradingStore();
  fetchMock.mockRejectedValueOnce(new TypeError('lost response'));
  await store.submit(input);
  store.orders.items = [order()];
  store.orders.loaded = true;
  fetchMock.mockResolvedValueOnce(failure(500));
  await expect(auth.logout()).rejects.toThrow();
  expect(store.orders.items).toEqual([order()]);
  expect(store.uncertain).toBe(true);
  expect(store.canSubmit).toBe(false);
});
it('never lets filtered, successful, or failed history review acknowledge a pending request', async () => {
  const store = useTradingStore();
  await store.orders.load({ status: 'FILLED', symbol: 'SIM002' });
  fetchMock.mockRejectedValueOnce(new TypeError('lost response'));
  await store.submit(input);
  await store.refresh();
  expect(store.reviewReady).toBe(false);
  expect(store.acknowledgeOutcome()).toBe(false);
  await store.orders.load({});
  expect(store.reviewReady).toBe(false);
  expect(store.acknowledgeOutcome()).toBe(false);
  fetchMock.mockRejectedValueOnce(new TypeError('history failed'));
  await store.orders.load({});
  expect(store.reviewReady).toBe(false);
  expect(store.acknowledgeOutcome()).toBe(false);
});

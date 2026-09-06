import type { PersonalTradeDto, PublicTradeDto, OrderDto } from '@stock/shared';
import { createPinia, disposePinia, setActivePinia } from 'pinia';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { useAccountStore } from '../stores/account.js';
import { useMarketStore } from '../stores/market.js';
import { useTradingStore } from '../stores/trading.js';
import { useRealtimeStore } from '../stores/realtime.js';
import { authenticated, input, ok, order, quote, snapshot } from './trading-fixture.js';
import { installOrderStorage } from './pending-fixture.js';
let pinia: ReturnType<typeof createPinia>;
let fetchMock: ReturnType<typeof vi.fn>;
const owner = { userId: 'alice', serverEpoch: 'epoch' };
const trade = (sequence: number, symbol = 'SIM001'): PersonalTradeDto => ({
  id: 'trade-' + sequence,
  sequence,
  symbol,
  priceCents: 1000,
  quantity: 10,
  executedAt: '2026-09-05T10:00:00.000Z',
  side: 'BUY',
  orderId: 'order-' + sequence,
});
function page(items: (OrderDto | PublicTradeDto)[], version = 1, nextCursor: number | null = null) {
  return ok({ ...owner, accountVersion: version, marketVersion: version, items, nextCursor });
}
function account(
  version: number,
  activeOrders: OrderDto[] = [],
  recentClosedOrders: OrderDto[] = [],
  recentTrades: PersonalTradeDto[] = [],
) {
  useAccountStore().applySnapshot(
    { ...snapshot(version), activeOrders, recentClosedOrders, recentTrades },
    owner,
  );
}
function market(version: number, recentTrades: PublicTradeDto[]) {
  useMarketStore().applySnapshot(
    { serverEpoch: 'epoch', marketVersion: version, quotes: [quote()], recentTrades },
    'epoch',
  );
}
beforeEach(() => {
  installOrderStorage();
  pinia = createPinia();
  setActivePinia(pinia);
  authenticated();
  fetchMock = vi.fn(async () => page([]));
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => {
  disposePinia(pinia);
  vi.unstubAllGlobals();
});
it('supplements an equal-version quote response with the first trade window', () => {
  const state = useMarketStore();
  state.applySnapshot({ serverEpoch: 'epoch', marketVersion: 4, quotes: [quote()] }, 'epoch');
  expect(
    state.applySnapshot(
      { serverEpoch: 'epoch', marketVersion: 4, quotes: [], recentTrades: [trade(4)] },
      'epoch',
    ),
  ).toBe(true);
  expect(state.quotes).toEqual([quote()]);
  expect(state.recentTrades).toEqual([trade(4)]);
  expect(state.tradeWindowVersion).toBe(4);
  state.applySnapshot(
    { serverEpoch: 'epoch', marketVersion: 5, quotes: [quote('SIM001', 2000)] },
    'epoch',
  );
  market(4, [trade(1)]);
  expect(state.recentTrades).toEqual([trade(4)]);
  market(5, [trade(5)]);
  expect(state.recentTrades).toEqual([trade(5)]);
  state.reset();
  expect(state.recentTrades).toEqual([]);
  expect(state.tradeWindowVersion).toBe(-1);
});
it('updates passive fills locally and removes orders that no longer match their status filter', async () => {
  const state = useTradingStore();
  fetchMock.mockResolvedValueOnce(page([order('one', 1)]));
  await state.orders.load({ status: 'OPEN' });
  account(2, [{ ...order('one', 1), status: 'PARTIALLY_FILLED', filledQuantity: 50 }]);
  expect(state.orders.items).toEqual([]);
  fetchMock.mockResolvedValueOnce(
    page([{ ...order('one', 1), status: 'PARTIALLY_FILLED', filledQuantity: 50 }], 2),
  );
  await state.orders.load({ status: 'PARTIALLY_FILLED' });
  account(3, [], [{ ...order('one', 1), status: 'FILLED', filledQuantity: 100 }]);
  expect(state.orders.items).toEqual([]);
  expect(fetchMock).toHaveBeenCalledTimes(2);
});
it('merges newly closed orders into loaded filtered records and retains older pages', async () => {
  const state = useTradingStore();
  const closed = { ...order('old', 1), status: 'FILLED' as const, filledQuantity: 100 };
  fetchMock.mockResolvedValueOnce(page([closed]));
  await state.orders.load({ symbol: 'SIM001', status: 'FILLED' });
  account(2, [], [{ ...order('new', 2), status: 'FILLED', filledQuantity: 100 }]);
  expect(state.orders.items.map((x) => x.id)).toEqual(['new', 'old']);
  expect(fetchMock).toHaveBeenCalledTimes(1);
});
it('never lets a slow order page overwrite a newer pushed fill', async () => {
  const state = useTradingStore();
  let finish!: (response: Response) => void;
  fetchMock.mockImplementationOnce(
    () =>
      new Promise<Response>((resolve) => {
        finish = resolve;
      }),
  );
  const pending = state.orders.load();
  account(2, [], [{ ...order('one', 1), status: 'FILLED', filledQuantity: 100 }]);
  finish(page([order('one', 1)], 1));
  await pending;
  expect(state.orders.items[0]?.status).toBe('FILLED');
  expect(state.orders.error).toBeNull();
});
it('accepts immutable old trade pages while quote ticks advance the global version', async () => {
  const state = useTradingStore();
  market(10, [trade(3)]);
  fetchMock.mockResolvedValueOnce(page([trade(2), trade(1)], 1));
  await state.marketTrades.load();
  expect(state.marketTrades.items.map((x) => x.sequence)).toEqual([3, 2, 1]);
  expect(state.marketTrades.error).toBeNull();
});
it('preserves earlier loaded trades after a recent window rolls forward without HTTP polling', async () => {
  const state = useTradingStore();
  fetchMock.mockResolvedValueOnce(page([trade(2), trade(1)]));
  await state.personalTrades.load();
  account(2, [], [], [trade(3), trade(2)]);
  account(3, [], [], [trade(4), trade(3)]);
  expect(state.personalTrades.items.map((x) => x.sequence)).toEqual([4, 3, 2, 1]);
  expect(fetchMock).toHaveBeenCalledTimes(1);
});
it('caches a pre-load window without treating it as a complete HTTP history page', async () => {
  const state = useTradingStore();
  account(2, [], [], [trade(3)]);
  expect(state.personalTrades.loaded).toBe(false);
  fetchMock.mockResolvedValueOnce(page([trade(3), trade(2)], 2, 2));
  await state.personalTrades.load();
  expect(state.personalTrades.items.map((x) => x.sequence)).toEqual([3, 2]);
  expect(state.personalTrades.nextCursor).toBe(2);
  expect(fetchMock).toHaveBeenCalledTimes(1);
});
it('reopens pagination for a truncated disjoint trade window while preserving older loaded records', async () => {
  const state = useTradingStore();
  fetchMock.mockResolvedValueOnce(page([trade(1)]));
  await state.personalTrades.load();
  account(2, [], [], [trade(1)]);
  const recent = Array.from({ length: 50 }, (_, index) => trade(100 - index));
  account(3, [], [], recent);
  expect(state.personalTrades.items.map((x) => x.sequence)).toContain(1);
  expect(state.personalTrades.nextCursor).toBe(51);
  fetchMock.mockResolvedValueOnce(
    page(
      Array.from({ length: 50 }, (_, index) => trade(50 - index)),
      3,
    ),
  );
  await state.personalTrades.load({}, true);
  expect(state.personalTrades.items).toHaveLength(100);
  expect(state.personalTrades.nextCursor).toBeNull();
});
it('repairs a truncated window gap created while an older page is in flight', async () => {
  const state = useTradingStore();
  account(2, [], [], [trade(1)]);
  let finish!: (response: Response) => void;
  fetchMock.mockImplementationOnce(
    () =>
      new Promise<Response>((resolve) => {
        finish = resolve;
      }),
  );
  const pending = state.personalTrades.load();
  account(
    3,
    [],
    [],
    Array.from({ length: 50 }, (_, index) => trade(100 - index)),
  );
  finish(page([trade(1)], 2));
  await pending;
  expect(state.personalTrades.items).toHaveLength(51);
  expect(state.personalTrades.nextCursor).toBe(51);
});
it('does not keep an old active status when closure falls outside the closed-order window', async () => {
  const state = useTradingStore();
  account(2, [order('ancient', 1)]);
  fetchMock.mockResolvedValueOnce(page([order('ancient', 1)], 2));
  await state.orders.load();
  account(
    3,
    [],
    Array.from({ length: 100 }, (_, index) => ({
      ...order('closed-' + index, 200 - index),
      status: 'FILLED',
      filledQuantity: 100,
    })),
  );
  expect(state.orders.items.some((x) => x.id === 'ancient')).toBe(false);
  expect(state.orders.nextCursor).not.toBeNull();
  fetchMock.mockResolvedValueOnce(
    page([{ ...order('ancient', 1), status: 'FILLED', filledQuantity: 100 }], 3),
  );
  await state.orders.load({}, true);
  expect(state.orders.items.find((x) => x.id === 'ancient')?.status).toBe('FILLED');
});
it('does not issue reads for unchanged trade windows on quote-only updates', async () => {
  const state = useTradingStore();
  fetchMock.mockResolvedValueOnce(page([trade(1)]));
  await state.marketTrades.load();
  market(2, [trade(1)]);
  market(3, [trade(1)]);
  market(4, [trade(1)]);
  expect(state.marketTrades.items.map((x) => x.sequence)).toEqual([1]);
  expect(fetchMock).toHaveBeenCalledTimes(1);
});

it.each(['connecting', 'syncing', 'reconnecting', 'offline'] as const)(
  'blocks POST while the enabled live connection is %s',
  async (status) => {
    const realtime = useRealtimeStore();
    realtime.enabled = true;
    realtime.status = status;
    const state = useTradingStore();
    expect(state.canSubmit).toBe(false);
    expect(await state.submit(input)).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  },
);
it('applies a REST order snapshot while live without extra quote or history reads', async () => {
  const state = useTradingStore();
  fetchMock.mockResolvedValueOnce(page([]));
  await state.orders.load();
  const realtime = useRealtimeStore();
  realtime.enabled = true;
  realtime.status = 'live';
  const filled = { ...order('filled', 2), status: 'FILLED' as const, filledQuantity: 100 };
  const next = { ...snapshot(2), recentClosedOrders: [filled], recentTrades: [trade(2)] };
  fetchMock.mockClear();
  fetchMock.mockResolvedValueOnce(ok({ order: filled, snapshot: next }));
  expect(await state.submit(input)).toBe(true);
  expect(state.orders.items[0]?.status).toBe('FILLED');
  expect(state.notice).toContain('全部成交');
  expect(fetchMock).toHaveBeenCalledTimes(1);
});
it('does not clear uncertain POST protection when a confirming-looking push arrives', async () => {
  const realtime = useRealtimeStore();
  realtime.enabled = true;
  realtime.status = 'live';
  const state = useTradingStore();
  fetchMock.mockRejectedValueOnce(new TypeError('network'));
  await state.submit(input);
  account(2, [], [{ ...order(), status: 'FILLED', filledQuantity: 100 }]);
  expect(state.uncertain).toBe(true);
  expect(state.reviewReady).toBe(false);
  expect(state.acknowledgeOutcome()).toBe(false);
  fetchMock.mockImplementation(async (url: string) =>
    url === '/api/me/snapshot' ? ok(snapshot(3)) : page([], 3),
  );
  await state.refresh();
  expect(state.reviewReady).toBe(false);
  expect(state.acknowledgeOutcome()).toBe(false);
  expect(state.uncertain).toBe(true);
  const original = state.pendingOrder;
  fetchMock.mockResolvedValueOnce(ok({ order: order(), snapshot: snapshot(4) }));
  expect(await state.retryPending()).toBe(true);
  expect(JSON.parse(fetchMock.mock.lastCall?.[1]?.body)).toEqual(original);
  expect(state.pendingOrder).toBeNull();
  expect(fetchMock.mock.calls.some(([url]) => url === '/api/stocks')).toBe(false);
});
it('uses the live market during an explicit account refresh without redundant history reads', async () => {
  const realtime = useRealtimeStore();
  realtime.enabled = true;
  realtime.status = 'live';
  const state = useTradingStore();
  fetchMock.mockResolvedValueOnce(page([]));
  await state.orders.load();
  fetchMock.mockClear();
  fetchMock.mockResolvedValueOnce(ok(snapshot(2)));
  await state.refresh();
  expect(state.stale).toBe(false);
  expect(fetchMock.mock.calls.map(([url]) => url)).toEqual(['/api/me/snapshot']);
});

it('does not roll a newer HTTP order row back when an older account snapshot arrives', async () => {
  const state = useTradingStore();
  fetchMock.mockResolvedValueOnce(
    page([{ ...order('one', 1), status: 'FILLED', filledQuantity: 100 }], 5),
  );
  await state.orders.load();
  account(4, [{ ...order('one', 1), status: 'PARTIALLY_FILLED', filledQuantity: 50 }]);
  expect(state.orders.items[0]?.status).toBe('FILLED');
});
it('keeps market windows in their own version domain when HTTP quotes are newer', () => {
  const state = useMarketStore();
  state.applySnapshot(
    { serverEpoch: 'epoch', marketVersion: 8, quotes: [quote('SIM001', 1800)] },
    'epoch',
  );
  market(7, [trade(7)]);
  expect(state.quotes[0]?.lastPriceCents).toBe(1800);
  expect(state.marketVersion).toBe(8);
  expect(state.tradeWindowVersion).toBe(7);
  expect(state.recentTrades.map((item) => item.sequence)).toEqual([7]);
  expect(
    state.applySnapshot(
      { serverEpoch: 'wrong', marketVersion: 9, quotes: [], recentTrades: [] },
      'epoch',
    ),
  ).toBe(false);
  expect(state.recentTrades.map((item) => item.sequence)).toEqual([7]);
});
it('preserves the current symbol filter as a different stock trades', async () => {
  const state = useTradingStore();
  fetchMock.mockResolvedValueOnce(page([trade(1, 'SIM002')]));
  await state.personalTrades.load({ symbol: 'SIM002' });
  account(2, [], [], [trade(3), trade(2, 'SIM002'), trade(1, 'SIM002')]);
  expect(state.personalTrades.items.map((item) => item.sequence)).toEqual([2, 1]);
  expect(fetchMock).toHaveBeenCalledTimes(1);
});
it('does not resurrect stale active orders missing from the latest complete active set', async () => {
  const state = useTradingStore();
  account(2, [order('old', 1)]);
  let finish!: (response: Response) => void;
  fetchMock.mockImplementationOnce(
    () =>
      new Promise<Response>((resolve) => {
        finish = resolve;
      }),
  );
  const pending = state.orders.load({ status: 'OPEN' });
  account(
    3,
    [],
    Array.from({ length: 100 }, (_, index) => ({
      ...order('closed-' + index, 200 - index),
      status: 'FILLED',
      filledQuantity: 100,
    })),
  );
  finish(page([order('old', 1)], 2));
  await pending;
  expect(state.orders.items).toEqual([]);
});
it('does not remove pending pagination when newer pushes arrive during load-more', async () => {
  const state = useTradingStore();
  account(2, [], [], [trade(5)]);
  fetchMock.mockResolvedValueOnce(page([trade(5), trade(4)], 2, 4));
  await state.personalTrades.load();
  let finish!: (response: Response) => void;
  fetchMock.mockImplementationOnce(
    () =>
      new Promise<Response>((resolve) => {
        finish = resolve;
      }),
  );
  const pending = state.personalTrades.load({}, true);
  account(3, [], [], [trade(6), trade(5)]);
  finish(page([trade(3), trade(2)], 2, 2));
  await pending;
  expect(state.personalTrades.items.map((item) => item.sequence)).toEqual([6, 5, 4, 3, 2]);
  expect(state.personalTrades.nextCursor).toBe(2);
});
it('clears live history and its pagination gaps when identity is invalidated', async () => {
  const auth = authenticated();
  const state = useTradingStore();
  fetchMock.mockResolvedValueOnce(page([trade(1)]));
  await state.personalTrades.load();
  account(
    2,
    [],
    [],
    Array.from({ length: 50 }, (_, index) => trade(100 - index)),
  );
  expect(state.personalTrades.nextCursor).not.toBeNull();
  auth.invalidateSession();
  expect(state.personalTrades.items).toEqual([]);
  expect(state.personalTrades.nextCursor).toBeNull();
  expect(state.personalTrades.loaded).toBe(false);
});

it.each(['initial load', 'refresh'] as const)(
  'repairs an ancient closure omitted from a filtered HTTP page during %s',
  async (mode) => {
    const state = useTradingStore();
    const ancient = order('ancient', 100);
    const closed: OrderDto[] = Array.from({ length: 100 }, (_, index) => ({
      ...order('closed-' + (600 - index), 600 - index),
      symbol: index === 0 ? 'SIM001' : 'SIM002',
      status: 'FILLED',
      filledQuantity: 100,
    }));
    const filters = { symbol: 'SIM001', status: 'FILLED' as const };
    account(2, [ancient], closed);
    if (mode === 'refresh') {
      fetchMock.mockResolvedValueOnce(page([closed[0]!], 2));
      await state.orders.load(filters);
    }
    let finish!: (response: Response) => void;
    fetchMock.mockImplementationOnce(
      () =>
        new Promise<Response>((resolve) => {
          finish = resolve;
        }),
    );
    const pending = state.orders.load(filters);
    // The old order completes, but order history is sorted by creation sequence,
    // so it is absent from the unchanged most-recent 100 closed-order window.
    account(3, [], closed);
    finish(page([closed[0]!], 2));
    await pending;
    expect(state.orders.items.map((item) => item.id)).toEqual(['closed-600']);
    expect(state.orders.nextCursor).toBe(101);
    const filled: OrderDto = { ...ancient, status: 'FILLED', filledQuantity: 100 };
    fetchMock.mockResolvedValueOnce(page([filled], 3));
    await state.orders.load(filters, true);
    expect(fetchMock.mock.lastCall?.[0]).toContain('cursor=101');
    expect(state.orders.items.map((item) => item.id)).toEqual(['closed-600', 'ancient']);
    expect(state.orders.items[1]?.status).toBe('FILLED');
    expect(state.orders.nextCursor).toBeNull();
  },
);

it('retains the already loaded account window when trading-store recovery initializes', async () => {
  const auth = authenticated();
  const filled: OrderDto = { ...order('one', 1), status: 'FILLED', filledQuantity: 100 };
  auth.account = { ...snapshot(5), recentClosedOrders: [filled] };
  const state = useTradingStore();
  fetchMock.mockResolvedValueOnce(page([order('one', 1)], 4));
  await state.orders.load();
  expect(state.orders.items).toEqual([filled]);
});

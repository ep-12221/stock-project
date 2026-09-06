import { createPinia, disposePinia, setActivePinia } from 'pinia';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { useTradingStore } from '../stores/trading.js';
import { useRealtimeStore } from '../stores/realtime.js';
import { authenticated, failure, input, ok, order, snapshot } from './trading-fixture.js';
import { installOrderStorage } from './pending-fixture.js';
let pinia: ReturnType<typeof createPinia>;
let fetchMock: ReturnType<typeof vi.fn>;
let disk: ReturnType<typeof installOrderStorage>;
function session() {
  pinia = createPinia();
  setActivePinia(pinia);
  const auth = authenticated();
  const realtime = useRealtimeStore();
  realtime.enabled = true;
  realtime.status = 'live';
  return auth;
}
const success = (status = 200, version = 2) =>
  new Response(JSON.stringify({ data: { order: order(), snapshot: snapshot(version) } }), {
    status,
  });
const bodies = () =>
  fetchMock.mock.calls
    .filter(([, options]) => options?.method === 'POST')
    .map(([, options]) => JSON.parse(options.body));
beforeEach(() => {
  disk = installOrderStorage();
  session();
  fetchMock = vi.fn(async () => success());
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => {
  disposePinia(pinia);
  vi.unstubAllGlobals();
});
it('persists a new UUID and immutable business parameters before each first POST', async () => {
  const state = useTradingStore();
  const source = { ...input };
  fetchMock.mockImplementationOnce(async () => {
    expect(disk.entries.size).toBe(1);
    source.priceCents = 9000;
    return success(201);
  });
  expect(await state.submit(source)).toBe(true);
  expect(await state.submit(input)).toBe(true);
  const [first, second] = bodies();
  expect(first).toEqual({
    ...input,
    clientOrderId: expect.stringMatching(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    ),
  });
  expect(second.clientOrderId).not.toBe(first.clientOrderId);
  expect(state.pendingOrder).toBeNull();
  expect(disk.entries.size).toBe(0);
  expect(fetchMock).toHaveBeenCalledTimes(2);
});
it.each(['network', 'server', 'malformed', 'mismatched order', 'invalid snapshot'])(
  'keeps the exact pending request for an uncertain %s result',
  async (kind) => {
    if (kind === 'network') fetchMock.mockRejectedValueOnce(new Error('network'));
    if (kind === 'server') fetchMock.mockResolvedValueOnce(failure(503));
    if (kind === 'malformed') fetchMock.mockResolvedValueOnce(ok({ snapshot: snapshot(2) }));
    if (kind === 'mismatched order')
      fetchMock.mockResolvedValueOnce(
        ok({ order: { ...order(), quantity: 200 }, snapshot: snapshot(2) }),
      );
    if (kind === 'invalid snapshot')
      fetchMock.mockResolvedValueOnce(
        ok({ order: order(), snapshot: { ...snapshot(2), accountVersion: 'bad' } }),
      );
    const state = useTradingStore();
    expect(await state.submit(input)).toBe(false);
    expect(state.pendingOrder).toEqual(bodies()[0]);
    expect(state.uncertain).toBe(true);
    expect(state.canSubmit).toBe(false);
    expect(state.canRetry).toBe(true);
    expect(disk.entries.size).toBe(1);
    expect(await state.retryPending()).toBe(true);
    expect(bodies()[1]).toEqual(bodies()[0]);
    expect(state.pendingOrder).toBeNull();
    expect(state.uncertain).toBe(false);
    expect(state.stale).toBe(false);
    expect(disk.entries.size).toBe(0);
  },
);
it('uses the original request on retry even if the form changes and funds are now frozen', async () => {
  const auth = authenticated();
  const state = useTradingStore();
  const source = { ...input };
  fetchMock.mockRejectedValueOnce(new Error('timeout'));
  await state.submit(source);
  source.priceCents = 2000;
  source.quantity = 1000;
  auth.account = {
    ...snapshot(8),
    account: { cashBalanceCents: 100000000, frozenCashCents: 100000000, availableCashCents: 0 },
  };
  expect(await state.submit(source)).toBe(false);
  expect(await state.retryPending()).toBe(true);
  expect(bodies()[1]).toEqual(bodies()[0]);
  expect(auth.account?.accountVersion).toBe(8);
});
it('prevents a double click and a simultaneous new order while retry is in flight', async () => {
  const state = useTradingStore();
  fetchMock.mockRejectedValueOnce(new Error('lost'));
  await state.submit(input);
  let finish!: (r: Response) => void;
  fetchMock.mockImplementationOnce(
    () =>
      new Promise<Response>((resolve) => {
        finish = resolve;
      }),
  );
  const pending = state.retryPending();
  expect(state.submitting).toBe(true);
  expect(await state.retryPending()).toBe(false);
  expect(await state.submit(input)).toBe(false);
  await state.refresh();
  expect(fetchMock).toHaveBeenCalledTimes(2);
  finish(success());
  await pending;
});
it.each([400, 403, 404, 409, 429])(
  'clears a definite HTTP %s rejection and creates a different key next time',
  async (status) => {
    const state = useTradingStore();
    fetchMock.mockImplementation(async (url: string) =>
      url === '/api/me/snapshot' ? ok(snapshot(3)) : success(),
    );
    fetchMock.mockResolvedValueOnce(failure(status));
    expect(await state.submit(input)).toBe(false);
    expect(state.pendingOrder).toBeNull();
    expect(state.uncertain).toBe(false);
    expect(disk.entries.size).toBe(0);
    expect(await state.submit(input)).toBe(true);
    expect(bodies()[1].clientOrderId).not.toBe(bodies()[0].clientOrderId);
  },
);
it('keeps the original pending request after an idempotency conflict', async () => {
  const state = useTradingStore();
  fetchMock.mockRejectedValueOnce(new Error('lost'));
  await state.submit(input);
  fetchMock.mockResolvedValueOnce(failure(409, 'IDEMPOTENCY_CONFLICT', '参数冲突'));
  expect(await state.retryPending()).toBe(false);
  expect(state.pendingOrder).toEqual(bodies()[0]);
  expect(state.uncertain).toBe(true);
  expect(state.canSubmit).toBe(false);
  expect(state.error).toContain('冲突');
  expect(disk.entries.size).toBe(1);
  expect(fetchMock).toHaveBeenCalledTimes(2);
});
it('restores pending from a page reload without POST and allows only explicit retry', async () => {
  const state = useTradingStore();
  fetchMock.mockRejectedValueOnce(new Error('lost'));
  await state.submit(input);
  const original = bodies()[0];
  disposePinia(pinia);
  session();
  fetchMock.mockClear();
  const restored = useTradingStore();
  expect(restored.pendingOrder).toEqual(original);
  expect(restored.uncertain).toBe(true);
  expect(restored.canSubmit).toBe(false);
  expect(fetchMock).not.toHaveBeenCalled();
  expect(await restored.retryPending()).toBe(true);
  expect(bodies()[0]).toEqual(original);
});
it('retains a request persisted before page closure even while its HTTP response is outstanding', async () => {
  const state = useTradingStore();
  let finish!: (r: Response) => void;
  fetchMock.mockImplementationOnce(
    () =>
      new Promise<Response>((resolve) => {
        finish = resolve;
      }),
  );
  const pending = state.submit(input);
  const original = bodies()[0];
  disposePinia(pinia);
  session();
  const restored = useTradingStore();
  expect(restored.pendingOrder).toEqual(original);
  finish(success());
  await pending;
  expect(restored.pendingOrder).toEqual(original);
  expect(disk.entries.size).toBe(1);
});
it('hides old-user pending state and restores only the same user and server epoch', async () => {
  const auth = authenticated();
  const state = useTradingStore();
  fetchMock.mockRejectedValueOnce(new Error('lost'));
  await state.submit(input);
  const original = state.pendingOrder;
  auth.invalidateSession();
  expect(state.pendingOrder).toBeNull();
  expect(state.uncertain).toBe(false);
  auth.user = { id: 'bravo', username: 'bravo' };
  auth.serverEpoch = 'epoch';
  auth.account = { ...snapshot(), userId: 'bravo' };
  expect(state.pendingOrder).toBeNull();
  expect(await state.retryPending()).toBe(false);
  auth.invalidateSession();
  authenticated();
  expect(state.pendingOrder).toEqual(original);
  auth.serverEpoch = 'new-epoch';
  auth.account = { ...snapshot(), serverEpoch: 'new-epoch' };
  expect(state.pendingOrder).toBeNull();
  expect(await state.retryPending()).toBe(false);
});
it('does not let a late response for the old identity clear a newer pending request', async () => {
  const auth = authenticated();
  const state = useTradingStore();
  let finish!: (r: Response) => void;
  fetchMock.mockImplementationOnce(
    () =>
      new Promise<Response>((resolve) => {
        finish = resolve;
      }),
  );
  const old = state.submit(input);
  auth.invalidateSession();
  auth.user = { id: 'bravo', username: 'bravo' };
  auth.serverEpoch = 'epoch';
  auth.account = { ...snapshot(), userId: 'bravo' };
  useRealtimeStore().status = 'live';
  fetchMock.mockRejectedValueOnce(new Error('lost'));
  await state.submit(input);
  const latest = state.pendingOrder;
  finish(success());
  await old;
  expect(state.pendingOrder).toEqual(latest);
  expect(state.uncertain).toBe(true);
  expect(disk.entries.size).toBe(2);
});
it('keeps pending protection after a push or a manual account/history review', async () => {
  const auth = authenticated();
  const state = useTradingStore();
  fetchMock.mockRejectedValueOnce(new Error('lost'));
  await state.submit(input);
  auth.account = {
    ...snapshot(5),
    recentClosedOrders: [{ ...order(), status: 'FILLED', filledQuantity: 100 }],
  };
  fetchMock.mockImplementation(async (url: string) =>
    url === '/api/me/snapshot'
      ? ok(snapshot(6))
      : ok({
          userId: 'alice',
          serverEpoch: 'epoch',
          accountVersion: 6,
          items: [],
          nextCursor: null,
        }),
  );
  await state.refresh();
  expect(state.acknowledgeOutcome()).toBe(false);
  expect(state.pendingOrder).toEqual(bodies()[0]);
  expect(state.uncertain).toBe(true);
  expect(state.canSubmit).toBe(false);
});
it.each(['connecting', 'syncing', 'reconnecting', 'offline'] as const)(
  'does not retry while realtime is %s',
  async (status) => {
    const state = useTradingStore();
    fetchMock.mockRejectedValueOnce(new Error('lost'));
    await state.submit(input);
    useRealtimeStore().status = status;
    expect(state.canRetry).toBe(false);
    expect(await state.retryPending()).toBe(false);
    expect(bodies()).toHaveLength(1);
  },
);
it('does not retry while account refresh or authentication is in flight', async () => {
  const auth = authenticated();
  const state = useTradingStore();
  fetchMock.mockRejectedValueOnce(new Error('lost'));
  await state.submit(input);
  state.refreshing = true;
  expect(await state.retryPending()).toBe(false);
  state.refreshing = false;
  auth.busy = true;
  expect(await state.retryPending()).toBe(false);
  expect(bodies()).toHaveLength(1);
});
it('does not send a new order when durable storage fails', async () => {
  const state = useTradingStore();
  disk.storage.setItem.mockImplementationOnce(() => {
    throw new Error('quota');
  });
  expect(await state.submit(input)).toBe(false);
  expect(fetchMock).not.toHaveBeenCalled();
  expect(state.canSubmit).toBe(false);
  expect(state.error).toContain('存储');
});
it('does not send a new order when crypto UUID generation is unavailable', async () => {
  const state = useTradingStore();
  vi.stubGlobal('crypto', {});
  expect(await state.submit(input)).toBe(false);
  expect(fetchMock).not.toHaveBeenCalled();
  expect(state.error).toBeTruthy();
});
it('fails closed when the owner pending record is corrupted', async () => {
  const state = useTradingStore();
  fetchMock.mockRejectedValueOnce(new Error('lost'));
  await state.submit(input);
  const key = [...disk.entries.keys()][0]!;
  disk.entries.set(key, '{broken');
  disposePinia(pinia);
  session();
  fetchMock.mockClear();
  const restored = useTradingStore();
  expect(restored.canSubmit).toBe(false);
  expect(await restored.submit(input)).toBe(false);
  expect(restored.error).toContain('存储');
  expect(fetchMock).not.toHaveBeenCalled();
});
it('fails closed when pending storage cannot be read', async () => {
  disk.storage.getItem.mockImplementationOnce(() => {
    throw new Error('disabled');
  });
  const state = useTradingStore();
  expect(state.canSubmit).toBe(false);
  expect(await state.submit(input)).toBe(false);
  expect(fetchMock).not.toHaveBeenCalled();
});
it('does not unlock a confirmed request when removal from storage fails', async () => {
  const state = useTradingStore();
  disk.storage.removeItem.mockImplementationOnce(() => {
    throw new Error('disabled');
  });
  await state.submit(input);
  expect(state.pendingOrder).toEqual(bodies()[0]);
  expect(state.canSubmit).toBe(false);
  expect(disk.entries.size).toBe(1);
  expect(await state.retryPending()).toBe(true);
  expect(state.pendingOrder).toBeNull();
  expect(disk.entries.size).toBe(0);
});
it('clears visible private data on 401 while keeping the same-identity recovery record', async () => {
  const auth = authenticated();
  const state = useTradingStore();
  fetchMock.mockResolvedValueOnce(failure(401));
  await state.submit(input);
  expect(auth.user).toBeNull();
  expect(state.pendingOrder).toBeNull();
  expect(disk.entries.size).toBe(1);
  authenticated();
  expect(state.pendingOrder).toEqual(bodies()[0]);
});

it('releases a superseded refresh after session revision changes so the original request can be retried', async () => {
  const auth = authenticated();
  const state = useTradingStore();
  fetchMock.mockRejectedValueOnce(new Error('lost'));
  await state.submit(input);
  let finish!: (r: Response) => void;
  fetchMock.mockImplementationOnce(
    () =>
      new Promise<Response>((resolve) => {
        finish = resolve;
      }),
  );
  const refresh = state.refresh();
  expect(state.refreshing).toBe(true);
  auth.sessionRevision++;
  expect(state.refreshing).toBe(false);
  expect(state.canRetry).toBe(true);
  expect(await state.retryPending()).toBe(true);
  finish(ok(snapshot(99)));
  await refresh;
  expect(auth.account?.accountVersion).toBe(2);
  expect(state.pendingOrder).toBeNull();
});
it('ignores an old POST across same-user session replacement while a retry is in flight', async () => {
  const auth = authenticated();
  const state = useTradingStore();
  let finishOld!: (r: Response) => void;
  fetchMock.mockImplementationOnce(
    () =>
      new Promise<Response>((resolve) => {
        finishOld = resolve;
      }),
  );
  const old = state.submit(input);
  auth.sessionRevision++;
  expect(state.submitting).toBe(false);
  expect(state.uncertain).toBe(true);
  let finishNew!: (r: Response) => void;
  fetchMock.mockImplementationOnce(
    () =>
      new Promise<Response>((resolve) => {
        finishNew = resolve;
      }),
  );
  const retry = state.retryPending();
  finishOld(success(201, 99));
  await old;
  expect(state.submitting).toBe(true);
  expect(auth.account?.accountVersion).toBe(1);
  expect(state.pendingOrder).toEqual(bodies()[0]);
  finishNew(success(200, 2));
  expect(await retry).toBe(true);
  expect(auth.account?.accountVersion).toBe(2);
  expect(bodies()[1]).toEqual(bodies()[0]);
});

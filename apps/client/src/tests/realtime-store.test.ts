import { createPinia, disposePinia, setActivePinia } from 'pinia';
import { flushPromises } from '@vue/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useRealtimeStore } from '../stores/realtime.js';
import { useAccountStore } from '../stores/account.js';
import { useMarketStore } from '../stores/market.js';
import { authenticated, failure, ok, order, quote, snapshot } from './trading-fixture.js';

class FakeSocket {
  static instances: FakeSocket[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onclose: ((event: { code: number }) => void) | null = null;
  onerror: (() => void) | null = null;
  close = vi.fn();
  constructor(public url: string) {
    FakeSocket.instances.push(this);
  }
  open() {
    this.onopen?.();
  }
  receive(data: unknown) {
    this.onmessage?.({ data: JSON.stringify(data) });
  }
  disconnect(code = 1006) {
    this.onclose?.({ code });
  }
}
let pinia: ReturnType<typeof createPinia>;
let auth: ReturnType<typeof authenticated>;
const market = (version = 1) => ({ marketVersion: version, quotes: [quote()], recentTrades: [] });
const frame = (
  type = 'state.snapshot',
  payload: unknown = { account: snapshot(), market: market() },
  serverEpoch = 'epoch',
) => ({ type, payload, serverEpoch, emittedAt: '2026-09-06T00:00:00.000Z' });
const identity = () => ({
  user: { id: 'alice', username: 'alice' },
  serverEpoch: 'epoch',
  expiresAt: '2099-01-01T00:00:00.000Z',
});
const current = () => FakeSocket.instances.at(-1)!;
function startLive() {
  const store = useRealtimeStore();
  store.start();
  current().open();
  current().receive(frame());
  return store;
}
beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(Math, 'random').mockReturnValue(0.5);
  FakeSocket.instances = [];
  vi.stubGlobal('WebSocket', FakeSocket);
  vi.stubGlobal('location', { href: 'http://localhost:5173/' });
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => ok(identity())),
  );
  pinia = createPinia();
  setActivePinia(pinia);
  auth = authenticated();
});
afterEach(() => {
  disposePinia(pinia);
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('initial synchronization', () => {
  it('starts explicitly, once, and waits for a complete snapshot after open', () => {
    const store = useRealtimeStore();
    expect(store.enabled).toBe(false);
    expect(FakeSocket.instances).toHaveLength(0);
    store.start();
    store.start();
    expect(store.enabled).toBe(true);
    expect(FakeSocket.instances).toHaveLength(1);
    expect(current().url).toBe('ws://localhost:5173/ws');
    expect(store.status).toBe('connecting');
    expect(store.ready).toBe(false);
    current().open();
    expect(store.status).toBe('syncing');
    expect(store.ready).toBe(false);
    current().receive(frame());
    expect(store.ready).toBe(true);
    expect(store.status).toBe('live');
  });
  it('uses secure WebSocket for HTTPS', () => {
    vi.stubGlobal('location', { href: 'https://example.test/trading' });
    useRealtimeStore().start();
    expect(current().url).toBe('wss://example.test/ws');
  });
  it('does not connect before login and connects after login becomes usable', async () => {
    auth.user = null;
    auth.serverEpoch = null;
    const store = useRealtimeStore();
    store.start();
    expect(FakeSocket.instances).toHaveLength(0);
    auth.busy = true;
    auth.user = { id: 'alice', username: 'alice' };
    auth.serverEpoch = 'epoch';
    await flushPromises();
    expect(FakeSocket.instances).toHaveLength(0);
    auth.busy = false;
    await flushPromises();
    expect(FakeSocket.instances).toHaveLength(1);
  });
  it('accepts an equal initial version and later version jumps, ignoring older updates', () => {
    const store = startLive();
    expect(store.ready).toBe(true);
    current().receive(frame('account.updated', snapshot(5)));
    current().receive(frame('account.updated', snapshot(2)));
    current().receive(frame('market.updated', market(8)));
    current().receive(frame('market.updated', market(4)));
    expect(useAccountStore().snapshot?.accountVersion).toBe(5);
    expect(useMarketStore().marketVersion).toBe(8);
  });
  it('applies both domains from the same initial frame', () => {
    const store = useRealtimeStore();
    store.start();
    current().open();
    current().receive(frame('state.snapshot', { account: snapshot(4), market: market(9) }));
    expect(store.ready).toBe(true);
    expect(useAccountStore().snapshot?.accountVersion).toBe(4);
    expect(useMarketStore().marketVersion).toBe(9);
  });
  it('does not consume updates before the full initial snapshot', () => {
    const store = useRealtimeStore();
    store.start();
    current().open();
    current().receive(frame('account.updated', snapshot(4)));
    expect(store.ready).toBe(false);
    expect(auth.account?.accountVersion).toBe(1);
    expect(current().close).toHaveBeenCalled();
  });
  it.each([
    null,
    {},
    { type: 'bogus' },
    frame('account.updated', { ...snapshot(4), positions: [{}] }),
    frame('market.updated', { ...market(4), quotes: [{ ...quote(), lastPriceCents: -1 }] }),
  ])('rejects malformed frames without corrupting current state: %j', (data) => {
    const store = startLive();
    current().receive(data);
    expect(store.ready).toBe(false);
    expect(auth.account?.accountVersion).toBe(1);
    expect(auth.quotes).toEqual([quote()]);
    expect(current().close).toHaveBeenCalled();
  });
  it.each([{ status: ['OPEN'] }, { status: { toString: 1 } }])(
    'rejects non-string order status without throwing: %j',
    ({ status }) => {
      const store = startLive();
      expect(() =>
        current().receive(
          frame('account.updated', { ...snapshot(4), activeOrders: [{ ...order(), status }] }),
        ),
      ).not.toThrow();
      expect(store.ready).toBe(false);
      expect(auth.account?.accountVersion).toBe(1);
    },
  );
  it('rejects a partial initial frame atomically', () => {
    const store = useRealtimeStore();
    store.start();
    current().open();
    current().receive(
      frame('state.snapshot', { account: snapshot(4), market: { marketVersion: 9, quotes: [] } }),
    );
    expect(store.ready).toBe(false);
    expect(auth.account?.accountVersion).toBe(1);
    expect(useMarketStore().marketVersion).toBe(-1);
  });
  it('rejects non-JSON without throwing in the browser callback', () => {
    const store = startLive();
    expect(() => current().onmessage?.({ data: '<html>' })).not.toThrow();
    expect(store.ready).toBe(false);
  });
  it.each([{ userId: 'bravo' }, { serverEpoch: 'other' }])(
    'clears an identity-mismatched private snapshot: %j',
    (change) => {
      const store = startLive();
      current().receive(frame('account.updated', { ...snapshot(4), ...change }));
      expect(auth.user).toBeNull();
      expect(store.ready).toBe(false);
      expect(auth.account).toBeNull();
    },
  );
  it('invalidates the session on a new process epoch', () => {
    const store = startLive();
    current().receive(frame('market.updated', market(2), 'restarted'));
    expect(auth.user).toBeNull();
    expect(store.ready).toBe(false);
  });
});

describe('connection ownership and cleanup', () => {
  it('keeps the same connection when a profile object is refreshed for the same user', async () => {
    const store = startLive();
    auth.user = { id: 'alice', username: 'alice' };
    await flushPromises();
    expect(FakeSocket.instances).toHaveLength(1);
    expect(store.ready).toBe(true);
  });
  it('immediately invalidates callbacks during a session mutation and reconnects if logout fails', async () => {
    const store = startLive();
    const old = current();
    const lateMessage = old.onmessage!;
    const lateClose = old.onclose!;
    auth.sessionRevision++;
    auth.busy = true;
    expect(store.ready).toBe(false);
    expect(old.close).toHaveBeenCalled();
    auth.busy = false;
    await flushPromises();
    expect(FakeSocket.instances).toHaveLength(2);
    current().open();
    current().receive(frame('state.snapshot', { account: snapshot(3), market: market(3) }));
    lateMessage({ data: JSON.stringify(frame('account.updated', snapshot(99))) });
    lateClose({ code: 4401 });
    expect(auth.account?.accountVersion).toBe(3);
    expect(auth.user?.id).toBe('alice');
    expect(store.ready).toBe(true);
  });
  it('does not reconnect after logout', async () => {
    const store = startLive();
    auth.invalidateSession();
    await flushPromises();
    await vi.advanceTimersByTimeAsync(60000);
    expect(FakeSocket.instances).toHaveLength(1);
    expect(store.status).toBe('idle');
  });
  it('stop closes the connection, cancels every timer and watcher, and supports a fresh start', async () => {
    const store = startLive();
    current().disconnect();
    store.stop();
    auth.sessionRevision++;
    await flushPromises();
    await vi.advanceTimersByTimeAsync(60000);
    expect(store.enabled).toBe(false);
    expect(store.ready).toBe(false);
    expect(store.status).toBe('idle');
    expect(FakeSocket.instances).toHaveLength(1);
    store.start();
    expect(FakeSocket.instances).toHaveLength(2);
  });
  it('manual reconnect replaces the socket without discarding balances', () => {
    const store = startLive();
    const old = current();
    store.reconnect();
    expect(old.close).toHaveBeenCalled();
    expect(FakeSocket.instances).toHaveLength(2);
    expect(store.ready).toBe(false);
    expect(auth.account).toEqual(snapshot());
  });
  it('disposal prevents delayed reconnects', async () => {
    const store = startLive();
    current().disconnect();
    store.$dispose();
    await vi.advanceTimersByTimeAsync(60000);
    expect(FakeSocket.instances).toHaveLength(1);
  });
});

describe('disconnect recovery', () => {
  it('preserves snapshots and retries after 1, 2, 4 seconds, resetting backoff after synchronization', async () => {
    const store = startLive();
    current().disconnect();
    expect(store.ready).toBe(false);
    expect(auth.account).toEqual(snapshot());
    expect(store.status).toBe('reconnecting');
    for (const [delay, count] of [
      [1000, 2],
      [2000, 3],
      [4000, 4],
    ]) {
      await vi.advanceTimersByTimeAsync(delay! - 1);
      expect(FakeSocket.instances).toHaveLength(count! - 1);
      await vi.advanceTimersByTimeAsync(1);
      expect(FakeSocket.instances).toHaveLength(count!);
      current().disconnect();
    }
    store.reconnect();
    current().open();
    current().receive(frame());
    current().disconnect();
    await vi.advanceTimersByTimeAsync(1000);
    expect(FakeSocket.instances).toHaveLength(6);
  });
  it('bounds exponential backoff at 30 seconds', async () => {
    startLive();
    for (const delay of [1000, 2000, 4000, 8000, 16000, 30000, 30000]) {
      const count = FakeSocket.instances.length;
      current().disconnect();
      await vi.advanceTimersByTimeAsync(delay - 1);
      expect(FakeSocket.instances).toHaveLength(count);
      await vi.advanceTimersByTimeAsync(1);
      expect(FakeSocket.instances).toHaveLength(count + 1);
    }
  });
  it('times out a connection that opens but never sends its snapshot', async () => {
    const store = useRealtimeStore();
    store.start();
    current().open();
    await vi.advanceTimersByTimeAsync(10000);
    expect(store.ready).toBe(false);
    expect(current().close).toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1000);
    expect(FakeSocket.instances).toHaveLength(2);
  });
  it('does not schedule two retries when error and close both fire', async () => {
    startLive();
    const socket = current();
    const close = socket.onclose!;
    socket.onerror?.();
    close({ code: 1006 });
    await vi.advanceTimersByTimeAsync(1000);
    expect(FakeSocket.instances).toHaveLength(2);
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it('stops retries for a server session-invalid close', async () => {
    const store = startLive();
    current().disconnect(4401);
    await vi.advanceTimersByTimeAsync(60000);
    expect(auth.user).toBeNull();
    expect(store.status).toBe('idle');
    expect(FakeSocket.instances).toHaveLength(1);
  });
  it('checks HTTP identity after an upgrade failure and stops on a confirmed 401', async () => {
    vi.mocked(fetch).mockResolvedValue(failure(401));
    const store = useRealtimeStore();
    store.start();
    current().onerror?.();
    await flushPromises();
    expect(fetch).toHaveBeenCalledWith('/api/auth/me', expect.anything());
    expect(auth.user).toBeNull();
    expect(store.status).toBe('idle');
    await vi.advanceTimersByTimeAsync(60000);
    expect(FakeSocket.instances).toHaveLength(1);
  });
  it('invalidates a changed HTTP identity or epoch during reconnect', async () => {
    vi.mocked(fetch).mockResolvedValue(ok({ ...identity(), serverEpoch: 'new' }));
    startLive();
    current().disconnect();
    await flushPromises();
    expect(auth.user).toBeNull();
  });
  it('retries after ordinary HTTP network errors without clearing private data', async () => {
    vi.mocked(fetch).mockRejectedValue(new Error('offline'));
    const store = startLive();
    current().disconnect();
    await flushPromises();
    expect(auth.user?.id).toBe('alice');
    expect(auth.account).toEqual(snapshot());
    await vi.advanceTimersByTimeAsync(1000);
    expect(FakeSocket.instances).toHaveLength(2);
    expect(store.ready).toBe(false);
  });
  it('ignores a late HTTP 401 from an earlier connection after recovery', async () => {
    let resolve!: (response: Response) => void;
    vi.mocked(fetch).mockReturnValue(
      new Promise<Response>((done) => {
        resolve = done;
      }),
    );
    const store = startLive();
    current().disconnect();
    await vi.advanceTimersByTimeAsync(1000);
    current().open();
    current().receive(frame());
    resolve(failure(401));
    await flushPromises();
    expect(auth.user?.id).toBe('alice');
    expect(store.ready).toBe(true);
  });
  it('ignores a late HTTP 401 after a different login', async () => {
    let resolve!: (response: Response) => void;
    vi.mocked(fetch).mockReturnValue(
      new Promise<Response>((done) => {
        resolve = done;
      }),
    );
    const store = startLive();
    current().disconnect();
    auth.sessionRevision++;
    auth.user = { id: 'bravo', username: 'bravo' };
    await flushPromises();
    current().open();
    current().receive(
      frame('state.snapshot', { account: { ...snapshot(), userId: 'bravo' }, market: market() }),
    );
    resolve(failure(401));
    await flushPromises();
    expect(auth.user?.id).toBe('bravo');
    expect(store.ready).toBe(true);
  });
  it('does not poll HTTP while the socket is live', async () => {
    const store = startLive();
    for (let second = 1; second <= 60; second++) {
      await vi.advanceTimersByTimeAsync(1000);
      current().receive(frame('market.updated', market(second + 1)));
      expect(store.ready).toBe(true);
    }
    expect(FakeSocket.instances).toHaveLength(1);
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe('silent connection detection', () => {
  it('leaves live state after 15 seconds without messages and retains balances while reconnecting', async () => {
    const store = startLive();
    await vi.advanceTimersByTimeAsync(14999);
    expect(store.ready).toBe(true);
    await vi.advanceTimersByTimeAsync(1);
    expect(store.ready).toBe(false);
    expect(store.status).toBe('reconnecting');
    expect(current().close).toHaveBeenCalledOnce();
    expect(auth.account).toEqual(snapshot());
    expect(auth.quotes).toEqual([quote()]);
    await vi.advanceTimersByTimeAsync(1000);
    expect(FakeSocket.instances).toHaveLength(2);
  });
  it.each(['state.snapshot', 'market.updated', 'account.updated'])(
    'renews liveness on a valid %s, even when its version was already applied',
    async (type) => {
      const store = startLive();
      await vi.advanceTimersByTimeAsync(14000);
      const payload =
        type === 'state.snapshot'
          ? { account: snapshot(), market: market() }
          : type === 'market.updated'
            ? market()
            : snapshot();
      current().receive(frame(type, payload));
      await vi.advanceTimersByTimeAsync(14999);
      expect(store.ready).toBe(true);
      await vi.advanceTimersByTimeAsync(1);
      expect(store.ready).toBe(false);
    },
  );
  it('rejects a malformed message instead of extending live state', async () => {
    const store = startLive();
    await vi.advanceTimersByTimeAsync(14000);
    current().receive(frame('market.updated', { ...market(2), recentTrades: null }));
    expect(store.ready).toBe(false);
    expect(store.status).toBe('reconnecting');
    await vi.advanceTimersByTimeAsync(1000);
    expect(FakeSocket.instances).toHaveLength(2);
  });
  it('ignores old connection frames when measuring the new connection liveness', async () => {
    const store = startLive();
    const oldMessage = current().onmessage!;
    store.reconnect();
    current().open();
    current().receive(frame());
    await vi.advanceTimersByTimeAsync(14000);
    oldMessage({ data: JSON.stringify(frame('market.updated', market(99))) });
    await vi.advanceTimersByTimeAsync(1000);
    expect(store.ready).toBe(false);
    expect(useMarketStore().marketVersion).toBe(1);
  });
  it('clears the old watchdog when manually reconnecting', async () => {
    const store = startLive();
    await vi.advanceTimersByTimeAsync(10000);
    store.reconnect();
    current().open();
    current().receive(frame());
    await vi.advanceTimersByTimeAsync(5000);
    expect(store.ready).toBe(true);
    expect(FakeSocket.instances).toHaveLength(2);
    expect(current().close).not.toHaveBeenCalled();
  });
  it.each(['stop', 'dispose', 'identity change'])('clears the watchdog on %s', async (action) => {
    const store = startLive();
    expect(vi.getTimerCount()).toBe(1);
    if (action === 'stop') store.stop();
    else if (action === 'dispose') store.$dispose();
    else auth.invalidateSession();
    await flushPromises();
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(60000);
    expect(FakeSocket.instances).toHaveLength(1);
    expect(fetch).not.toHaveBeenCalled();
  });
});

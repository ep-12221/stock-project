import { createPinia, disposePinia, setActivePinia } from 'pinia';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { useAccountStore } from '../stores/account.js';
import { useMarketStore } from '../stores/market.js';
import { snapshot, quote } from './trading-fixture.js';
let pinia: ReturnType<typeof createPinia>;
beforeEach(() => {
  pinia = createPinia();
  setActivePinia(pinia);
});
afterEach(() => disposePinia(pinia));
const owner = { userId: 'alice', serverEpoch: 'epoch' };
it('applies a full initial account snapshot including version zero', () => {
  const store = useAccountStore();
  expect(store.applySnapshot(snapshot(0), owner)).toBe(true);
  expect(store.snapshot).toEqual(snapshot(0));
});
it.each([1, 2])('ignores account version %s after version 2', (version) => {
  const store = useAccountStore();
  store.applySnapshot(snapshot(2), owner);
  const stale = snapshot(version);
  stale.account.cashBalanceCents = 1;
  expect(store.applySnapshot(stale, owner)).toBe(false);
  expect(store.snapshot?.account.cashBalanceCents).toBe(100000000);
});
it.each([{ userId: 'bravo' }, { serverEpoch: 'restarted' }])(
  'rejects unrelated account identity %j',
  (change) => {
    const store = useAccountStore();
    store.applySnapshot(snapshot(2), owner);
    expect(store.applySnapshot({ ...snapshot(3), ...change }, owner)).toBe(false);
    expect(store.snapshot).toEqual(snapshot(2));
  },
);
it('atomically replaces every account field on a newer version', () => {
  const store = useAccountStore();
  store.applySnapshot(snapshot(1), owner);
  const next = snapshot(2);
  next.account.frozenCashCents = 100;
  next.positions = [{ symbol: 'SIM001', quantity: 1, frozenQuantity: 0, availableQuantity: 1 }];
  store.applySnapshot(next, owner);
  expect(store.snapshot).toEqual(next);
  store.reset();
  expect(store.snapshot).toBeNull();
});
it('keeps newer market prices and rejects a different process', () => {
  const store = useMarketStore();
  const latest = { serverEpoch: 'epoch', marketVersion: 2, quotes: [quote()] };
  expect(store.applySnapshot(latest, 'epoch')).toBe(true);
  expect(store.applySnapshot({ ...latest, marketVersion: 1, quotes: [] }, 'epoch')).toBe(false);
  expect(store.applySnapshot({ ...latest, serverEpoch: 'other', marketVersion: 3 }, 'epoch')).toBe(
    false,
  );
  expect(store.quotes).toEqual(latest.quotes);
  store.reset();
  expect(store.quotes).toEqual([]);
});

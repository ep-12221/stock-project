import { INITIAL_CASH_CENTS, STOCKS } from '@stock/shared';
import { describe, expect, it } from 'vitest';
import { initializeLiquidity } from '../store/liquidity-seed.js';
import { createMemoryStore as createStore } from '../store/memory-store.js';
import { createTradingService } from '../services/trading.service.js';
import { SYSTEM_USER_ID } from '../store/seed.js';
import { expectInvariants, fixture as createFixture, state, totals } from './trading-fixture.js';

describe.each(['array', 'price-tree'] as const)(
  'finite startup liquidity (%s)',
  (matchingEngine) => {
    const createMemoryStore = (options: Parameters<typeof createStore>[0] = {}) =>
      createStore({ ...options, matchingEngine });
    const fixture = () => createFixture({ matchingEngine });
    it('creates six genuine OPEN orders through the engine with exact reservations and no trades', () => {
      const store = createMemoryStore({ now: () => 1_700_000_000_000 });
      const before = totals(store);
      initializeLiquidity(store);
      expect(store.liquiditySeeded).toBe(true);
      expect(store.orders.size).toBe(6);
      expect(store.orderSequence).toBe(6);
      expect(store.marketVersion).toBe(6);
      expect(store.accounts.get(SYSTEM_USER_ID)).toMatchObject({
        cashBalanceCents: INITIAL_CASH_CENTS,
        frozenCashCents: 5_997_000,
        version: 6,
      });
      for (const { symbol, initialPriceCents } of STOCKS) {
        expect(store.stocks.get(symbol)).toMatchObject({
          bestBidCents: initialPriceCents - 1,
          bestAskCents: initialPriceCents + 1,
        });
        const orders = [...store.orders.values()].filter((o) => o.symbol === symbol);
        expect(orders.map((o) => [o.side, o.priceCents, o.quantity, o.userId, o.status])).toEqual([
          ['BUY', initialPriceCents - 1, 1_000, SYSTEM_USER_ID, 'OPEN'],
          ['SELL', initialPriceCents + 1, 1_000, SYSTEM_USER_ID, 'OPEN'],
        ]);
        expect(store.positions.get(SYSTEM_USER_ID)?.get(symbol)).toMatchObject({
          quantity: 10_000,
          frozenQuantity: 1_000,
        });
      }
      expect(store.trades.size).toBe(0);
      expect(totals(store)).toEqual(before);
      expectInvariants(store);
    });

    it('leaves raw stores unseeded so unit tests can construct isolated books', () => {
      const store = createMemoryStore();
      expect(store.orders.size).toBe(0);
      expect(store.liquiditySeeded).toBe(false);
      expect(store.accounts.get(SYSTEM_USER_ID)?.frozenCashCents).toBe(0);
    });

    it('is idempotent before and after a seed order is fully consumed; never replenishes liquidity', () => {
      const { store, submit } = fixture();
      initializeLiquidity(store);
      const first = state(store);
      initializeLiquidity(store);
      expect(state(store)).toEqual(first);
      submit('alice', 'BUY', 1_001, 1_000);
      expect(store.stocks.get('SIM001')?.bestAskCents).toBeNull();
      const consumed = state(store);
      initializeLiquidity(store);
      expect(state(store)).toEqual(consumed);
      expect(store.positions.get(SYSTEM_USER_ID)?.get('SIM001')?.quantity).toBe(9_000);
    });

    it('rolls back all six seed commands if a later symbol cannot be funded', () => {
      const store = createMemoryStore();
      store.positions.get(SYSTEM_USER_ID)!.get('SIM003')!.quantity = 999;
      const before = state(store);
      expect(() => initializeLiquidity(store)).toThrow(
        expect.objectContaining({ code: 'INSUFFICIENT_POSITION' }),
      );
      expect(state(store)).toEqual(before);
      store.positions.get(SYSTEM_USER_ID)!.get('SIM003')!.quantity = 1_000;
      initializeLiquidity(store);
      expect(store.orders.size).toBe(6);
      expectInvariants(store);
    });

    it('does not start seed initialization in a market with pre-existing orders', () => {
      const store = createMemoryStore();
      createTradingService(store).submitLimitOrder(SYSTEM_USER_ID, {
        symbol: 'SIM001',
        side: 'BUY',
        priceCents: 900,
        quantity: 1,
      });
      const before = state(store);
      expect(() => initializeLiquidity(store)).toThrow();
      expect(state(store)).toEqual(before);
    });

    it('creates fresh seed inventory and independent books after restart', () => {
      const first = createMemoryStore();
      const second = createMemoryStore();
      initializeLiquidity(first);
      initializeLiquidity(second);
      expect(first.serverEpoch).not.toBe(second.serverEpoch);
      expect(first.orders.keys().next().value).not.toBe(second.orders.keys().next().value);
      expect(second.accounts.get(SYSTEM_USER_ID)?.frozenCashCents).toBe(5_997_000);
      expect(first.orderBooks.get('SIM001')).not.toBe(second.orderBooks.get('SIM001'));
    });
  },
);

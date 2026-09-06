import { describe, expect, it } from 'vitest';
import { accountSnapshot, stockSnapshot } from '../services/account.service.js';
import { fixture as createFixture, SYMBOL, state } from './trading-fixture.js';

describe.each(['array', 'price-tree'] as const)(
  'account snapshots after matching (%s)',
  (matchingEngine) => {
    const fixture = (options: Parameters<typeof createFixture>[0] = {}) =>
      createFixture({ ...options, matchingEngine });
    it('exposes current private orders, trade sides, actual assets and updated versions without internal identities', () => {
      const { store, submit } = fixture();
      const sell = submit('bob', 'SELL', 1_000, 10).order;
      const buy = submit('alice', 'BUY', 1_020, 4).order;
      const buyer = accountSnapshot(store, 'alice');
      const seller = accountSnapshot(store, 'bob');
      expect(buyer.activeOrders).toEqual([]);
      expect(buyer.recentClosedOrders).toHaveLength(1);
      expect(buyer.recentClosedOrders[0]).toMatchObject({ id: buy.id, status: 'FILLED' });
      expect(buyer.recentTrades[0]).toMatchObject({
        side: 'BUY',
        orderId: buy.id,
        priceCents: 1_000,
        quantity: 4,
      });
      expect(seller.activeOrders[0]).toMatchObject({
        id: sell.id,
        status: 'PARTIALLY_FILLED',
        filledQuantity: 4,
      });
      expect(seller.recentTrades[0]).toMatchObject({ side: 'SELL', orderId: sell.id });
      expect(seller.positions.find((p) => p.symbol === SYMBOL)).toMatchObject({
        quantity: 996,
        frozenQuantity: 6,
        availableQuantity: 990,
      });
      expect(seller.accountVersion).toBe(2);
      expect(buyer.accountVersion).toBe(1);
      expect(accountSnapshot(store, 'dave').recentTrades).toEqual([]);
      for (const snapshot of [buyer, seller]) {
        for (const order of [...snapshot.activeOrders, ...snapshot.recentClosedOrders]) {
          expect(Object.keys(order).sort()).toEqual(
            [
              'id',
              'symbol',
              'side',
              'priceCents',
              'quantity',
              'filledQuantity',
              'executedValueCents',
              'status',
              'sequence',
              'createdAt',
              'updatedAt',
            ].sort(),
          );
        }
        for (const trade of snapshot.recentTrades) {
          expect(Object.keys(trade).sort()).toEqual(
            [
              'id',
              'sequence',
              'symbol',
              'priceCents',
              'quantity',
              'executedAt',
              'side',
              'orderId',
            ].sort(),
          );
        }
      }
    });

    it('returns all active orders, 100 newest closed orders and 50 newest trades sorted by sequence', () => {
      const { store, submit } = fixture({ maxActiveOrdersPerUser: 200 });
      for (let i = 0; i < 105; i++) {
        submit('bob', 'SELL', 1_000, 1);
        submit('alice', 'BUY', 1_000, 1);
      }
      for (let i = 0; i < 101; i++) submit('alice', 'BUY', 900, 1);
      const result = accountSnapshot(store, 'alice');
      expect(result.activeOrders).toHaveLength(101);
      expect(result.recentClosedOrders).toHaveLength(100);
      expect(result.recentTrades).toHaveLength(50);
      expect(result.activeOrders[0]?.sequence).toBe(311);
      expect(result.recentClosedOrders[0]?.sequence).toBe(210);
      expect(result.recentClosedOrders.at(-1)?.sequence).toBe(12);
      expect(result.recentTrades[0]?.sequence).toBe(105);
      expect(result.recentTrades.at(-1)?.sequence).toBe(56);
    });

    it('returns detached snapshot records and book quotes', () => {
      const { store, submit } = fixture();
      submit('bob', 'SELL', 1_000, 10);
      submit('alice', 'BUY', 1_000, 5);
      const before = state(store);
      const result = accountSnapshot(store, 'bob');
      result.activeOrders[0]!.filledQuantity = 999;
      result.recentTrades[0]!.priceCents = 999;
      result.positions[0]!.quantity = 999;
      const quotes = stockSnapshot(store);
      expect(quotes.quotes[0]?.bestAskCents).toBe(1_000);
      quotes.quotes[0]!.bestAskCents = 2;
      expect(state(store)).toEqual(before);
    });
  },
);

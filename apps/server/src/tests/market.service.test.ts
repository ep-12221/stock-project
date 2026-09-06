import { MAX_PRICE_CENTS } from '@stock/shared';
import { describe, expect, it } from 'vitest';
import { createMarketService, marketSnapshot } from '../services/market.service.js';
import { fixture, state } from './trading-fixture.js';

describe('server-owned simulated market', () => {
  it('updates all quotes once with signed nonzero basis points and keeps previous close fixed', () => {
    const { store } = fixture();
    const values = [0, 0.499, 0.999];
    const market = createMarketService(store, { random: () => values.shift()! });
    store.now = () => 1_700_000_001_000;
    const before = [...store.stocks.values()].map((quote) => ({ ...quote }));
    const result = market.tick();
    expect(result.marketVersion).toBe(1);
    expect(result.quotes.map((q) => q.lastPriceCents)).toEqual(
      before.map(
        (quote, i) =>
          quote.lastPriceCents +
          (i === 0
            ? -2
            : i === 1
              ? -1
              : Math.max(1, Math.round((quote.lastPriceCents * 20) / 10_000))),
      ),
    );
    for (const [i, quote] of result.quotes.entries()) {
      expect(quote.previousCloseCents).toBe(before[i]!.previousCloseCents);
      expect(quote.changePercent).toBe(
        ((quote.lastPriceCents - quote.previousCloseCents) / quote.previousCloseCents) * 100,
      );
      expect(quote.updatedAt).toBe('2023-11-14T22:13:21.000Z');
      expect(Number.isSafeInteger(quote.lastPriceCents)).toBe(true);
    }
  });

  it.each([
    [1, 0, 1],
    [1, 0.5, 2],
    [MAX_PRICE_CENTS, 0.999, MAX_PRICE_CENTS],
    [2, 0.499, 1],
  ])('keeps price %s in bounds for random %s', (price, random, expected) => {
    const { store } = fixture();
    store.stocks.get('SIM001')!.lastPriceCents = price!;
    createMarketService(store, { random: () => random! }).tick();
    expect(store.stocks.get('SIM001')!.lastPriceCents).toBe(expected);
  });

  it('never changes assets, order-book prices, orders or trades', () => {
    const { store, submit } = fixture();
    submit('bob', 'SELL', 980, 10);
    submit('alice', 'BUY', 990, 4);
    const before = state(store);
    const market = createMarketService(store, { random: () => 0 });
    for (let i = 0; i < 20; i++) market.tick();
    const after = state(store);
    expect({ ...after, stocks: before.stocks, marketVersion: before.marketVersion }).toEqual(
      before,
    );
    expect(store.marketVersion).toBe(before.marketVersion + 20);
    expect(store.stocks.get('SIM001')!.bestAskCents).toBe(980);
  });

  it('returns only the latest 50 anonymous market trades, in descending order, as copies', () => {
    const { store, submit } = fixture();
    submit('bob', 'SELL', 1000, 60);
    for (let i = 0; i < 55; i++) submit('alice', 'BUY', 1000, 1);
    const result = marketSnapshot(store);
    expect(result.recentTrades).toHaveLength(50);
    expect(result.recentTrades.map((t) => t.sequence)).toEqual(
      Array.from({ length: 50 }, (_, i) => 55 - i),
    );
    expect(Object.keys(result.recentTrades[0]!).sort()).toEqual([
      'executedAt',
      'id',
      'priceCents',
      'quantity',
      'sequence',
      'symbol',
    ]);
    result.recentTrades[0]!.quantity = 999;
    result.quotes[0]!.lastPriceCents = 999;
    expect(store.trades.get(result.recentTrades[0]!.id)!.quantity).toBe(1);
    expect(store.stocks.get('SIM001')!.lastPriceCents).toBe(1000);
  });

  it.each([NaN, -1, 1, Infinity])(
    'rejects invalid random %s without a partial quote update',
    (bad) => {
      const { store } = fixture();
      const before = state(store);
      const values = [0, bad, 0];
      expect(() => createMarketService(store, { random: () => values.shift()! }).tick()).toThrow();
      expect(state(store)).toEqual(before);
    },
  );
});

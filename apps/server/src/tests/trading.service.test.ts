import { INITIAL_CASH_CENTS, MAX_ORDER_QUANTITY, MAX_PRICE_CENTS } from '@stock/shared';
import { describe, expect, it } from 'vitest';
import { SYSTEM_USER_ID } from '../store/seed.js';
import { expectInvariants, fixture as createFixture, SYMBOL, totals } from './trading-fixture.js';

describe.each(['array', 'price-tree'] as const)('limit order matching (%s)', (matchingEngine) => {
  const fixture = (options: Parameters<typeof createFixture>[0] = {}) =>
    createFixture({ ...options, matchingEngine });
  it('rests a non-crossing order, freezes the full limit amount and generates server metadata', () => {
    const { store, submit } = fixture();
    const result = submit('alice', 'BUY', 999, 20);
    expect(result.order).toMatchObject({
      userId: 'alice',
      symbol: SYMBOL,
      side: 'BUY',
      priceCents: 999,
      quantity: 20,
      filledQuantity: 0,
      executedValueCents: 0,
      status: 'OPEN',
      sequence: 1,
      createdAt: '2023-11-14T22:13:20.000Z',
      updatedAt: '2023-11-14T22:13:20.000Z',
    });
    expect(result.order.id).toBeTruthy();
    expect(result.trades).toEqual([]);
    expect(result.affectedUserIds).toEqual(['alice']);
    expect(store.accounts.get('alice')).toMatchObject({
      cashBalanceCents: INITIAL_CASH_CENTS,
      frozenCashCents: 19_980,
      version: 1,
    });
    expect(store.orderBooks.get(SYMBOL)?.buyOrderIds).toEqual([result.order.id]);
    expectInvariants(store);
  });

  it('freezes only stock for a resting sell; non-crossing bids do not cause a fill', () => {
    const { store, submit } = fixture();
    submit('bob', 'SELL', 1_001, 100);
    submit('alice', 'BUY', 1_000, 100);
    expect(store.positions.get('bob')?.get(SYMBOL)).toMatchObject({
      quantity: 1_000,
      frozenQuantity: 100,
    });
    expect(store.accounts.get('bob')?.cashBalanceCents).toBe(INITIAL_CASH_CENTS);
    expect(store.trades.size).toBe(0);
    expectInvariants(store);
  });

  it('matches the hand-calculated case: cheaper asks first and releases exactly 3,400 cents', () => {
    const { store, submit } = fixture();
    const baseline = totals(store);
    const expensive = submit('bob', 'SELL', 1_000, 100).order;
    const cheap = submit('carol', 'SELL', 980, 50).order;
    const result = submit('alice', 'BUY', 1_020, 120);
    expect(result.trades.map((t) => [t.sellOrderId, t.priceCents, t.quantity])).toEqual([
      [cheap.id, 980, 50],
      [expensive.id, 1_000, 70],
    ]);
    expect(result.order).toMatchObject({
      status: 'FILLED',
      filledQuantity: 120,
      executedValueCents: 119_000,
    });
    expect(store.accounts.get('alice')).toMatchObject({
      cashBalanceCents: INITIAL_CASH_CENTS - 119_000,
      frozenCashCents: 0,
    });
    expect(store.positions.get('alice')?.get(SYMBOL)?.quantity).toBe(120);
    expect(store.orders.get(expensive.id)).toMatchObject({
      status: 'PARTIALLY_FILLED',
      filledQuantity: 70,
      executedValueCents: 70_000,
    });
    expect(store.positions.get('bob')?.get(SYMBOL)).toMatchObject({
      quantity: 930,
      frozenQuantity: 30,
    });
    expect(store.accounts.get('carol')?.cashBalanceCents).toBe(INITIAL_CASH_CENTS + 49_000);
    expect(store.orders.get(cheap.id)?.status).toBe('FILLED');
    expect(totals(store)).toEqual(baseline);
    expectInvariants(store);
  });

  it('leaves the incoming buy remainder frozen at its own limit', () => {
    const { store, submit } = fixture();
    submit('bob', 'SELL', 1_000, 100);
    submit('carol', 'SELL', 980, 50);
    const result = submit('alice', 'BUY', 1_020, 200);
    expect(result.order).toMatchObject({
      status: 'PARTIALLY_FILLED',
      filledQuantity: 150,
      executedValueCents: 149_000,
    });
    expect(store.accounts.get('alice')).toMatchObject({
      cashBalanceCents: INITIAL_CASH_CENTS - 149_000,
      frozenCashCents: 51_000,
    });
    const book = store.orderBooks.get(SYMBOL)!;
    expect({ buyOrderIds: book.buyOrderIds, sellOrderIds: book.sellOrderIds }).toEqual({
      buyOrderIds: [result.order.id],
      sellOrderIds: [],
    });
    expectInvariants(store);
  });

  it('matches higher bids first, at each resting bid price, and freezes an incoming sell remainder', () => {
    const { store, submit } = fixture();
    const low = submit('alice', 'BUY', 1_000, 100).order;
    const high = submit('dave', 'BUY', 1_020, 50).order;
    const result = submit('bob', 'SELL', 980, 200);
    expect(result.trades.map((t) => [t.buyOrderId, t.priceCents, t.quantity])).toEqual([
      [high.id, 1_020, 50],
      [low.id, 1_000, 100],
    ]);
    expect(result.order).toMatchObject({
      status: 'PARTIALLY_FILLED',
      filledQuantity: 150,
      executedValueCents: 151_000,
    });
    expect(store.accounts.get('bob')?.cashBalanceCents).toBe(INITIAL_CASH_CENTS + 151_000);
    expect(store.positions.get('bob')?.get(SYMBOL)).toMatchObject({
      quantity: 850,
      frozenQuantity: 50,
    });
    expectInvariants(store);
  });

  it.each(['BUY', 'SELL'] as const)(
    'keeps FIFO priority for %s makers with identical timestamps after partial fills',
    (makerSide) => {
      const { store, submit } = fixture();
      const takerSide = makerSide === 'BUY' ? 'SELL' : 'BUY';
      const maker1 = makerSide === 'BUY' ? 'alice' : 'bob';
      const maker2 = makerSide === 'BUY' ? 'dave' : 'carol';
      const taker = makerSide === 'BUY' ? 'bob' : 'alice';
      const first = submit(maker1, makerSide, 1_000, 100).order;
      submit(taker, takerSide, 1_000, 40);
      const second = submit(maker2, makerSide, 1_000, 100).order;
      const result = submit(taker, takerSide, 1_000, 80);
      const makerIds = result.trades.map((t) =>
        makerSide === 'BUY' ? t.buyOrderId : t.sellOrderId,
      );
      expect(first.createdAt).toBe(second.createdAt);
      expect(first.sequence).toBeLessThan(second.sequence);
      expect(makerIds).toEqual([first.id, second.id]);
      expect(result.trades.map((t) => t.quantity)).toEqual([60, 20]);
      expect(store.orders.get(first.id)?.sequence).toBe(first.sequence);
      expectInvariants(store);
    },
  );

  it.each(['BUY', 'SELL'] as const)(
    'stops at the first price outside an incoming %s limit',
    (side) => {
      const { store, submit } = fixture();
      if (side === 'BUY') {
        submit('bob', 'SELL', 900, 10);
        submit('carol', 'SELL', 1_001, 10);
        const result = submit('alice', side, 1_000, 20);
        expect(result.trades.map((t) => [t.priceCents, t.quantity])).toEqual([[900, 10]]);
      } else {
        submit('alice', 'BUY', 1_100, 10);
        submit('dave', 'BUY', 999, 10);
        const result = submit('bob', side, 1_000, 20);
        expect(result.trades.map((t) => [t.priceCents, t.quantity])).toEqual([[1_100, 10]]);
      }
      expectInvariants(store);
    },
  );

  it('isolates books even when prices across symbols cross', () => {
    const { store, submit } = fixture();
    submit('bob', 'SELL', 1, 10, 'SIM002');
    submit('alice', 'BUY', 2_000, 10, SYMBOL);
    expect(store.trades.size).toBe(0);
    expect(store.stocks.get('SIM003')).toMatchObject({ bestBidCents: null, bestAskCents: null });
    expectInvariants(store);
  });

  it('supports a one-cent, one-share fill and creates a previously absent position', () => {
    const { store, submit } = fixture();
    store.positions.set('alice', new Map());
    submit('bob', 'SELL', 1, 1);
    const result = submit('alice', 'BUY', 1, 1);
    expect(result.trades[0]).toMatchObject({ priceCents: 1, quantity: 1 });
    expect(store.positions.get('alice')?.get(SYMBOL)).toMatchObject({
      quantity: 1,
      frozenQuantity: 0,
    });
    expectInvariants(store);
  });

  it('accepts the maximum price and quantity without integer truncation', () => {
    const { store, submit } = fixture();
    const nominal = MAX_PRICE_CENTS * MAX_ORDER_QUANTITY;
    store.accounts.get('alice')!.cashBalanceCents = nominal;
    store.positions.get('bob')!.get(SYMBOL)!.quantity = MAX_ORDER_QUANTITY;
    submit('bob', 'SELL', MAX_PRICE_CENTS, MAX_ORDER_QUANTITY);
    const result = submit('alice', 'BUY', MAX_PRICE_CENTS, MAX_ORDER_QUANTITY);
    expect(result.order.executedValueCents).toBe(1_000_000_000_000);
    expect(store.accounts.get('alice')?.cashBalanceCents).toBe(0);
    expect(store.positions.get('bob')?.get(SYMBOL)?.quantity).toBe(0);
    expectInvariants(store);
  });

  it('allows immediate resale of acquired stock through the same engine', () => {
    const { store, submit } = fixture();
    const baseline = totals(store);
    submit('bob', 'SELL', 1_000, 10);
    submit('alice', 'BUY', 1_000, 10);
    submit('dave', 'BUY', 990, 10);
    submit('alice', 'SELL', 990, 10);
    expect(store.positions.get('alice')?.get(SYMBOL)).toMatchObject({
      quantity: 0,
      frozenQuantity: 0,
    });
    expect(store.accounts.get('alice')?.cashBalanceCents).toBe(INITIAL_CASH_CENTS - 100);
    expect(totals(store)).toEqual(baseline);
    expectInvariants(store);
  });

  it('uses finite system inventory and does not replenish it when filled', () => {
    const { store, submit } = fixture();
    const baseline = totals(store);
    submit(SYSTEM_USER_ID, 'SELL', 1_001, 10_000);
    submit('alice', 'BUY', 1_001, 10_000);
    expect(store.positions.get(SYSTEM_USER_ID)?.get(SYMBOL)).toMatchObject({
      quantity: 0,
      frozenQuantity: 0,
    });
    expect(() => submit(SYSTEM_USER_ID, 'SELL', 1_001, 1)).toThrow(
      expect.objectContaining({ code: 'INSUFFICIENT_POSITION' }),
    );
    expect(totals(store)).toEqual(baseline);
    expectInvariants(store);
  });

  it('updates best prices and versions while preserving the simulated reference price', () => {
    const { store, submit } = fixture();
    store.stocks.get(SYMBOL)!.lastPriceCents = 8_765;
    submit('bob', 'SELL', 1_001, 10);
    expect(store.stocks.get(SYMBOL)?.bestAskCents).toBe(1_001);
    store.now = () => 1_700_000_001_000;
    submit('alice', 'BUY', 1_001, 10);
    expect(store.stocks.get(SYMBOL)).toMatchObject({
      bestBidCents: null,
      bestAskCents: null,
      lastPriceCents: 8_765,
      updatedAt: '2023-11-14T22:13:21.000Z',
    });
    expect(store.marketVersion).toBe(2);
    expectInvariants(store);
  });

  it('uses synchronous submission so two callbacks cannot spend the same available cash', async () => {
    const { store, submit } = fixture();
    store.accounts.get('alice')!.cashBalanceCents = 1_000;
    const results = await Promise.allSettled(
      [1, 2].map(() => Promise.resolve().then(() => submit('alice', 'BUY', 1_000, 1))),
    );
    expect(results.map((r) => r.status)).toEqual(['fulfilled', 'rejected']);
    expect(store.orders.size).toBe(1);
    expectInvariants(store);
  });
});

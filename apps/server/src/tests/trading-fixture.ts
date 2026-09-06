import { INITIAL_CASH_CENTS, STOCKS } from '@stock/shared';
import { expect } from 'vitest';
import { createMemoryStore, type MemoryStore, type MatchingEngine } from '../store/memory-store.js';
import { createTradingService } from '../services/trading.service.js';
import { PriceTreeOrderBook } from '../matching/price-tree-book.js';

export const SYMBOL = 'SIM001';
export function fixture(
  options: {
    maxActiveOrdersPerUser?: number;
    maxActiveOrders?: number;
    matchingEngine?: MatchingEngine;
  } = {},
) {
  const store = createMemoryStore({
    now: () => 1_700_000_000_000,
    matchingEngine: options.matchingEngine ?? 'price-tree',
  });
  for (const id of ['alice', 'bob', 'carol', 'dave']) {
    store.users.set(id, {
      id,
      username: id,
      kind: 'USER',
      passwordHash: '',
      passwordSalt: '',
      createdAt: new Date(store.now()).toISOString(),
    });
    store.accounts.set(id, {
      userId: id,
      cashBalanceCents: INITIAL_CASH_CENTS,
      frozenCashCents: 0,
      version: 0,
    });
    store.positions.set(
      id,
      new Map(
        STOCKS.map(({ symbol }) => [
          symbol,
          {
            userId: id,
            symbol,
            quantity: id === 'bob' || id === 'carol' ? 1_000 : 0,
            frozenQuantity: 0,
          },
        ]),
      ),
    );
  }
  const service = createTradingService(store, options);
  const submit = (
    userId: string,
    side: 'BUY' | 'SELL',
    priceCents: number,
    quantity: number,
    symbol = SYMBOL,
  ) => service.submitLimitOrder(userId, { symbol, side, priceCents, quantity });
  return { store, service, submit };
}
export function state(store: MemoryStore) {
  return structuredClone({ ...store, now: undefined });
}
export function totals(store: MemoryStore) {
  return {
    cash: [...store.accounts.values()].reduce((sum, a) => sum + BigInt(a.cashBalanceCents), 0n),
    shares: STOCKS.map(({ symbol }) =>
      [...store.positions.values()].reduce(
        (sum, positions) => sum + BigInt(positions.get(symbol)?.quantity ?? 0),
        0n,
      ),
    ),
  };
}
export function expectInvariants(store: MemoryStore) {
  const active = [...store.orders.values()].filter(
    (o) => o.status === 'OPEN' || o.status === 'PARTIALLY_FILLED',
  );
  expect(store.activeOrderCount).toBe(active.length);
  const bookIds: string[] = [];
  for (const [symbol, book] of store.orderBooks) {
    if (book instanceof PriceTreeOrderBook) book.assertValid((id) => store.orders.get(id)!);
    const buys = book.buyOrderIds.map((id) => store.orders.get(id)!);
    const sells = book.sellOrderIds.map((id) => store.orders.get(id)!);
    for (const [orders, side] of [
      [buys, 'BUY'],
      [sells, 'SELL'],
    ] as const) {
      for (const [i, order] of orders.entries()) {
        expect(order.symbol).toBe(symbol);
        expect(order.side).toBe(side);
        expect(order.filledQuantity).toBeLessThan(order.quantity);
        expect(['OPEN', 'PARTIALLY_FILLED']).toContain(order.status);
        if (i > 0) {
          const previous = orders[i - 1]!;
          if (previous.priceCents === order.priceCents)
            expect(previous.sequence).toBeLessThan(order.sequence);
          else if (side === 'BUY') expect(previous.priceCents).toBeGreaterThan(order.priceCents);
          else expect(previous.priceCents).toBeLessThan(order.priceCents);
        }
      }
    }
    if (buys[0] && sells[0]) expect(buys[0].priceCents).toBeLessThan(sells[0].priceCents);
    expect(store.stocks.get(symbol)).toMatchObject({
      bestBidCents: buys[0]?.priceCents ?? null,
      bestAskCents: sells[0]?.priceCents ?? null,
    });
    bookIds.push(...book.buyOrderIds, ...book.sellOrderIds);
  }
  expect(bookIds.sort()).toEqual(active.map((o) => o.id).sort());
  for (const [userId, account] of store.accounts) {
    expect(Number.isSafeInteger(account.cashBalanceCents)).toBe(true);
    expect(account.cashBalanceCents).toBeGreaterThanOrEqual(account.frozenCashCents);
    const mine = active.filter((o) => o.userId === userId);
    expect(account.frozenCashCents).toBe(
      mine
        .filter((o) => o.side === 'BUY')
        .reduce((sum, o) => sum + o.priceCents * (o.quantity - o.filledQuantity), 0),
    );
    expect([...(store.activeOrdersByUser.get(userId) ?? [])].sort()).toEqual(
      mine.map((o) => o.id).sort(),
    );
    expect(store.ordersByUser.get(userId) ?? []).toEqual(
      [...store.orders.values()].filter((o) => o.userId === userId).map((o) => o.id),
    );
    expect(store.tradesByUser.get(userId) ?? []).toEqual(
      [...store.trades.values()]
        .filter((t) => t.buyerUserId === userId || t.sellerUserId === userId)
        .map((t) => t.id),
    );
    for (const [symbol, position] of store.positions.get(userId) ?? []) {
      expect(Number.isSafeInteger(position.quantity)).toBe(true);
      expect(position.quantity).toBeGreaterThanOrEqual(position.frozenQuantity);
      expect(position.frozenQuantity).toBe(
        mine
          .filter((o) => o.side === 'SELL' && o.symbol === symbol)
          .reduce((sum, o) => sum + o.quantity - o.filledQuantity, 0),
      );
    }
  }
  expect(store.marketTradeIds).toEqual([...store.trades.keys()]);
  for (const order of store.orders.values()) {
    const trades = [...store.trades.values()].filter(
      (t) => t.buyOrderId === order.id || t.sellOrderId === order.id,
    );
    expect(order.filledQuantity).toBe(trades.reduce((sum, t) => sum + t.quantity, 0));
    expect(order.executedValueCents).toBe(
      trades.reduce((sum, t) => sum + t.priceCents * t.quantity, 0),
    );
  }
  for (const trade of store.trades.values()) {
    const buy = store.orders.get(trade.buyOrderId)!;
    const sell = store.orders.get(trade.sellOrderId)!;
    expect(buy.userId).toBe(trade.buyerUserId);
    expect(sell.userId).toBe(trade.sellerUserId);
    expect(buy.userId).not.toBe(sell.userId);
    expect(buy.symbol).toBe(trade.symbol);
    expect(sell.symbol).toBe(trade.symbol);
    expect(trade.priceCents).toBe(buy.sequence < sell.sequence ? buy.priceCents : sell.priceCents);
    expect(trade.priceCents).toBeLessThanOrEqual(buy.priceCents);
    expect(trade.priceCents).toBeGreaterThanOrEqual(sell.priceCents);
  }
}

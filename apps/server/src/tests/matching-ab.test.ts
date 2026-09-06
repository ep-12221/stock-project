import { describe, expect, it } from 'vitest';
import { AppError } from '../domain/app-error.js';
import type { MemoryStore } from '../store/memory-store.js';
import type { SubmitOrderResult } from '../services/trading.service.js';
import { PriceTreeOrderBook } from '../matching/price-tree-book.js';
import { initializeLiquidity } from '../store/liquidity-seed.js';
import { fixture, state, expectInvariants, totals } from './trading-fixture.js';

// UUIDs/epochs identify independent runs; sequences identify the same logical orders/trades.
function normalized(store: MemoryStore) {
  const orderId = (id: string) => store.orders.get(id)!.sequence;
  const tradeId = (id: string) => store.trades.get(id)!.sequence;
  return {
    accounts: [...store.accounts],
    positions: [...store.positions],
    quotes: [...store.stocks],
    orders: [...store.orders.values()].map((order) => ({ ...order, id: order.sequence })),
    trades: [...store.trades.values()].map((trade) => ({
      ...trade,
      id: trade.sequence,
      buyOrderId: orderId(trade.buyOrderId),
      sellOrderId: orderId(trade.sellOrderId),
    })),
    books: [...store.orderBooks].map(([symbol, book]) => [
      symbol,
      book.buyOrderIds.map(orderId),
      book.sellOrderIds.map(orderId),
    ]),
    ordersByUser: [...store.ordersByUser].map(([id, ids]) => [id, ids.map(orderId)]),
    activeOrdersByUser: [...store.activeOrdersByUser].map(([id, ids]) => [
      id,
      [...ids].map(orderId),
    ]),
    tradesByUser: [...store.tradesByUser].map(([id, ids]) => [id, ids.map(tradeId)]),
    marketTrades: store.marketTradeIds.map(tradeId),
    idempotency: [...store.idempotentOrdersByUser].map(([user, requests]) => [
      user,
      [...requests].map(([key, result]) => [key, { ...result, orderId: orderId(result.orderId) }]),
    ]),
    orderSequence: store.orderSequence,
    tradeSequence: store.tradeSequence,
    marketVersion: store.marketVersion,
    activeOrderCount: store.activeOrderCount,
    liquiditySeeded: store.liquiditySeeded,
  };
}
function resultView(result: SubmitOrderResult, store: MemoryStore) {
  return {
    ...result,
    order: { ...result.order, id: result.order.sequence },
    trades: result.trades.map((trade) => ({
      ...trade,
      id: trade.sequence,
      buyOrderId: store.orders.get(trade.buyOrderId)!.sequence,
      sellOrderId: store.orders.get(trade.sellOrderId)!.sequence,
    })),
  };
}

describe('array/tree differential replay', () => {
  it.each([73, 809, 1601])(
    'produces identical states and failures for seeded stream %s',
    (seed) => {
      const a = fixture({ matchingEngine: 'array', maxActiveOrdersPerUser: 1000 });
      const b = fixture({ matchingEngine: 'price-tree', maxActiveOrdersPerUser: 1000 });
      initializeLiquidity(a.store);
      initializeLiquidity(b.store);
      const initial = totals(a.store);
      let value = seed;
      const random = (max: number) => {
        value ^= value << 13;
        value ^= value >>> 17;
        value ^= value << 5;
        return (value >>> 0) % max;
      };
      const requests: { user: string; input: Record<string, unknown> }[] = [];
      let successes = 0;
      let replays = 0;
      const failures = new Set<string>();
      for (let i = 0; i < 400; i++) {
        const previous = requests[random(Math.max(1, requests.length))];
        const replay = i % 7 === 0 && previous;
        const request = replay
          ? { user: previous.user, input: { ...previous.input } }
          : {
              user: ['alice', 'bob', 'carol', 'dave'][random(4)]!,
              input: {
                clientOrderId: '00000000-0000-4000-8000-' + i.toString(16).padStart(12, '0'),
                symbol: ['SIM001', 'SIM002', 'SIM003'][random(3)]!,
                side: random(2) ? 'BUY' : 'SELL',
                priceCents: 970 + random(2061),
                quantity: 1 + random(40),
              },
            };
        if (replay && i % 3 === 0) request.input.quantity = Number(request.input.quantity) + 1;
        if (i % 31 === 0) request.input.quantity = 0;
        requests.push(request);
        const outcomes = [a, b].map(({ store, service }) => {
          const before = state(store);
          try {
            const result = service.submitOrder(request.user, request.input);
            return { accepted: true, value: resultView(result, store) };
          } catch (error) {
            expect(error).toBeInstanceOf(AppError);
            const failure = error as AppError;
            expect(failure.code).not.toBe('INTERNAL_ERROR');
            expect(state(store)).toEqual(before);
            return { accepted: false, status: failure.status, code: failure.code };
          }
        });
        expect(outcomes[1], 'command ' + i).toEqual(outcomes[0]);
        const outcome = outcomes[0]!;
        if (outcome.accepted) {
          successes++;
          if (outcome.value?.replayed) replays++;
        } else if (outcome.code) failures.add(outcome.code);
        expect(normalized(b.store), 'state after command ' + i).toEqual(normalized(a.store));
        for (const book of b.store.orderBooks.values())
          (book as PriceTreeOrderBook).assertValid((id) => b.store.orders.get(id)!);
      }
      expect(successes).toBeGreaterThan(100);
      expect(replays).toBeGreaterThan(5);
      expect(failures).toContain('IDEMPOTENCY_CONFLICT');
      expect(failures).toContain('VALIDATION_ERROR');
      expect(a.store.trades.size).toBeGreaterThan(10);
      expect(totals(a.store)).toEqual(initial);
      expect(totals(b.store)).toEqual(initial);
      expectInvariants(a.store);
      expectInvariants(b.store);
    },
    30000,
  );
});

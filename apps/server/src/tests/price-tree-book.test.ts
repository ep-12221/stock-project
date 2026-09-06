import type { Side } from '@stock/shared';
import { describe, expect, it, vi } from 'vitest';
import type { Order } from '../domain/models.js';
import { PriceTreeOrderBook } from '../matching/price-tree-book.js';

function setup() {
  const book = new PriceTreeOrderBook('SIM001');
  const orders = new Map<string, Order>();
  let sequence = 0;
  const order = (side: Side, priceCents: number, quantity = 10, userId = 'maker'): Order => ({
    id: String(++sequence),
    sequence,
    symbol: 'SIM001',
    userId,
    side,
    priceCents,
    quantity,
    filledQuantity: 0,
    executedValueCents: 0,
    status: 'OPEN',
    createdAt: '2023-11-14T22:13:20.000Z',
    updatedAt: '2023-11-14T22:13:20.000Z',
  });
  const add = (side: Side, price: number) => {
    const item = order(side, price);
    book.prepare(item, new Map<string, Order>([[item.id, item]])).commit();
    orders.set(item.id, item);
    return item;
  };
  const snapshot = () => structuredClone(book);
  return { book, orders, order, add, snapshot };
}

describe('price levels and FIFO queues', () => {
  it.each(['BUY', 'SELL'] as const)(
    'indexes occupied prices and preserves %s FIFO order',
    (side) => {
      const { book, orders, add } = setup();
      const first = add(side, 1000);
      const second = add(side, 1000);
      const low = add(side, 900);
      const high = add(side, 1100);
      expect(book.levelCount(side)).toBe(3);
      expect(side === 'BUY' ? book.buyOrderIds : book.sellOrderIds).toEqual(
        side === 'BUY'
          ? [high.id, first.id, second.id, low.id]
          : [low.id, first.id, second.id, high.id],
      );
      book.assertValid((id) => orders.get(id)!);
    },
  );

  it('plans without mutations and never inspects orders beyond a non-crossing best price', () => {
    const { book, orders, add, order, snapshot } = setup();
    add('SELL', 1001);
    const before = snapshot();
    const get = vi.fn((id: string) => orders.get(id)!);
    expect(book.planMatches(order('BUY', 1000, 1, 'taker'), get)).toEqual([]);
    expect(get).not.toHaveBeenCalled();
    expect(snapshot()).toEqual(before);
  });

  it('keeps partial makers first and removes exhausted FIFO heads and price levels', () => {
    const { book, orders, add, order } = setup();
    const first = add('SELL', 1000);
    const second = add('SELL', 1000);
    const last = add('SELL', 1001);
    const taker = order('BUY', 1001, 5, 'taker');
    expect(book.planMatches(taker, (id) => orders.get(id)!)).toEqual([
      { makerOrderId: first.id, priceCents: 1000, quantity: 5 },
    ]);
    const partial = {
      ...first,
      filledQuantity: 5,
      executedValueCents: 5000,
      status: 'PARTIALLY_FILLED' as const,
    };
    const filledTaker = {
      ...taker,
      filledQuantity: 5,
      executedValueCents: 5000,
      status: 'FILLED' as const,
    };
    book
      .prepare(
        filledTaker,
        new Map<string, Order>([
          [first.id, partial],
          [taker.id, filledTaker],
        ]),
      )
      .commit();
    orders.set(first.id, partial);
    expect(book.sellOrderIds).toEqual([first.id, second.id, last.id]);
    const sweep = order('BUY', 1001, 25, 'taker');
    const fills = book.planMatches(sweep, (id) => orders.get(id)!);
    expect(fills.map((fill) => fill.quantity)).toEqual([5, 10, 10]);
    const changes = new Map<string, Order>();
    for (const fill of fills) {
      const maker = orders.get(fill.makerOrderId)!;
      changes.set(maker.id, {
        ...maker,
        filledQuantity: maker.quantity,
        executedValueCents: maker.quantity * maker.priceCents,
        status: 'FILLED',
      });
    }
    const completed = {
      ...sweep,
      filledQuantity: 25,
      executedValueCents: 25010,
      status: 'FILLED' as const,
    };
    changes.set(completed.id, completed);
    const update = book.prepare(completed, changes);
    expect(update.bestAskCents).toBeNull();
    expect(book.bestPrice('SELL')).toBe(1000);
    update.commit();
    for (const [id, item] of changes) orders.set(id, item);
    expect(book.levelCount('SELL')).toBe(0);
    expect(book.sellOrderIds).toEqual([]);
    book.assertValid((id) => orders.get(id)!);
  });

  it('rejects self crossing after earlier planned liquidity without modifying the book', () => {
    const { book, orders, add, order, snapshot } = setup();
    const external = add('SELL', 999);
    orders.set(external.id, { ...external, userId: 'external' });
    add('SELL', 1000);
    const before = snapshot();
    expect(() => book.planMatches(order('BUY', 1000, 15), (id) => orders.get(id)!)).toThrow(
      expect.objectContaining({ code: 'SELF_TRADE_PREVENTED' }),
    );
    expect(snapshot()).toEqual(before);
  });

  it('rejects stale or repeated prepared updates before changing links or prices', () => {
    const { book, add, order, snapshot } = setup();
    const pending = order('BUY', 900);
    const update = book.prepare(pending, new Map<string, Order>([[pending.id, pending]]));
    add('BUY', 901);
    const before = snapshot();
    expect(() => update.commit()).toThrow();
    expect(snapshot()).toEqual(before);
    const next = order('BUY', 902);
    const fresh = book.prepare(next, new Map<string, Order>([[next.id, next]]));
    fresh.commit();
    const after = snapshot();
    expect(() => fresh.commit()).toThrow();
    expect(snapshot()).toEqual(after);
  });
});

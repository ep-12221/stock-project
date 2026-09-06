import type { Side } from '@stock/shared';
import type { Order, OrderBook } from '../domain/models.js';
import { AppError } from '../domain/app-error.js';
import { AvlPriceTree } from './avl-price-tree.js';
import { integer, invariant } from './checked.js';
import { isActive, type PlannedFill } from './order-book.js';
import { assertOrder } from './settlement.js';

interface PriceLevel {
  priceCents: number;
  side: Side;
  head: OrderLink | null;
  tail: OrderLink | null;
  size: number;
}
interface OrderLink {
  id: string;
  sequence: number;
  level: PriceLevel;
  previous: OrderLink | null;
  next: OrderLink | null;
}
export interface PreparedBookUpdate {
  bestBidCents: number | null;
  bestAskCents: number | null;
  commit(): void;
}

/** Two AVL indexes of occupied prices, with FIFO links inside each price level. */
export class PriceTreeOrderBook implements OrderBook {
  private readonly buys = new AvlPriceTree<PriceLevel>();
  private readonly sells = new AvlPriceTree<PriceLevel>();
  private readonly links = new Map<string, OrderLink>();
  private revision = 0;

  constructor(readonly symbol: string) {}

  /** Detached ordered views for diagnostics and compatibility; never used for matching. */
  get buyOrderIds(): string[] {
    return [...this.ids('BUY')];
  }
  get sellOrderIds(): string[] {
    return [...this.ids('SELL')];
  }
  get size() {
    return this.links.size;
  }
  levelCount(side: Side): number {
    return this.tree(side).size;
  }
  bestPrice(side: Side): number | null {
    return side === 'BUY' ? this.buys.maxKey : this.sells.minKey;
  }
  private tree(side: Side): AvlPriceTree<PriceLevel> {
    return side === 'BUY' ? this.buys : this.sells;
  }
  private *ids(side: Side): IterableIterator<string> {
    for (const [, level] of this.tree(side).entries(side === 'BUY')) {
      let link = level.head;
      while (link) {
        yield link.id;
        link = link.next;
      }
    }
  }

  planMatches(
    incoming: Pick<Order, 'userId' | 'symbol' | 'side' | 'priceCents' | 'quantity'>,
    getOrder: (id: string) => Order,
  ): PlannedFill[] {
    invariant(incoming.symbol === this.symbol);
    const opposite = incoming.side === 'BUY' ? 'SELL' : 'BUY';
    const crosses = (price: number) =>
      incoming.side === 'BUY' ? incoming.priceCents >= price : incoming.priceCents <= price;
    const best = this.bestPrice(opposite);
    if (best === null || !crosses(best)) return [];
    const fills: PlannedFill[] = [];
    let remaining = incoming.quantity;
    for (const [price, level] of this.tree(opposite).entries(opposite === 'BUY')) {
      if (!crosses(price)) break;
      for (let link = level.head; link && remaining > 0; link = link.next) {
        const maker = getOrder(link.id);
        this.assertLink(link, maker);
        if (maker.userId === incoming.userId)
          throw new AppError(
            409,
            'SELF_TRADE_PREVENTED',
            '委托将与自己的挂单成交，请调整价格或数量',
          );
        const quantity = Math.min(remaining, integer(maker.quantity - maker.filledQuantity));
        fills.push({ makerOrderId: maker.id, priceCents: price, quantity });
        remaining -= quantity;
      }
      if (remaining === 0) break;
    }
    return fills;
  }

  /** Stage only touched links. All business validation happens before commit is called. */
  prepare(incoming: Order, changed: ReadonlyMap<string, Order>): PreparedBookUpdate {
    assertOrder(incoming);
    invariant(incoming.symbol === this.symbol && !this.links.has(incoming.id));
    invariant(changed.get(incoming.id) === incoming);
    const expectedRevision = this.revision;
    const nextRevision = integer(this.revision + 1);
    const removed: OrderLink[] = [];
    for (const [id, order] of changed) {
      if (id === incoming.id) continue;
      const link = this.links.get(id);
      invariant(link && order.id === id && order.side !== incoming.side);
      assertOrder(order);
      invariant(order.symbol === this.symbol && order.priceCents === link.level.priceCents);
      invariant(order.sequence === link.sequence && order.side === link.level.side);
      if (!isActive(order)) removed.push(link);
    }
    let append: OrderLink | null = null;
    if (isActive(incoming)) {
      const level = this.tree(incoming.side).get(incoming.priceCents) ?? {
        priceCents: incoming.priceCents,
        side: incoming.side,
        head: null,
        tail: null,
        size: 0,
      };
      invariant(!level.tail || level.tail.sequence < incoming.sequence);
      append = { id: incoming.id, sequence: incoming.sequence, level, previous: null, next: null };
    }
    const opposite = incoming.side === 'BUY' ? 'SELL' : 'BUY';
    let oppositeBest = this.bestPrice(opposite);
    if (removed.length) {
      oppositeBest = null;
      for (const id of this.ids(opposite)) {
        const replacement = changed.get(id);
        if (!replacement || isActive(replacement)) {
          oppositeBest = this.links.get(id)!.level.priceCents;
          break;
        }
      }
    }
    let ownBest = this.bestPrice(incoming.side);
    if (append)
      ownBest =
        ownBest === null
          ? incoming.priceCents
          : incoming.side === 'BUY'
            ? Math.max(ownBest, incoming.priceCents)
            : Math.min(ownBest, incoming.priceCents);
    const bestBidCents = incoming.side === 'BUY' ? ownBest : oppositeBest;
    const bestAskCents = incoming.side === 'SELL' ? ownBest : oppositeBest;
    invariant(bestBidCents === null || bestAskCents === null || bestBidCents < bestAskCents);
    let committed = false;
    return {
      bestBidCents,
      bestAskCents,
      commit: () => {
        // A rejected stale plan must not modify either queue links or the price indexes.
        invariant(!committed && this.revision === expectedRevision);
        committed = true;
        for (const link of removed) this.remove(link);
        if (append) this.append(append);
        this.revision = nextRevision;
      },
    };
  }

  private append(link: OrderLink): void {
    const level = link.level;
    if (level.tail) {
      link.previous = level.tail;
      level.tail.next = link;
    } else {
      level.head = link;
      this.tree(level.side).set(level.priceCents, level);
    }
    level.tail = link;
    level.size++;
    this.links.set(link.id, link);
  }
  private remove(link: OrderLink): void {
    const level = link.level;
    if (link.previous) link.previous.next = link.next;
    else level.head = link.next;
    if (link.next) link.next.previous = link.previous;
    else level.tail = link.previous;
    level.size--;
    this.links.delete(link.id);
    if (level.size === 0) this.tree(level.side).delete(level.priceCents);
  }
  private assertLink(link: OrderLink, order: Order): void {
    assertOrder(order);
    invariant(isActive(order) && order.id === link.id && order.symbol === this.symbol);
    invariant(order.side === link.level.side && order.priceCents === link.level.priceCents);
    invariant(order.sequence === link.sequence && this.links.get(link.id) === link);
  }

  /** Full audit belongs in correctness tests, not in the timed matching path. */
  assertValid(getOrder: (id: string) => Order): void {
    const ids = new Set<string>();
    for (const side of ['BUY', 'SELL'] as const) {
      const tree = this.tree(side);
      tree.assertValid();
      for (const [price, level] of tree.entries()) {
        invariant(level.side === side && level.priceCents === price && level.size > 0);
        let previous: OrderLink | null = null;
        let count = 0;
        for (let link = level.head; link; link = link.next) {
          invariant(!ids.has(link.id) && link.level === level && link.previous === previous);
          invariant(!previous || previous.sequence < link.sequence);
          this.assertLink(link, getOrder(link.id));
          ids.add(link.id);
          previous = link;
          count++;
        }
        invariant(previous === level.tail && count === level.size);
      }
    }
    invariant(ids.size === this.links.size);
    const bid = this.bestPrice('BUY');
    const ask = this.bestPrice('SELL');
    invariant(bid === null || ask === null || bid < ask);
  }
}

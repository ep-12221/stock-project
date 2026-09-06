import { MAX_ORDER_QUANTITY, MAX_PRICE_CENTS } from '@stock/shared';
import type { Account, Order, Position } from '../domain/models.js';
import { AppError } from '../domain/app-error.js';
import type { MemoryStore } from '../store/memory-store.js';
import { integer, invariant } from './checked.js';
import { isActive } from './order-book.js';

export interface SettlementDraft {
  accounts: Map<string, Account>;
  positions: Map<string, Map<string, Position>>;
  activeOrdersByUser: Map<string, Set<string>>;
}

export function assertOrder(order: Order): void {
  invariant(order.side === 'BUY' || order.side === 'SELL');
  invariant(integer(order.priceCents) > 0 && order.priceCents <= MAX_PRICE_CENTS);
  invariant(integer(order.quantity) > 0 && order.quantity <= MAX_ORDER_QUANTITY);
  invariant(integer(order.filledQuantity) <= order.quantity);
  integer(order.executedValueCents);
  invariant(integer(order.sequence) > 0);
  if (order.filledQuantity === 0) {
    invariant(order.status === 'OPEN' && order.executedValueCents === 0);
  } else {
    invariant(order.executedValueCents > 0);
    invariant(
      order.status === (order.filledQuantity === order.quantity ? 'FILLED' : 'PARTIALLY_FILLED'),
    );
  }
}

/** Validate full reservations for affected users, including orders on other symbols. */
export function assertReservations(draft: SettlementDraft, getOrder: (id: string) => Order): void {
  for (const [userId, account] of draft.accounts) {
    invariant(account.userId === userId);
    invariant(integer(account.cashBalanceCents) >= integer(account.frozenCashCents));
    integer(account.version);
    let expectedCash = 0;
    const expectedStock = new Map<string, number>();
    for (const id of draft.activeOrdersByUser.get(userId) ?? []) {
      const order = getOrder(id);
      assertOrder(order);
      invariant(order.userId === userId && isActive(order));
      const remaining = integer(order.quantity - order.filledQuantity);
      if (order.side === 'BUY') {
        expectedCash = integer(expectedCash + integer(order.priceCents * remaining));
      } else {
        expectedStock.set(
          order.symbol,
          integer((expectedStock.get(order.symbol) ?? 0) + remaining),
        );
      }
    }
    invariant(account.frozenCashCents === expectedCash);
    const positions = draft.positions.get(userId)!;
    for (const [symbol, position] of positions) {
      invariant(position.userId === userId && position.symbol === symbol);
      invariant(integer(position.quantity) >= integer(position.frozenQuantity));
      invariant(position.frozenQuantity === (expectedStock.get(symbol) ?? 0));
    }
    for (const symbol of expectedStock.keys()) invariant(positions.has(symbol));
  }
}

export function createSettlementDraft(
  store: MemoryStore,
  userIds: readonly string[],
): SettlementDraft {
  const draft: SettlementDraft = {
    accounts: new Map(),
    positions: new Map(),
    activeOrdersByUser: new Map(),
  };
  for (const userId of userIds) {
    const account = store.accounts.get(userId);
    invariant(account && store.users.has(userId));
    draft.accounts.set(userId, { ...account });
    draft.positions.set(
      userId,
      new Map(
        [...(store.positions.get(userId) ?? [])].map(([symbol, position]) => [
          symbol,
          { ...position },
        ]),
      ),
    );
    draft.activeOrdersByUser.set(userId, new Set(store.activeOrdersByUser.get(userId)));
  }
  assertReservations(draft, (id) => {
    const order = store.orders.get(id);
    invariant(order);
    return order;
  });
  return draft;
}

function positionFor(draft: SettlementDraft, userId: string, symbol: string): Position {
  const positions = draft.positions.get(userId)!;
  let position = positions.get(symbol);
  if (!position) {
    position = { userId, symbol, quantity: 0, frozenQuantity: 0 };
    positions.set(symbol, position);
  }
  return position;
}

export function freezeOrder(draft: SettlementDraft, order: Order): void {
  if (order.side === 'BUY') {
    const account = draft.accounts.get(order.userId)!;
    const nominal = integer(order.priceCents * order.quantity);
    if (integer(account.cashBalanceCents - account.frozenCashCents) < nominal) {
      throw new AppError(409, 'INSUFFICIENT_FUNDS', '可用资金不足');
    }
    account.frozenCashCents = integer(account.frozenCashCents + nominal);
  } else {
    const position = positionFor(draft, order.userId, order.symbol);
    if (integer(position.quantity - position.frozenQuantity) < order.quantity) {
      throw new AppError(409, 'INSUFFICIENT_POSITION', '可用持仓不足');
    }
    position.frozenQuantity = integer(position.frozenQuantity + order.quantity);
  }
}

/** Mutates detached drafts only. Price improvement is released via frozen cash, never a second refund. */
export function settleFill(
  draft: SettlementDraft,
  buy: Order,
  sell: Order,
  priceCents: number,
  quantity: number,
  executedAt: string,
): void {
  invariant(buy.userId !== sell.userId && buy.symbol === sell.symbol);
  invariant(buy.side === 'BUY' && sell.side === 'SELL');
  invariant(priceCents <= buy.priceCents && priceCents >= sell.priceCents);
  invariant(
    integer(quantity) > 0 &&
      quantity <= buy.quantity - buy.filledQuantity &&
      quantity <= sell.quantity - sell.filledQuantity,
  );
  const value = integer(priceCents * quantity);
  const buyer = draft.accounts.get(buy.userId)!;
  const seller = draft.accounts.get(sell.userId)!;
  const bought = positionFor(draft, buy.userId, buy.symbol);
  const sold = positionFor(draft, sell.userId, sell.symbol);
  buyer.cashBalanceCents = integer(buyer.cashBalanceCents - value);
  buyer.frozenCashCents = integer(buyer.frozenCashCents - integer(buy.priceCents * quantity));
  seller.cashBalanceCents = integer(seller.cashBalanceCents + value);
  bought.quantity = integer(bought.quantity + quantity);
  sold.quantity = integer(sold.quantity - quantity);
  sold.frozenQuantity = integer(sold.frozenQuantity - quantity);
  for (const order of [buy, sell]) {
    order.filledQuantity = integer(order.filledQuantity + quantity);
    order.executedValueCents = integer(order.executedValueCents + value);
    order.status = order.filledQuantity === order.quantity ? 'FILLED' : 'PARTIALLY_FILLED';
    order.updatedAt = executedAt;
  }
}

export function assertConservation(store: MemoryStore, draft: SettlementDraft): void {
  // BigInt sums avoid overflowing when individually safe balances belong to many users.
  let cashDelta = 0n;
  const shareDeltas = new Map<string, bigint>();
  for (const [userId, account] of draft.accounts) {
    cashDelta +=
      BigInt(account.cashBalanceCents) - BigInt(store.accounts.get(userId)!.cashBalanceCents);
    const before = store.positions.get(userId) ?? new Map<string, Position>();
    const after = draft.positions.get(userId)!;
    for (const symbol of new Set([...before.keys(), ...after.keys()])) {
      shareDeltas.set(
        symbol,
        (shareDeltas.get(symbol) ?? 0n) +
          BigInt(after.get(symbol)?.quantity ?? 0) -
          BigInt(before.get(symbol)?.quantity ?? 0),
      );
    }
  }
  invariant(cashDelta === 0n);
  for (const delta of shareDeltas.values()) invariant(delta === 0n);
}

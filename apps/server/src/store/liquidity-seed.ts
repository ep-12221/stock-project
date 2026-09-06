import { STOCKS } from '@stock/shared';
import { invariant } from '../matching/checked.js';
import { createTradingService } from '../services/trading.service.js';
import { createOrderBook, type MemoryStore } from './memory-store.js';
import { SYSTEM_USER_ID } from './seed.js';

/** Bootstrap only: once per process, before HTTP accepts commands. Never replenish consumed orders. */
export function initializeLiquidity(store: MemoryStore): void {
  if (store.liquiditySeeded) return;
  invariant(store.orders.size === 0 && store.trades.size === 0 && store.activeOrderCount === 0);
  invariant(store.orderSequence === 0 && store.tradeSequence === 0);
  invariant(store.ordersByUser.size === 0 && store.activeOrdersByUser.size === 0);
  invariant(store.tradesByUser.size === 0 && store.marketTradeIds.length === 0);
  for (const book of store.orderBooks.values()) {
    invariant(book.buyOrderIds.length === 0 && book.sellOrderIds.length === 0);
  }

  // The matching service clones affected account/position/order records before updating them.
  // Separate outer maps and index arrays isolate the entire six-command bootstrap batch.
  const draft: MemoryStore = {
    ...store,
    accounts: new Map(store.accounts),
    positions: new Map(store.positions),
    stocks: new Map(store.stocks),
    orders: new Map(),
    orderBooks: new Map(
      [...store.orderBooks].map(([symbol]) => [
        symbol,
        createOrderBook(symbol, store.matchingEngine),
      ]),
    ),
    ordersByUser: new Map(),
    activeOrdersByUser: new Map(),
    trades: new Map(),
    tradesByUser: new Map(),
    marketTradeIds: [],
  };
  const trading = createTradingService(draft);
  for (const { symbol, initialPriceCents } of STOCKS) {
    trading.submitLimitOrder(SYSTEM_USER_ID, {
      symbol,
      side: 'BUY',
      priceCents: initialPriceCents - 1,
      quantity: 1_000,
    });
    trading.submitLimitOrder(SYSTEM_USER_ID, {
      symbol,
      side: 'SELL',
      priceCents: initialPriceCents + 1,
      quantity: 1_000,
    });
  }
  Object.assign(store, {
    accounts: draft.accounts,
    positions: draft.positions,
    stocks: draft.stocks,
    orders: draft.orders,
    orderBooks: draft.orderBooks,
    ordersByUser: draft.ordersByUser,
    activeOrdersByUser: draft.activeOrdersByUser,
    trades: draft.trades,
    tradesByUser: draft.tradesByUser,
    marketTradeIds: draft.marketTradeIds,
    orderSequence: draft.orderSequence,
    tradeSequence: draft.tradeSequence,
    activeOrderCount: draft.activeOrderCount,
    marketVersion: draft.marketVersion,
    liquiditySeeded: true,
  });
}

import { INITIAL_CASH_CENTS, STOCKS } from '@stock/shared';
import type { MemoryStore } from './memory-store.js';

export const SYSTEM_USER_ID = 'system-liquidity';

export function seedStore(store: MemoryStore): void {
  const createdAt = new Date(store.now()).toISOString();
  for (const stock of STOCKS) {
    if (!store.stocks.has(stock.symbol)) {
      store.stocks.set(stock.symbol, {
        symbol: stock.symbol,
        name: stock.name,
        previousCloseCents: stock.initialPriceCents,
        lastPriceCents: stock.initialPriceCents,
        changePercent: 0,
        bestBidCents: null,
        bestAskCents: null,
        updatedAt: createdAt,
      });
    }
  }
  if (store.users.has(SYSTEM_USER_ID)) return;

  store.users.set(SYSTEM_USER_ID, {
    id: SYSTEM_USER_ID,
    username: 'system',
    kind: 'SYSTEM',
    createdAt,
  });
  store.usernames.set('system', SYSTEM_USER_ID);
  store.accounts.set(SYSTEM_USER_ID, {
    userId: SYSTEM_USER_ID,
    cashBalanceCents: INITIAL_CASH_CENTS,
    frozenCashCents: 0,
    version: 0,
  });
  store.positions.set(
    SYSTEM_USER_ID,
    new Map(
      STOCKS.map((stock) => [
        stock.symbol,
        { userId: SYSTEM_USER_ID, symbol: stock.symbol, quantity: 10_000, frozenQuantity: 0 },
      ]),
    ),
  );
  // Startup submits finite seed orders through initializeLiquidity; raw stores keep empty books.
}

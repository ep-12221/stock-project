import { STOCKS, INITIAL_CASH_CENTS } from '@stock/shared';
import { describe, expect, it } from 'vitest';
import { createMemoryStore } from '../store/memory-store.js';
import { seedStore, SYSTEM_USER_ID } from '../store/seed.js';

describe('memory initialization', () => {
  it('seeds three independent stock quotes and a non-login system account', () => {
    const store = createMemoryStore({ now: () => 1_700_000_000_000 });
    expect(store.stocks.size).toBe(3);
    expect(store.users.get(SYSTEM_USER_ID)).toMatchObject({ kind: 'SYSTEM' });
    expect(store.accounts.get(SYSTEM_USER_ID)).toEqual({
      userId: SYSTEM_USER_ID,
      cashBalanceCents: INITIAL_CASH_CENTS,
      frozenCashCents: 0,
      version: 0,
    });
    for (const definition of STOCKS) {
      expect(store.stocks.get(definition.symbol)).toMatchObject({
        symbol: definition.symbol,
        name: definition.name,
        lastPriceCents: definition.initialPriceCents,
        previousCloseCents: definition.initialPriceCents,
        bestBidCents: null,
        bestAskCents: null,
        changePercent: 0,
        updatedAt: '2023-11-14T22:13:20.000Z',
      });
      expect(store.positions.get(SYSTEM_USER_ID)?.get(definition.symbol)).toMatchObject({
        quantity: 10_000,
        frozenQuantity: 0,
      });
    }
    expect(store.sessions.size).toBe(0);
  });

  it('does not issue cash or stock twice when seed initialization is repeated', () => {
    const store = createMemoryStore();
    const account = store.accounts.get(SYSTEM_USER_ID)!;
    account.cashBalanceCents -= 100;
    const position = store.positions.get(SYSTEM_USER_ID)!.get('SIM001')!;
    position.quantity -= 1;
    seedStore(store);
    expect(store.users.size).toBe(1);
    expect(store.accounts.get(SYSTEM_USER_ID)?.cashBalanceCents).toBe(INITIAL_CASH_CENTS - 100);
    expect(store.positions.get(SYSTEM_USER_ID)?.get('SIM001')?.quantity).toBe(9_999);
  });

  it('creates separate maps and a new server epoch after restart', () => {
    const first = createMemoryStore();
    const second = createMemoryStore();
    first.stocks.get('SIM001')!.lastPriceCents = 7;
    expect(second.stocks.get('SIM001')!.lastPriceCents).toBe(1_000);
    expect(STOCKS[0].initialPriceCents).toBe(1_000);
    expect(first.serverEpoch).not.toBe(second.serverEpoch);
    expect(first.users).not.toBe(second.users);
    expect(first.sessions).not.toBe(second.sessions);
  });
});

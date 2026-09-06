import { describe, expect, it } from 'vitest';
import { fixture, state, SYMBOL, expectInvariants, totals } from './trading-fixture.js';

describe('self-trade prevention and atomic commits', () => {
  it.each(['BUY', 'SELL'] as const)('rejects a direct self-cross for incoming %s', (side) => {
    const { store, submit } = fixture();
    submit('bob', side === 'BUY' ? 'SELL' : 'BUY', 1_000, 10);
    const before = state(store);
    expect(() => submit('bob', side, 1_000, 10)).toThrow(
      expect.objectContaining({ code: 'SELF_TRADE_PREVENTED' }),
    );
    expect(state(store)).toEqual(before);
  });

  it.each(['BUY', 'SELL'] as const)(
    'rolls back the entire incoming %s path when its own order follows external liquidity',
    (side) => {
      const { store, submit } = fixture();
      const maker = side === 'BUY' ? 'SELL' : 'BUY';
      submit('carol', maker, side === 'BUY' ? 900 : 1_100, 10);
      submit('bob', maker, 1_000, 10);
      const before = state(store);
      expect(() => submit('bob', side, 1_000, 15)).toThrow(
        expect.objectContaining({ code: 'SELF_TRADE_PREVENTED' }),
      );
      expect(state(store)).toEqual(before);
      const accepted = submit('alice', 'BUY', 1, 1);
      expect(accepted.order.sequence).toBe(3);
    },
  );

  it.each(['BUY', 'SELL'] as const)(
    'allows an incoming %s completed before an own order farther in the book',
    (side) => {
      const { store, submit } = fixture();
      const maker = side === 'BUY' ? 'SELL' : 'BUY';
      submit('carol', maker, side === 'BUY' ? 900 : 1_100, 10);
      const own = submit('bob', maker, 1_000, 10).order;
      const result = submit('bob', side, 1_000, 10);
      expect(result.trades).toHaveLength(1);
      expect(store.orders.get(own.id)?.status).toBe('OPEN');
      expectInvariants(store);
    },
  );

  it.each(['BUY', 'SELL'] as const)('allows non-crossing own %s liquidity', (side) => {
    const { store, submit } = fixture();
    submit('bob', side === 'BUY' ? 'SELL' : 'BUY', side === 'BUY' ? 1_001 : 999, 10);
    submit('bob', side, 1_000, 10);
    expect(store.trades.size).toBe(0);
    expectInvariants(store);
  });

  it('rejects a later seller cash overflow after an earlier planned fill with all maps and indexes unchanged', () => {
    const { store, submit } = fixture();
    submit('bob', 'SELL', 999, 1);
    submit('carol', 'SELL', 1_000, 1);
    store.accounts.get('carol')!.cashBalanceCents = Number.MAX_SAFE_INTEGER;
    const before = state(store);
    const oldAccount = store.accounts.get('alice')!;
    const oldPosition = store.positions.get('bob')!.get(SYMBOL)!;
    expect(() => submit('alice', 'BUY', 1_000, 2)).toThrow(
      expect.objectContaining({ code: 'INTERNAL_ERROR' }),
    );
    expect(state(store)).toEqual(before);
    expect(store.accounts.get('alice')).toBe(oldAccount);
    expect(store.positions.get('bob')!.get(SYMBOL)).toBe(oldPosition);
  });

  it('rejects buyer position overflow without committing either side', () => {
    const { store, submit } = fixture();
    submit('bob', 'SELL', 1_000, 1);
    store.positions.get('alice')!.get(SYMBOL)!.quantity = Number.MAX_SAFE_INTEGER;
    const before = state(store);
    expect(() => submit('alice', 'BUY', 1_000, 1)).toThrow(
      expect.objectContaining({ code: 'INTERNAL_ERROR' }),
    );
    expect(state(store)).toEqual(before);
  });

  it.each(['orderSequence', 'tradeSequence', 'marketVersion'] as const)(
    'rejects %s overflow atomically',
    (field) => {
      const { store, submit } = fixture();
      submit('bob', 'SELL', 1_000, 1);
      store[field] = Number.MAX_SAFE_INTEGER;
      const before = state(store);
      expect(() => submit('alice', 'BUY', 1_000, 1)).toThrow(
        expect.objectContaining({ code: 'INTERNAL_ERROR' }),
      );
      expect(state(store)).toEqual(before);
    },
  );

  it('rejects an affected account version overflow', () => {
    const { store, submit } = fixture();
    store.accounts.get('alice')!.version = Number.MAX_SAFE_INTEGER;
    const before = state(store);
    expect(() => submit('alice', 'BUY', 1_000, 1)).toThrow(
      expect.objectContaining({ code: 'INTERNAL_ERROR' }),
    );
    expect(state(store)).toEqual(before);
  });

  it.each(['cash', 'shares'] as const)(
    'detects broken %s freeze invariants before commit',
    (asset) => {
      const { store, submit } = fixture();
      if (asset === 'cash') store.accounts.get('alice')!.frozenCashCents = 1;
      else store.positions.get('alice')!.get(SYMBOL)!.frozenQuantity = 1;
      const before = state(store);
      expect(() => submit('alice', 'BUY', 1_000, 1)).toThrow(
        expect.objectContaining({ code: 'INTERNAL_ERROR' }),
      );
      expect(state(store)).toEqual(before);
    },
  );

  it('increments each affected account exactly once for one command with multiple fills', () => {
    const { store, submit } = fixture();
    submit('bob', 'SELL', 990, 10);
    submit('bob', 'SELL', 1_000, 10);
    submit('carol', 'SELL', 1_010, 10);
    const result = submit('alice', 'BUY', 1_020, 30);
    expect(new Set(result.affectedUserIds)).toEqual(new Set(['alice', 'bob', 'carol']));
    expect(result.affectedUserIds).toHaveLength(3);
    expect(store.accounts.get('alice')?.version).toBe(1);
    expect(store.accounts.get('bob')?.version).toBe(3);
    expect(store.accounts.get('carol')?.version).toBe(2);
    expect(store.accounts.get('dave')?.version).toBe(0);
    expect(store.marketVersion).toBe(4);
    expect(store.tradeSequence).toBe(3);
    expect(result.trades.map((t) => t.sequence)).toEqual([1, 2, 3]);
    expectInvariants(store);
  });

  it('does not mutate previous objects during a successful draft and returns detached results', () => {
    const { store, submit } = fixture();
    const maker = submit('bob', 'SELL', 1_000, 10).order;
    const oldOrder = store.orders.get(maker.id)!;
    const oldAccount = store.accounts.get('alice')!;
    const oldPosition = store.positions.get('bob')!.get(SYMBOL)!;
    const previous = structuredClone({ oldOrder, oldAccount, oldPosition });
    const result = submit('alice', 'BUY', 1_000, 5);
    expect({ oldOrder, oldAccount, oldPosition }).toEqual(previous);
    const after = state(store);
    result.order.filledQuantity = 999;
    result.trades[0]!.quantity = 999;
    result.affectedUserIds.push('forged');
    expect(state(store)).toEqual(after);
  });

  it('keeps all assets, order arithmetic, book order and indexes consistent through a deterministic mixed sequence', () => {
    const { store, submit } = fixture({ maxActiveOrdersPerUser: 1_000 });
    const initial = totals(store);
    let seed = 73;
    const random = (max: number) => {
      seed = (Math.imul(seed, 1_664_525) + 1_013_904_223) >>> 0;
      return seed % max;
    };
    let successes = 0;
    let failures = 0;
    for (let i = 0; i < 240; i++) {
      const users = ['alice', 'bob', 'carol', 'dave', 'system-liquidity'];
      const before = state(store);
      try {
        submit(
          users[random(users.length)]!,
          random(2) === 0 ? 'BUY' : 'SELL',
          970 + random(61),
          1 + random(50),
          ['SIM001', 'SIM002', 'SIM003'][random(3)]!,
        );
        successes++;
      } catch (error) {
        expect(error).toMatchObject({
          code: expect.stringMatching(
            /SELF_TRADE_PREVENTED|INSUFFICIENT_POSITION|INSUFFICIENT_FUNDS/,
          ),
        });
        expect(state(store)).toEqual(before);
        failures++;
      }
      expect(totals(store)).toEqual(initial);
      expectInvariants(store);
    }
    expect(successes).toBeGreaterThan(20);
    expect(failures).toBeGreaterThan(0);
    expect(store.trades.size).toBeGreaterThan(10);
  });
});

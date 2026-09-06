import { describe, expect, it } from 'vitest';
import { createTradingService } from '../services/trading.service.js';
import { fixture, state, SYMBOL } from './trading-fixture.js';

const valid = { symbol: SYMBOL, side: 'BUY', priceCents: 1_000, quantity: 1 };
describe('trading input and resource limits', () => {
  const invalid: [string, unknown][] = [
    ['null', null],
    ['array', []],
    ['empty', {}],
    ['unknown symbol', { ...valid, symbol: 'UNKNOWN' }],
    ['symbol case', { ...valid, symbol: 'sim001' }],
    ['blank symbol', { ...valid, symbol: '' }],
    ['unknown side', { ...valid, side: 'buy' }],
    ...['priceCents', 'quantity'].flatMap((field) =>
      [
        0,
        -1,
        1.5,
        NaN,
        Infinity,
        -Infinity,
        Number.MAX_SAFE_INTEGER + 1,
        '1',
        null,
        true,
        undefined,
      ].map((value): [string, unknown] => [
        field + '=' + String(value),
        { ...valid, [field]: value },
      ]),
    ),
    ['price upper bound', { ...valid, priceCents: 10_000_001 }],
    ['quantity upper bound', { ...valid, quantity: 100_001 }],
    ['spoofed user', { ...valid, userId: 'bob' }],
    ['spoofed sequence', { ...valid, sequence: 1 }],
    ['spoofed ID', { ...valid, id: 'custom' }],
    ['spoofed timestamp', { ...valid, createdAt: '2000-01-01' }],
    ['invalid idempotency key', { ...valid, clientOrderId: 'later-phase' }],
  ];
  it.each(invalid)('rejects %s with no changes', (_name, input) => {
    const { store, service } = fixture();
    const before = state(store);
    expect(() => service.submitLimitOrder('alice', input)).toThrow(
      expect.objectContaining({
        code:
          typeof input === 'object' &&
          input !== null &&
          'symbol' in input &&
          (input.symbol === 'UNKNOWN' || input.symbol === 'sim001')
            ? 'STOCK_NOT_FOUND'
            : 'VALIDATION_ERROR',
      }),
    );
    expect(state(store)).toEqual(before);
  });

  it('rejects missing identities before changing anything', () => {
    const { store, service } = fixture();
    const before = state(store);
    expect(() => service.submitLimitOrder('missing', valid)).toThrow(
      expect.objectContaining({ code: 'UNAUTHENTICATED' }),
    );
    expect(state(store)).toEqual(before);
  });

  it('requires the complete buy limit amount even when cheaper liquidity is available', () => {
    const { store, submit } = fixture();
    store.accounts.get('alice')!.cashBalanceCents = 1_000;
    submit('bob', 'SELL', 500, 2);
    const before = state(store);
    expect(() => submit('alice', 'BUY', 1_000, 2)).toThrow(
      expect.objectContaining({ code: 'INSUFFICIENT_FUNDS' }),
    );
    expect(state(store)).toEqual(before);
  });

  it('cannot reuse cash frozen by existing orders across symbols; the exact available amount is accepted', () => {
    const { store, submit } = fixture();
    store.accounts.get('alice')!.cashBalanceCents = 2_000;
    submit('alice', 'BUY', 1_000, 1);
    const before = state(store);
    expect(() => submit('alice', 'BUY', 1_001, 1, 'SIM002')).toThrow(
      expect.objectContaining({ code: 'INSUFFICIENT_FUNDS' }),
    );
    expect(state(store)).toEqual(before);
    submit('alice', 'BUY', 1_000, 1, 'SIM002');
    expect(store.accounts.get('alice')?.frozenCashCents).toBe(2_000);
  });

  it('cannot oversell holdings already frozen by a partial order', () => {
    const { store, submit } = fixture();
    submit('alice', 'BUY', 1_000, 100);
    submit('bob', 'SELL', 1_000, 1_000);
    const before = state(store);
    expect(() => submit('bob', 'SELL', 1_000, 1)).toThrow(
      expect.objectContaining({ code: 'INSUFFICIENT_POSITION' }),
    );
    expect(state(store)).toEqual(before);
    expect(store.positions.get('bob')?.get(SYMBOL)).toMatchObject({
      quantity: 900,
      frozenQuantity: 900,
    });
  });

  it('does not borrow holdings from another symbol', () => {
    const { store, submit } = fixture();
    store.positions.get('bob')!.delete(SYMBOL);
    const before = state(store);
    expect(() => submit('bob', 'SELL', 1, 1)).toThrow(
      expect.objectContaining({ code: 'INSUFFICIENT_POSITION' }),
    );
    expect(state(store)).toEqual(before);
  });

  it('enforces the per-user active order cap even if the new order would fill immediately', () => {
    const { store, submit } = fixture({ maxActiveOrdersPerUser: 1 });
    submit('alice', 'BUY', 900, 1);
    submit('bob', 'SELL', 1_000, 1);
    const before = state(store);
    expect(() => submit('alice', 'BUY', 1_000, 1)).toThrow(
      expect.objectContaining({ code: 'ORDER_LIMIT_REACHED' }),
    );
    expect(state(store)).toEqual(before);
  });

  it('enforces the global active order cap across users and symbols', () => {
    const { store, submit } = fixture({ maxActiveOrders: 2 });
    submit('alice', 'BUY', 900, 1);
    submit('dave', 'BUY', 900, 1, 'SIM002');
    const before = state(store);
    expect(() => submit('bob', 'SELL', 1_000, 1)).toThrow(
      expect.objectContaining({ code: 'ORDER_LIMIT_REACHED' }),
    );
    expect(state(store)).toEqual(before);
  });

  it('counts active remainders instead of history and frees capacity after fills', () => {
    const { store, submit } = fixture({ maxActiveOrdersPerUser: 1 });
    submit('bob', 'SELL', 1_000, 1);
    submit('alice', 'BUY', 1_000, 1);
    submit('bob', 'SELL', 1_000, 1);
    expect(store.ordersByUser.get('bob')).toHaveLength(2);
    expect(store.activeOrdersByUser.get('bob')?.size).toBe(1);
    expect(store.activeOrderCount).toBe(1);
  });

  it.each([0, -1, 1.5, Infinity, Number.MAX_SAFE_INTEGER + 1])(
    'rejects invalid cap %s at service construction',
    (value) => {
      const { store } = fixture();
      expect(() => createTradingService(store, { maxActiveOrders: value })).toThrow();
      expect(() => createTradingService(store, { maxActiveOrdersPerUser: value })).toThrow();
    },
  );
});

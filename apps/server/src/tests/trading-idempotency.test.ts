import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { createTradingService } from '../services/trading.service.js';
import { fixture, state, expectInvariants } from './trading-fixture.js';

const command = () => ({
  clientOrderId: randomUUID(),
  symbol: 'SIM001',
  side: 'BUY',
  priceCents: 1_000,
  quantity: 10,
});

describe('atomic per-user order idempotency', () => {
  it.each([0, 4, 10])(
    'replays after %s shares initially match without changing any map or sequence',
    (filled) => {
      const { store, service, submit } = fixture();
      if (filled) submit('bob', 'SELL', 980, filled);
      const input = command();
      const original = service.submitOrder('alice', input);
      const before = state(store);
      const replay = service.submitOrder('alice', input);
      expect(original.replayed).toBe(false);
      expect(replay).toMatchObject({
        order: original.order,
        trades: [],
        affectedUserIds: [],
        replayed: true,
        marketVersion: store.marketVersion,
      });
      expect(replay.order.filledQuantity).toBe(filled);
      expect(state(store)).toEqual(before);
      expectInvariants(store);
    },
  );

  it('looks up the latest order after subsequent passive partial and full fills', () => {
    const { store, service, submit } = fixture();
    const input = command();
    const original = service.submitOrder('alice', input);
    submit('bob', 'SELL', 990, 4);
    expect(service.submitOrder('alice', input).order).toMatchObject({
      id: original.order.id,
      status: 'PARTIALLY_FILLED',
      filledQuantity: 4,
    });
    submit('carol', 'SELL', 990, 6);
    const before = state(store);
    expect(service.submitOrder('alice', input).order).toMatchObject({
      id: original.order.id,
      status: 'FILLED',
      filledQuantity: 10,
    });
    expect(state(store)).toEqual(before);
  });

  it.each(['cash', 'position', 'user limit', 'global limit'])(
    'replays before checking the currently exhausted %s',
    (resource) => {
      const { store, service } = fixture(
        resource === 'user limit'
          ? { maxActiveOrdersPerUser: 1 }
          : resource === 'global limit'
            ? { maxActiveOrders: 1 }
            : {},
      );
      const input = command();
      const userId = resource === 'position' ? 'bob' : 'alice';
      if (resource === 'cash') store.accounts.get(userId)!.cashBalanceCents = 10_000;
      if (resource === 'position') {
        input.side = 'SELL';
        input.quantity = 1_000;
      }
      const original = service.submitOrder(userId, input);
      const before = state(store);
      expect(service.submitOrder(userId, input)).toMatchObject({
        replayed: true,
        order: original.order,
      });
      expect(() =>
        service.submitOrder(userId, { ...input, clientOrderId: randomUUID() }),
      ).toThrow();
      expect(state(store)).toEqual(before);
    },
  );

  it.each([{ symbol: 'SIM002' }, { side: 'SELL' }, { priceCents: 999 }, { quantity: 11 }])(
    'rejects changed original business parameters %j before settlement',
    (change) => {
      const { store, service } = fixture({ maxActiveOrdersPerUser: 1 });
      const input = command();
      service.submitOrder('alice', input);
      const before = state(store);
      expect(() => service.submitOrder('alice', { ...input, ...change })).toThrow(
        expect.objectContaining({ status: 409, code: 'IDEMPOTENCY_CONFLICT' }),
      );
      expect(state(store)).toEqual(before);
    },
  );

  it('normalizes uppercase UUIDs and does not depend on object property order', () => {
    const { store, service } = fixture();
    const input = command();
    const original = service.submitOrder('alice', {
      ...input,
      clientOrderId: input.clientOrderId.toUpperCase(),
    });
    const before = state(store);
    expect(
      service.submitOrder('alice', {
        quantity: input.quantity,
        priceCents: input.priceCents,
        side: input.side,
        symbol: input.symbol,
        clientOrderId: input.clientOrderId,
      }),
    ).toMatchObject({ replayed: true, order: original.order });
    expect(state(store)).toEqual(before);
  });

  it('isolates the same key by user and shares its index across service instances', () => {
    const { store, service } = fixture();
    const input = command();
    const alice = service.submitOrder('alice', input);
    const dave = service.submitOrder('dave', { ...input, quantity: 2 });
    expect(dave.order.id).not.toBe(alice.order.id);
    expect(createTradingService(store).submitOrder('alice', input)).toMatchObject({
      replayed: true,
      order: alice.order,
    });
    expect(store.orders.size).toBe(2);
  });

  it('does not reserve a key after rejected funding and accepts its later valid retry', () => {
    const { store, service } = fixture();
    const input = command();
    store.accounts.get('alice')!.cashBalanceCents = 1;
    const before = state(store);
    expect(() => service.submitOrder('alice', input)).toThrow(
      expect.objectContaining({ code: 'INSUFFICIENT_FUNDS' }),
    );
    expect(state(store)).toEqual(before);
    store.accounts.get('alice')!.cashBalanceCents = 10_000;
    expect(service.submitOrder('alice', input).replayed).toBe(false);
    expect(service.submitOrder('alice', input).replayed).toBe(true);
  });

  it('rolls back the key with every settlement map when a later fill overflows', () => {
    const { store, service, submit } = fixture();
    submit('bob', 'SELL', 999, 1);
    submit('carol', 'SELL', 1_000, 1);
    store.accounts.get('carol')!.cashBalanceCents = Number.MAX_SAFE_INTEGER;
    const input = { ...command(), quantity: 2 };
    const before = state(store);
    expect(() => service.submitOrder('alice', input)).toThrow(
      expect.objectContaining({ code: 'INTERNAL_ERROR' }),
    );
    expect(state(store)).toEqual(before);
    store.accounts.get('carol')!.cashBalanceCents = 100_000_000;
    expect(service.submitOrder('alice', input)).toMatchObject({
      replayed: false,
      order: { sequence: 3, status: 'FILLED' },
    });
    expectInvariants(store);
  });

  it('rejects a self-cross atomically and leaves that key available for a different valid command', () => {
    const { store, service, submit } = fixture();
    submit('bob', 'SELL', 1_000, 10);
    const input = command();
    const before = state(store);
    expect(() => service.submitOrder('bob', input)).toThrow(
      expect.objectContaining({ code: 'SELF_TRADE_PREVENTED' }),
    );
    expect(state(store)).toEqual(before);
    expect(service.submitOrder('bob', { ...input, priceCents: 999 }).replayed).toBe(false);
  });

  it('returns a detached replay and starts with an empty index in a new server store', () => {
    const { store, service } = fixture();
    const input = command();
    const original = service.submitOrder('alice', input);
    const before = state(store);
    const replay = service.submitOrder('alice', input);
    replay.order.quantity = 999;
    replay.affectedUserIds.push('forged');
    expect(state(store)).toEqual(before);
    const next = fixture().service.submitOrder('alice', input);
    expect(next.replayed).toBe(false);
    expect(next.order.id).not.toBe(original.order.id);
  });

  it.each(
    [undefined, null, '', 'not-a-uuid', '12345678-1234-1234-1234-123456789012', 123, {}, []].map(
      (clientOrderId) => ({ clientOrderId }),
    ),
  )(
    'rejects invalid or missing public key $clientOrderId without side effects',
    ({ clientOrderId }) => {
      const { store, service } = fixture();
      const input = command();
      const body =
        clientOrderId === undefined
          ? {
              symbol: input.symbol,
              side: input.side,
              priceCents: input.priceCents,
              quantity: input.quantity,
            }
          : { ...input, clientOrderId };
      const before = state(store);
      expect(() => service.submitOrder('alice', body)).toThrow(
        expect.objectContaining({ code: 'VALIDATION_ERROR' }),
      );
      expect(state(store)).toEqual(before);
    },
  );

  it('keeps a trusted internal entry point without a public idempotency key', () => {
    const { service } = fixture();
    expect(
      service.submitLimitOrder('alice', {
        symbol: 'SIM001',
        side: 'BUY',
        priceCents: 1,
        quantity: 1,
      }).replayed,
    ).toBe(false);
  });
});

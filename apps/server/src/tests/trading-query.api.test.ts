import type { OrderDto, PersonalTradeDto, PublicTradeDto } from '@stock/shared';
import { describe, expect, it } from 'vitest';
import { apiFixture } from './trading-api-fixture.js';
import { state } from './trading-fixture.js';

const paths = ['/api/me/orders', '/api/me/trades', '/api/trades'];
describe('trading history queries', () => {
  it.each(paths)('returns an empty page and version metadata for %s', async (path) => {
    const { store, get } = apiFixture();
    const result = await get('alice', path).expect(200);
    expect(result.body.data).toMatchObject({
      serverEpoch: store.serverEpoch,
      items: [],
      nextCursor: null,
    });
    if (path === '/api/trades') expect(result.body.data.marketVersion).toBe(0);
    else expect(result.body.data).toMatchObject({ userId: 'alice', accountVersion: 0 });
    expect(result.headers['cache-control']).toBe('no-store');
  });

  it('returns only the current users orders, sorted by sequence and filtered by symbol and exact status', async () => {
    const { submit, get } = apiFixture();
    const first = submit('alice', 'BUY', 1_000, 10).order;
    submit('bob', 'SELL', 1_000, 5);
    const other = submit('alice', 'BUY', 100, 1, 'SIM002').order;
    submit('carol', 'SELL', 900, 1, 'SIM003');
    const all = await get('alice', '/api/me/orders').expect(200);
    expect(all.body.data.items.map((o: OrderDto) => o.id)).toEqual([other.id, first.id]);
    const filtered = await get(
      'alice',
      '/api/me/orders?status=PARTIALLY_FILLED&symbol=SIM001',
    ).expect(200);
    expect(filtered.body.data.items).toHaveLength(1);
    expect(filtered.body.data.items[0]).toMatchObject({ id: first.id, filledQuantity: 5 });
    const cancelled = await get('alice', '/api/me/orders?status=CANCELLED').expect(200);
    expect(cancelled.body.data.items).toEqual([]);
    for (const order of all.body.data.items) expect(order).not.toHaveProperty('userId');
  });

  it('returns all OPEN and FILLED records when requested without confusing partial fills', async () => {
    const { submit, get } = apiFixture();
    const filled = submit('alice', 'BUY', 1_000, 1).order;
    submit('bob', 'SELL', 1_000, 1);
    const open = submit('alice', 'BUY', 900, 1).order;
    for (const [status, id] of [
      ['OPEN', open.id],
      ['FILLED', filled.id],
    ]) {
      const result = await get('alice', '/api/me/orders?status=' + status).expect(200);
      expect(result.body.data.items.map((o: OrderDto) => o.id)).toEqual([id]);
    }
  });

  it('paginates orders exclusively by sequence without duplicates when newer orders arrive', async () => {
    const { submit, get } = apiFixture();
    const orders = Array.from({ length: 5 }, () => submit('alice', 'BUY', 900, 1).order);
    const first = await get('alice', '/api/me/orders?limit=2').expect(200);
    expect(first.body.data.items.map((o: OrderDto) => o.id)).toEqual([
      orders[4]!.id,
      orders[3]!.id,
    ]);
    expect(first.body.data.nextCursor).toBe(orders[3]!.sequence);
    submit('alice', 'BUY', 900, 1);
    const second = await get(
      'alice',
      '/api/me/orders?limit=2&cursor=' + first.body.data.nextCursor,
    ).expect(200);
    expect(second.body.data.items.map((o: OrderDto) => o.id)).toEqual([
      orders[2]!.id,
      orders[1]!.id,
    ]);
    const third = await get(
      'alice',
      '/api/me/orders?limit=2&cursor=' + second.body.data.nextCursor,
    ).expect(200);
    expect(third.body.data.items.map((o: OrderDto) => o.id)).toEqual([orders[0]!.id]);
    expect(third.body.data.nextCursor).toBeNull();
    const exhausted = await get('alice', '/api/me/orders?cursor=1').expect(200);
    expect(exhausted.body.data).toMatchObject({ items: [], nextCursor: null });
  });

  it('computes nextCursor after filtering, and returns null for an exactly full final page', async () => {
    const { submit, get } = apiFixture();
    const a = submit('alice', 'BUY', 900, 1).order;
    submit('alice', 'BUY', 900, 1, 'SIM002');
    const b = submit('alice', 'BUY', 900, 1).order;
    submit('alice', 'BUY', 900, 1, 'SIM003');
    const result = await get('alice', '/api/me/orders?symbol=SIM001&limit=2').expect(200);
    expect(result.body.data.items.map((o: OrderDto) => o.id)).toEqual([b.id, a.id]);
    expect(result.body.data.nextCursor).toBeNull();
  });

  it.each(paths)(
    'defaults to 50 and accepts 100 for %s while retaining older history',
    async (path) => {
      const { submit, get } = apiFixture();
      for (let i = 0; i < 105; i++) {
        submit('bob', 'SELL', 1_000, 1);
        submit('alice', 'BUY', 1_000, 1);
      }
      const defaultPage = await get('alice', path).expect(200);
      expect(defaultPage.body.data.items).toHaveLength(50);
      const maxPage = await get('alice', path + '?limit=100').expect(200);
      expect(maxPage.body.data.items).toHaveLength(100);
      const next = await get(
        'alice',
        path + '?limit=100&cursor=' + maxPage.body.data.nextCursor,
      ).expect(200);
      expect(next.body.data.items).toHaveLength(5);
      expect(next.body.data.nextCursor).toBeNull();
    },
  );

  it('shows correct personal sides and order IDs; anonymous market trades contain neither identities nor order IDs', async () => {
    const { submit, get } = apiFixture();
    const ask = submit('bob', 'SELL', 1_000, 10).order;
    const bid = submit('alice', 'BUY', 1_000, 4).order;
    submit('carol', 'SELL', 2_000, 1, 'SIM002');
    submit('dave', 'BUY', 2_000, 1, 'SIM002');
    const buyer = await get('alice', '/api/me/trades').expect(200);
    const seller = await get('bob', '/api/me/trades').expect(200);
    expect(buyer.body.data.items).toHaveLength(1);
    expect(buyer.body.data.items[0]).toMatchObject({
      side: 'BUY',
      orderId: bid.id,
      priceCents: 1_000,
      quantity: 4,
    });
    expect(seller.body.data.items[0]).toMatchObject({ side: 'SELL', orderId: ask.id });
    expect(buyer.body.data.items[0].id).toBe(seller.body.data.items[0].id);
    const publicPage = await get('alice', '/api/trades').expect(200);
    expect(publicPage.body.data.items).toHaveLength(2);
    expect(publicPage.body.data.items.map((t: PublicTradeDto) => t.sequence)).toEqual([2, 1]);
    for (const trade of publicPage.body.data.items) {
      expect(Object.keys(trade).sort()).toEqual(
        ['id', 'sequence', 'symbol', 'priceCents', 'quantity', 'executedAt'].sort(),
      );
    }
    for (const trade of buyer.body.data.items) {
      expect(Object.keys(trade).sort()).toEqual(
        [
          'id',
          'sequence',
          'symbol',
          'priceCents',
          'quantity',
          'executedAt',
          'side',
          'orderId',
        ].sort(),
      );
    }
  });

  it.each(['/api/me/trades', '/api/trades'])(
    'combines symbol filtering and cursor paging for %s',
    async (path) => {
      const { submit, get } = apiFixture();
      for (const symbol of ['SIM001', 'SIM002', 'SIM001', 'SIM003']) {
        submit('bob', 'SELL', 1_000, 1, symbol);
        submit('alice', 'BUY', 1_000, 1, symbol);
      }
      const first = await get('alice', path + '?symbol=SIM001&limit=1').expect(200);
      expect(first.body.data.items[0].sequence).toBe(3);
      expect(first.body.data.nextCursor).toBe(3);
      const next = await get('alice', path + '?symbol=SIM001&limit=1&cursor=3').expect(200);
      expect(next.body.data.items.map((t: PersonalTradeDto) => t.sequence)).toEqual([1]);
      expect(next.body.data.nextCursor).toBeNull();
    },
  );

  it('never changes the store on any successful history read', async () => {
    const { store, submit, get } = apiFixture();
    submit('bob', 'SELL', 1_000, 1);
    submit('alice', 'BUY', 1_000, 1);
    const before = state(store);
    for (const path of paths) await get('alice', path).expect(200);
    expect(state(store)).toEqual(before);
  });

  const invalid = [
    'limit=0',
    'limit=101',
    'limit=-1',
    'limit=1.5',
    'limit=',
    'limit=NaN',
    'limit=1e2',
    'limit=0x10',
    'limit=1&limit=2',
    'cursor=0',
    'cursor=-1',
    'cursor=1.5',
    'cursor=9007199254740992',
    'cursor=Infinity',
    'cursor=',
    'cursor=1&cursor=2',
    'symbol=',
    'symbol=SIM001&symbol=SIM002',
    'userId=bob',
    'side=BUY',
  ];
  it.each(invalid)(
    'rejects invalid query %s on every history endpoint without state changes',
    async (query) => {
      const { store, get } = apiFixture();
      const before = state(store);
      for (const path of paths) {
        const response = await get('alice', path + '?' + query).expect(400);
        expect(response.body.error.code).toBe('VALIDATION_ERROR');
      }
      expect(state(store)).toEqual(before);
    },
  );

  it.each(paths)('rejects an unknown symbol with 404 on %s', async (path) => {
    const { get } = apiFixture();
    const result = await get('alice', path + '?symbol=UNKNOWN').expect(404);
    expect(result.body.error.code).toBe('STOCK_NOT_FOUND');
  });

  it.each(['status=UNKNOWN', 'status=', 'status=OPEN&status=FILLED'])(
    'rejects invalid order status %s',
    async (query) => {
      const { get } = apiFixture();
      await get('alice', '/api/me/orders?' + query).expect(400);
    },
  );

  it.each(['/api/me/trades', '/api/trades'])('does not accept order status on %s', async (path) => {
    const { get } = apiFixture();
    await get('alice', path + '?status=FILLED').expect(400);
  });
});

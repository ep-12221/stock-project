import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { apiFixture, buy, keyedOrder, origin } from './trading-api-fixture.js';
import { expectInvariants, state, totals } from './trading-fixture.js';

describe('POST /api/orders', () => {
  it('creates an OPEN order for the session user and returns the committed snapshot with no internal trade data', async () => {
    const { store, post } = apiFixture();
    const response = await post('alice').expect(201);
    expect(Object.keys(response.body.data).sort()).toEqual(['order', 'snapshot']);
    expect(response.body.data.order).toMatchObject({
      ...buy,
      status: 'OPEN',
      sequence: 1,
      filledQuantity: 0,
    });
    expect(response.body.data.order).not.toHaveProperty('userId');
    expect(response.body.data.snapshot).toMatchObject({
      serverEpoch: store.serverEpoch,
      userId: 'alice',
      accountVersion: 1,
      account: {
        cashBalanceCents: 100_000_000,
        frozenCashCents: 10_000,
        availableCashCents: 99_990_000,
      },
      activeOrders: [response.body.data.order],
      recentClosedOrders: [],
      recentTrades: [],
    });
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.headers['x-request-id']).toBeTruthy();
    expectInvariants(store);
  });

  it.each(['BUY', 'SELL'] as const)(
    'matches an incoming %s at the resting price and exposes both users updated state',
    async (side) => {
      const { store, post, get } = apiFixture();
      const baseline = totals(store);
      const makerUser = side === 'BUY' ? 'bob' : 'alice';
      const takerUser = side === 'BUY' ? 'alice' : 'bob';
      const makerPrice = side === 'BUY' ? 980 : 1_020;
      const maker = await post(makerUser, {
        ...keyedOrder(),
        side: side === 'BUY' ? 'SELL' : 'BUY',
        priceCents: makerPrice,
      }).expect(201);
      const result = await post(takerUser, { ...keyedOrder(), side, quantity: 4 }).expect(201);
      expect(result.body.data.order).toMatchObject({
        status: 'FILLED',
        filledQuantity: 4,
        executedValueCents: makerPrice * 4,
      });
      const taker = result.body.data.snapshot;
      expect(taker.recentTrades[0]).toMatchObject({ side, priceCents: makerPrice, quantity: 4 });
      const other = await get(makerUser, '/api/me/snapshot').expect(200);
      expect(other.body.data.activeOrders[0]).toMatchObject({
        id: maker.body.data.order.id,
        status: 'PARTIALLY_FILLED',
        filledQuantity: 4,
      });
      expect(other.body.data.accountVersion).toBe(2);
      expect(other.body.data.recentTrades[0].id).toBe(taker.recentTrades[0].id);
      const stocks = await get(takerUser, '/api/stocks').expect(200);
      expect(stocks.body.data.marketVersion).toBe(2);
      expect(JSON.stringify(result.body)).not.toMatch(
        /buyerUserId|sellerUserId|buyOrderId|sellOrderId|affectedUserIds|passwordHash/,
      );
      expect(totals(store)).toEqual(baseline);
      expectInvariants(store);
    },
  );

  it('returns a partial incoming order with exactly the unfilled limit value frozen', async () => {
    const { post } = apiFixture();
    await post('bob', { ...keyedOrder(), side: 'SELL', priceCents: 980, quantity: 4 }).expect(201);
    const response = await post('alice').expect(201);
    expect(response.body.data.order).toMatchObject({
      status: 'PARTIALLY_FILLED',
      filledQuantity: 4,
    });
    expect(response.body.data.snapshot.account).toEqual({
      cashBalanceCents: 99_996_080,
      frozenCashCents: 6_000,
      availableCashCents: 99_990_080,
    });
  });

  it.each([
    [{ ...keyedOrder(), priceCents: 0 }, 400, 'VALIDATION_ERROR'],
    [{ ...keyedOrder(), quantity: 1.5 }, 400, 'VALIDATION_ERROR'],
    [{ ...keyedOrder(), side: 'buy' }, 400, 'VALIDATION_ERROR'],
    [{ ...keyedOrder(), userId: 'bob' }, 400, 'VALIDATION_ERROR'],
    [{ ...keyedOrder(), sequence: 1 }, 400, 'VALIDATION_ERROR'],
    [{ ...keyedOrder(), clientOrderId: 'not-enabled' }, 400, 'VALIDATION_ERROR'],
    [{ ...keyedOrder(), symbol: 'UNKNOWN' }, 404, 'STOCK_NOT_FOUND'],
    [{ ...keyedOrder(), priceCents: 10_000_000, quantity: 100_000 }, 409, 'INSUFFICIENT_FUNDS'],
    [{ ...keyedOrder(), side: 'SELL' }, 409, 'INSUFFICIENT_POSITION'],
  ])('maps business rejection %j to %s without side effects', async (input, status, code) => {
    const { store, post } = apiFixture();
    const before = state(store);
    const response = await post('alice', input).expect(status as number);
    expect(response.body.error.code).toBe(code);
    expect(response.body.requestId).toBe(response.headers['x-request-id']);
    expect(response.body.requestId).toBeTruthy();
    expect(response.headers['cache-control']).toBe('no-store');
    expect(state(store)).toEqual(before);
  });

  it('maps self-trade rejection and preserves earlier external resting orders', async () => {
    const { store, post } = apiFixture();
    await post('carol', { ...keyedOrder(), side: 'SELL', priceCents: 990, quantity: 5 }).expect(
      201,
    );
    await post('bob', { ...keyedOrder(), side: 'SELL' }).expect(201);
    const before = state(store);
    const response = await post('bob').expect(409);
    expect(response.body.error.code).toBe('SELF_TRADE_PREVENTED');
    expect(state(store)).toEqual(before);
  });

  it('returns the documented 429 when active capacity is exhausted', async () => {
    const { store, post } = apiFixture({ maxActiveOrdersPerUser: 1 });
    await post('alice').expect(201);
    const before = state(store);
    const response = await post('alice').expect(429);
    expect(response.body.error.code).toBe('ORDER_LIMIT_REACHED');
    expect(state(store)).toEqual(before);
  });

  it('returns an opaque 500 with request ID for failed settlement and does not partially commit', async () => {
    const { store, post } = apiFixture();
    await post('bob', { ...keyedOrder(), side: 'SELL' }).expect(201);
    store.accounts.get('bob')!.cashBalanceCents = Number.MAX_SAFE_INTEGER;
    const before = state(store);
    const response = await post('alice').expect(500);
    expect(response.body.error.code).toBe('INTERNAL_ERROR');
    expect(response.body.requestId).toBeTruthy();
    expect(JSON.stringify(response.body)).not.toMatch(
      /stack|password|MAX_SAFE|buyerUserId|sellerUserId/,
    );
    expect(state(store)).toEqual(before);
  });

  it('serializes concurrent HTTP commands against the same available cash', async () => {
    const { store, post } = apiFixture();
    store.accounts.get('alice')!.cashBalanceCents = 10_000;
    const results = await Promise.all([post('alice'), post('alice')]);
    expect(results.map((r) => r.status).sort()).toEqual([201, 409]);
    expect(store.orders.size).toBe(1);
    expectInvariants(store);
  });

  it('serializes competing buyers so a resting share is never sold twice', async () => {
    const { store, post } = apiFixture();
    await post('bob', { ...keyedOrder(), side: 'SELL', quantity: 1 }).expect(201);
    const results = await Promise.all([
      post('alice', { ...keyedOrder(), quantity: 1 }),
      post('dave', { ...keyedOrder(), quantity: 1 }),
    ]);
    expect(results.map((r) => r.status)).toEqual([201, 201]);
    expect(results.map((r) => r.body.data.order.status).sort()).toEqual(['FILLED', 'OPEN']);
    expect(store.trades.size).toBe(1);
    expectInvariants(store);
  });
});

describe('trading API access controls', () => {
  it.each(['/api/orders', '/api/me/orders', '/api/me/trades', '/api/trades'])(
    'rejects missing and forged sessions on %s',
    async (path) => {
      const { app, store } = apiFixture();
      const before = state(store);
      for (const cookie of ['', 'stock_session=forged']) {
        const call =
          path === '/api/orders'
            ? request(app).post(path).set('Origin', origin).send(buy)
            : request(app).get(path);
        const response = await call.set('Cookie', cookie).expect(401);
        expect(response.body.error.code).toBe('UNAUTHENTICATED');
        expect(response.headers['cache-control']).toBe('no-store');
      }
      expect(state(store)).toEqual(before);
    },
  );

  it.each([undefined, 'null', 'https://attacker.example'])(
    'rejects Origin %s before changing the book',
    async (disallowed) => {
      const { app, store, cookies } = apiFixture();
      const before = state(store);
      const call = request(app).post('/api/orders').set('Cookie', cookies.get('alice')!).send(buy);
      if (disallowed !== undefined) call.set('Origin', disallowed);
      const response = await call.expect(403);
      expect(response.body.error.code).toBe('FORBIDDEN_ORIGIN');
      expect(state(store)).toEqual(before);
    },
  );

  it.each(['form', 'text'])('rejects %s bodies', async (type) => {
    const { app, store, cookies } = apiFixture();
    const before = state(store);
    const response = await request(app)
      .post('/api/orders')
      .set('Origin', origin)
      .set('Cookie', cookies.get('alice')!)
      .type(type)
      .send(type === 'form' ? buy : JSON.stringify(buy))
      .expect(415);
    expect(response.body.error.code).toBe('UNSUPPORTED_MEDIA_TYPE');
    expect(state(store)).toEqual(before);
  });

  it.each([
    { label: 'malformed', body: '{"quantity":', status: 400, code: 'VALIDATION_ERROR' },
    {
      label: 'oversized',
      body: JSON.stringify({ text: 'x'.repeat(17_000) }),
      status: 413,
      code: 'PAYLOAD_TOO_LARGE',
    },
  ])('rejects $label JSON', async ({ body, status, code }) => {
    const { app, store, cookies } = apiFixture();
    const before = state(store);
    const response = await request(app)
      .post('/api/orders')
      .set('Origin', origin)
      .set('Cookie', cookies.get('alice')!)
      .type('json')
      .send(body as string)
      .expect(status as number);
    expect(response.body.error.code).toBe(code);
    expect(state(store)).toEqual(before);
  });

  it('refuses expired sessions before accepting a command', async () => {
    const { store, post } = apiFixture();
    store.now = () => 1_700_000_001_000;
    await post('alice').expect(401);
    expect(store.orders.size).toBe(0);
    expect(store.accounts.get('alice')?.frozenCashCents).toBe(0);
  });

  it('refuses commands after logout while another user can still trade', async () => {
    const { app, cookies, post } = apiFixture();
    await request(app)
      .post('/api/auth/logout')
      .set('Cookie', cookies.get('alice')!)
      .set('Origin', origin)
      .expect(204);
    await post('alice').expect(401);
    await post('dave').expect(201);
  });
});

it.each([
  ['Content-Type', 'application/json; charset=iso-8859-1'],
  ['Content-Encoding', 'unsupported'],
])('returns 415 for unsupported %s without trading side effects', async (header, value) => {
  const { app, store, cookies } = apiFixture();
  const before = state(store);
  const response = await request(app)
    .post('/api/orders')
    .set('Origin', origin)
    .set('Cookie', cookies.get('alice')!)
    .set('Content-Type', 'application/json')
    .set(header!, value!)
    .send(JSON.stringify(buy));
  expect(response.status).toBe(415);
  expect(response.body.error.code).toBe('UNSUPPORTED_MEDIA_TYPE');
  expect(response.body.requestId).toBeTruthy();
  expect(state(store)).toEqual(before);
});

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

const base = process.argv[2] ?? 'http://127.0.0.1:3003';
const origin = new URL(base).origin;
const password = 'local-smoke-password';
async function call(path, { method = 'GET', cookie, body, status = 200 } = {}) {
  const headers = { Origin: origin };
  if (cookie) headers.Cookie = cookie;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const response = await fetch(new URL(path, base), {
    method,
    headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(5_000),
  });
  assert.equal(response.status, status, method + ' ' + path);
  const result = status === 204 ? null : await response.json();
  return {
    data: result?.data,
    error: result?.error,
    cookie: response.headers.getSetCookie()[0]?.split(';')[0],
  };
}
const suffix = randomUUID().slice(0, 8);
const a = await call('/api/auth/register', {
  method: 'POST',
  body: { username: 'smokea_' + suffix, password },
  status: 201,
});
const b = await call('/api/auth/register', {
  method: 'POST',
  body: { username: 'smokeb_' + suffix, password },
  status: 201,
});
assert.ok(a.cookie && b.cookie && a.cookie !== b.cookie);
for (const user of [a, b]) {
  const snapshot = await call('/api/me/snapshot', { cookie: user.cookie });
  assert.equal(snapshot.data.account.availableCashCents, 100_000_000);
  assert.deepEqual(snapshot.data.positions, []);
}
const quotes = await call('/api/stocks', { cookie: a.cookie });
assert.equal(quotes.data.quotes.length, 3);
assert.ok(quotes.data.marketVersion >= 6, 'fresh seed state may already have market ticks');
assert.equal(quotes.data.quotes[0].bestBidCents, 999);
assert.equal(quotes.data.quotes[0].bestAskCents, 1_001);
const submit = (cookie, side, priceCents, quantity, status = 201) =>
  call('/api/orders', {
    method: 'POST',
    cookie,
    body: { symbol: 'SIM001', side, priceCents, quantity, clientOrderId: randomUUID() },
    status,
  });
const aBuy = await submit(a.cookie, 'BUY', 1_001, 100);
assert.equal(aBuy.data.order.status, 'FILLED');
assert.equal(aBuy.data.snapshot.account.cashBalanceCents, 99_899_900);
const bBuy = await submit(b.cookie, 'BUY', 1_001, 50);
assert.equal(bBuy.data.snapshot.account.cashBalanceCents, 99_949_950);
const ask = await submit(a.cookie, 'SELL', 1_000, 100);
assert.equal(ask.data.order.status, 'OPEN');
const fill = await submit(b.cookie, 'BUY', 1_000, 40);
assert.equal(fill.data.order.status, 'FILLED');
const aState = (await call('/api/me/snapshot', { cookie: a.cookie })).data;
const bState = (await call('/api/me/snapshot', { cookie: b.cookie })).data;
assert.equal(aState.account.cashBalanceCents, 99_939_900);
assert.equal(bState.account.cashBalanceCents, 99_909_950);
assert.deepEqual(aState.positions, [
  { symbol: 'SIM001', quantity: 60, frozenQuantity: 60, availableQuantity: 0 },
]);
assert.deepEqual(bState.positions, [
  { symbol: 'SIM001', quantity: 90, frozenQuantity: 0, availableQuantity: 90 },
]);
assert.equal(aState.activeOrders[0].id, ask.data.order.id);
assert.equal(aState.activeOrders[0].status, 'PARTIALLY_FILLED');
assert.equal((await submit(a.cookie, 'SELL', 1_000, 1, 409)).error.code, 'INSUFFICIENT_POSITION');
assert.equal(
  (await submit(b.cookie, 'BUY', 10_000_000, 100_000, 409)).error.code,
  'INSUFFICIENT_FUNDS',
);
assert.deepEqual((await call('/api/me/snapshot', { cookie: a.cookie })).data, aState);
assert.deepEqual((await call('/api/me/snapshot', { cookie: b.cookie })).data, bState);
const partial = await call('/api/me/orders?status=PARTIALLY_FILLED&symbol=SIM001', {
  cookie: a.cookie,
});
assert.equal(partial.data.items.length, 1);
assert.equal(partial.data.items[0].id, ask.data.order.id);
const personal = await call('/api/me/trades', { cookie: a.cookie });
assert.deepEqual(
  personal.data.items.map((t) => t.side),
  ['SELL', 'BUY'],
);
const market = await call('/api/trades?limit=2', { cookie: b.cookie });
assert.deepEqual(
  market.data.items.map((t) => t.sequence),
  [3, 2],
);
assert.equal(market.data.nextCursor, 2);
const tail = await call('/api/trades?limit=2&cursor=2', { cookie: b.cookie });
assert.deepEqual(
  tail.data.items.map((t) => t.sequence),
  [1],
);
assert.equal(tail.data.nextCursor, null);
for (const trade of [...market.data.items, ...tail.data.items]) {
  assert.deepEqual(
    Object.keys(trade).sort(),
    ['id', 'sequence', 'symbol', 'priceCents', 'quantity', 'executedAt'].sort(),
  );
}
await call('/api/trades', { status: 401 });
await call('/api/orders', {
  method: 'POST',
  cookie: a.cookie,
  body: {
    symbol: 'SIM001',
    side: 'BUY',
    priceCents: 1,
    quantity: 1,
    clientOrderId: randomUUID(),
    userId: b.data.user.id,
  },
  status: 400,
});
const loginPage = await fetch(new URL('/login', base), { signal: AbortSignal.timeout(5_000) });
assert.equal(loginPage.status, 200);
assert.match(loginPage.headers.get('content-type'), /text\/html/);
await call('/api/auth/logout', { method: 'POST', cookie: a.cookie, status: 204 });
await submit(a.cookie, 'BUY', 1, 1, 401);
await call('/api/me/orders', { cookie: b.cookie });
console.log(
  JSON.stringify(
    {
      result: 'passed',
      independentSessions: 2,
      initialMarketVersion: quotes.data.marketVersion,
      trades: 3,
      aliceCashCents: aState.account.cashBalanceCents,
      aliceShares: 60,
      aliceFrozenShares: 60,
      bravoCashCents: bState.account.cashBalanceCents,
      bravoShares: 90,
      verified: [
        'seed liquidity',
        'real matching',
        'partial fill',
        'rejection atomicity',
        'history pagination',
        'private and public DTOs',
        'session isolation',
        'production static entry',
      ],
    },
    null,
    2,
  ),
);

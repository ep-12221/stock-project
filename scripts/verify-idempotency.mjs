import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

// Run against a separate fresh server with ENABLE_DEMO_LIQUIDITY=false.
const base = process.argv[2] ?? 'http://127.0.0.1:4328';
const origin = new URL(base).origin;
const suffix = randomUUID().slice(0, 8);
async function call(path, { method = 'GET', cookie, body, status = 200 } = {}) {
  const response = await fetch(new URL(path, base), {
    method,
    headers: {
      Origin: origin,
      ...(cookie ? { Cookie: cookie } : {}),
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(5000),
  });
  assert.equal(response.status, status, method + ' ' + path);
  const payload = await response.json();
  return { ...payload, cookie: response.headers.getSetCookie()[0]?.split(';')[0] };
}
async function register(prefix) {
  return call('/api/auth/register', {
    method: 'POST',
    status: 201,
    body: { username: prefix + suffix, password: 'local-idempotency-password' },
  });
}
const [a, b] = await Promise.all([register('idem_a_'), register('idem_b_')]);
const request = {
  symbol: 'SIM001',
  side: 'BUY',
  priceCents: 1000,
  quantity: 100,
  clientOrderId: randomUUID(),
};
const post = (cookie, body, status) =>
  call('/api/orders', { method: 'POST', cookie, body, status });
const first = await post(a.cookie, request, 201);
assert.equal(first.data.order.status, 'OPEN');
const originalSnapshot = first.data.snapshot;
const repeats = await Promise.all(Array.from({ length: 8 }, () => post(a.cookie, request, 200)));
for (const replay of repeats) {
  assert.deepEqual(replay.data.order, first.data.order);
  assert.deepEqual(replay.data.snapshot, originalSnapshot);
}
const different = await post(a.cookie, { ...request, quantity: 101 }, 409);
assert.equal(different.error.code, 'IDEMPOTENCY_CONFLICT');
const state = (await call('/api/me/snapshot', { cookie: a.cookie })).data;
assert.deepEqual(state, originalSnapshot);
const otherUser = await post(b.cookie, request, 201);
assert.notEqual(otherUser.data.order.id, first.data.order.id);
assert.equal(otherUser.data.snapshot.account.frozenCashCents, 100000);
const uppercase = await post(
  a.cookie,
  { ...request, clientOrderId: request.clientOrderId.toUpperCase() },
  200,
);
assert.equal(uppercase.data.order.id, first.data.order.id);
const invalid = await post(a.cookie, { ...request, clientOrderId: 'not-a-uuid' }, 400);
assert.equal(invalid.error.code, 'VALIDATION_ERROR');
const { clientOrderId: unusedKey, ...missing } = request;
assert.ok(unusedKey);
assert.equal((await post(a.cookie, missing, 400)).error.code, 'VALIDATION_ERROR');
assert.equal((await call('/api/me/orders', { cookie: a.cookie })).data.items.length, 1);
assert.equal((await call('/api/me/trades', { cookie: a.cookie })).data.items.length, 0);
console.log(
  JSON.stringify({
    result: 'passed',
    concurrentReplays: 8,
    ordersPerUser: 1,
    conflictHasNoSideEffects: true,
    keyIsolatedByUser: true,
    uuidCaseNormalized: true,
    malformedAndMissingKeysRejected: true,
  }),
);

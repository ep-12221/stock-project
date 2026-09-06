import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import { createApp } from '../app.js';
import { apiFixture, buy, origin } from './trading-api-fixture.js';
import { state, expectInvariants } from './trading-fixture.js';

const command = () => ({ ...buy, clientOrderId: randomUUID() });

describe('POST /api/orders idempotency contract', () => {
  it('requires a key explicitly, while rejecting invalid keys and extra fields', async () => {
    const { post, store } = apiFixture();
    const before = state(store);
    for (const input of [
      buy,
      { ...buy, clientOrderId: null },
      { ...buy, clientOrderId: 'bad' },
      { ...command(), userId: 'bob' },
    ]) {
      const response = await post('alice', input).expect(400);
      expect(response.body.error.code).toBe('VALIDATION_ERROR');
    }
    expect(state(store)).toEqual(before);
  });

  it('returns 201 once, then 200 with the same order and current snapshot', async () => {
    const { post, submit, store } = apiFixture();
    const input = command();
    const original = await post('alice', input).expect(201);
    submit('bob', 'SELL', 1_000, 10);
    const before = state(store);
    const replay = await post('alice', input).expect(200);
    expect(Object.keys(replay.body.data).sort()).toEqual(['order', 'snapshot']);
    expect(replay.body.data.order).toMatchObject({
      id: original.body.data.order.id,
      status: 'FILLED',
      filledQuantity: 10,
    });
    expect(replay.body.data.snapshot).toMatchObject({
      userId: 'alice',
      serverEpoch: store.serverEpoch,
      accountVersion: 2,
      activeOrders: [],
    });
    expect(replay.body.data.snapshot.recentClosedOrders).toEqual([replay.body.data.order]);
    expect(replay.body.data.snapshot.recentTrades).toHaveLength(1);
    expect(replay.headers['cache-control']).toBe('no-store');
    expect(replay.body.data.order).not.toHaveProperty('clientOrderId');
    expect(state(store)).toEqual(before);
  });

  it('serializes concurrent requests with the same key into exactly one settlement', async () => {
    const { post, submit, store } = apiFixture();
    submit('bob', 'SELL', 980, 10);
    const input = command();
    const responses = await Promise.all(Array.from({ length: 8 }, () => post('alice', input)));
    expect(responses.map((r) => r.status).sort()).toEqual([200, 200, 200, 200, 200, 200, 200, 201]);
    expect(new Set(responses.map((r) => r.body.data.order.id)).size).toBe(1);
    expect(store.orders.size).toBe(2);
    expect(store.trades.size).toBe(1);
    expect(store.marketVersion).toBe(2);
    expect(store.accounts.get('alice')!.version).toBe(1);
    expectInvariants(store);
  });

  it('rejects conflicting reuse with 409 and retains the successful mapping', async () => {
    const { post, store } = apiFixture();
    const input = command();
    const first = await post('alice', input).expect(201);
    const before = state(store);
    const conflict = await post('alice', { ...input, quantity: 11 }).expect(409);
    expect(conflict.body.error.code).toBe('IDEMPOTENCY_CONFLICT');
    expect(conflict.body.requestId).toBeTruthy();
    expect(state(store)).toEqual(before);
    expect((await post('alice', input).expect(200)).body.data.order.id).toBe(
      first.body.data.order.id,
    );
  });

  it('never invokes post-commit publication for a replay, even if first publication fails', async () => {
    const { store, sessions, cookies } = apiFixture();
    const hook = vi.fn(() => {
      throw new Error('delivery unavailable');
    });
    const app = createApp({ store, sessions, allowedOrigins: [origin], onTradeCommitted: hook });
    const input = command();
    const post = () =>
      request(app)
        .post('/api/orders')
        .set('Origin', origin)
        .set('Cookie', cookies.get('alice')!)
        .send(input);
    const first = await post().expect(201);
    const before = state(store);
    const replay = await post().expect(200);
    expect(replay.body.data.order.id).toBe(first.body.data.order.id);
    expect(hook).toHaveBeenCalledTimes(1);
    expect(state(store)).toEqual(before);
  });

  it('allows independent users to use the same key and refuses a revoked session replay', async () => {
    const { post, sessions, cookies, store } = apiFixture();
    const input = command();
    const alice = await post('alice', input).expect(201);
    const dave = await post('dave', { ...input, quantity: 1 }).expect(201);
    expect(alice.body.data.order.id).not.toBe(dave.body.data.order.id);
    sessions.revoke(cookies.get('alice')!.split('=')[1]!);
    await post('alice', input).expect(401);
    expect(store.orders.size).toBe(2);
  });
});

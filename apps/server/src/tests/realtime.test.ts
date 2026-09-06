import { createServer } from 'node:http';
import { once } from 'node:events';
import { connect as connectTcp, type AddressInfo } from 'node:net';
import type { RealtimeEvent } from '@stock/shared';
import request from 'supertest';
import WebSocket from 'ws';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../app.js';
import { createRealtimeService } from '../services/realtime.service.js';
import { createSessionService } from '../services/session.service.js';
import { fixture } from './trading-fixture.js';
import { buy, keyedOrder, origin } from './trading-api-fixture.js';

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const cleanup of cleanups.splice(0)) await cleanup();
  vi.useRealTimers();
});

async function setup(
  options: {
    ttlMs?: number;
    heartbeatIntervalMs?: number;
    marketIntervalMs?: number;
    maxBufferedBytes?: number;
  } = {},
) {
  const core = fixture();
  const sessions = createSessionService(core.store, { ttlMs: options.ttlMs ?? 60_000 });
  const tokens = new Map(['alice', 'bob', 'carol'].map((id) => [id, sessions.create(id).id]));
  const realtime = createRealtimeService({
    store: core.store,
    sessions,
    allowedOrigins: [origin],
    random: () => 0.99,
    marketIntervalMs: options.marketIntervalMs ?? 60_000,
    heartbeatIntervalMs: options.heartbeatIntervalMs ?? 60_000,
    ...(options.maxBufferedBytes === undefined
      ? {}
      : { maxBufferedBytes: options.maxBufferedBytes }),
  });
  const app = createApp({
    store: core.store,
    sessions,
    allowedOrigins: [origin],
    onTradeCommitted: realtime.publishTrade,
  });
  const server = createServer(app);
  realtime.attach(server);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const url = 'ws://127.0.0.1:' + (server.address() as AddressInfo).port + '/ws';
  const clients: WebSocket[] = [];
  cleanups.push(async () => {
    for (const client of clients) client.terminate();
    realtime.close();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  async function connect(user = 'alice', autoPong = true) {
    const ws = new WebSocket(url, {
      origin,
      headers: { Cookie: 'stock_session=' + tokens.get(user) },
      autoPong,
    });
    clients.push(ws);
    const messages: RealtimeEvent[] = [];
    ws.on('message', (data) => messages.push(JSON.parse(data.toString()) as RealtimeEvent));
    ws.on('error', () => undefined);
    await once(ws, 'open');
    await vi.waitFor(() => expect(messages.length).toBeGreaterThan(0));
    return { ws, messages };
  }
  const post = (user: string, body: unknown = keyedOrder()) =>
    request(server)
      .post('/api/orders')
      .set('Origin', origin)
      .set('Cookie', 'stock_session=' + tokens.get(user))
      .send(body as object);
  return { ...core, sessions, tokens, realtime, app, server, url, clients, connect, post };
}

describe('authenticated WebSocket snapshots', () => {
  it('registers a connection with exactly one complete first snapshot and explicit identity', async () => {
    const { connect, store, realtime } = await setup();
    const { messages } = await connect();
    expect(messages).toHaveLength(1);
    expect(messages[0]).toEqual({
      type: 'state.snapshot',
      serverEpoch: store.serverEpoch,
      emittedAt: new Date(store.now()).toISOString(),
      payload: {
        market: { marketVersion: 0, quotes: [...store.stocks.values()], recentTrades: [] },
        account: expect.objectContaining({
          userId: 'alice',
          serverEpoch: store.serverEpoch,
          accountVersion: 0,
        }),
      },
    });
    expect(realtime.connectionCount).toBe(1);
  });

  it.each([
    { label: 'missing origin', expected: 403 },
    { label: 'hostile origin', origin: 'https://evil.test', expected: 403 },
    { label: 'missing cookie', origin, expected: 401 },
    { label: 'forged cookie', origin, cookie: 'stock_session=forged', expected: 401 },
    { label: 'wrong path', origin, valid: true, path: '/other', expected: 404 },
    { label: 'expired session', origin, valid: true, expired: true, expected: 401 },
  ])('rejects $label before upgrading', async (test) => {
    const f = await setup();
    if (test.expired) f.store.now = () => 1_700_000_060_000;
    const cookie = test.valid ? 'stock_session=' + f.tokens.get('alice') : test.cookie;
    const ws = new WebSocket(test.path ? f.url.replace('/ws', test.path) : f.url, {
      ...(test.origin ? { origin: test.origin } : {}),
      ...(cookie ? { headers: { Cookie: cookie } } : {}),
    });
    f.clients.push(ws);
    ws.on('error', () => undefined);
    const status = await new Promise<number>((resolve) =>
      ws.once('unexpected-response', (_req, res) => {
        res.resume();
        resolve(res.statusCode!);
        ws.terminate();
      }),
    );
    expect(status).toBe(test.expected);
    expect(f.realtime.connectionCount).toBe(0);
  });

  it('publishes public market state once and affected private state once per connection after committed orders', async () => {
    const f = await setup();
    const alice = await f.connect();
    const aliceTab = await f.connect();
    const bob = await f.connect('bob');
    const carol = await f.connect('carol');
    await f.post('bob', { ...keyedOrder(), side: 'SELL', priceCents: 980 }).expect(201);
    // Delivery on one socket does not imply that the other sockets have drained.
    await vi.waitFor(() => {
      expect(bob.messages).toHaveLength(3);
      for (const peer of [alice, aliceTab, carol]) expect(peer.messages).toHaveLength(2);
    });
    for (const peer of [alice, aliceTab, bob, carol]) peer.messages.length = 0;
    const response = await f.post('alice', { ...keyedOrder(), quantity: 4 }).expect(201);
    await vi.waitFor(() => {
      expect(alice.messages).toHaveLength(2);
      expect(aliceTab.messages).toHaveLength(2);
      expect(bob.messages).toHaveLength(2);
      expect(carol.messages).toHaveLength(1);
    });
    for (const peer of [alice, aliceTab, bob, carol]) {
      expect(peer.messages[0]!.type).toBe('market.updated');
      const market = peer.messages[0]!;
      if (market.type !== 'market.updated') throw new Error('Expected market');
      expect(market.payload.recentTrades).toHaveLength(1);
      expect(JSON.stringify(market)).not.toMatch(
        /userId|buyerUserId|sellerUserId|orderId|password/,
      );
    }
    expect(alice.messages[1]!.payload).toEqual(response.body.data.snapshot);
    expect(bob.messages[1]!.payload).toMatchObject({
      userId: 'bob',
      accountVersion: 2,
      activeOrders: [expect.objectContaining({ filledQuantity: 4, status: 'PARTIALLY_FILLED' })],
      positions: expect.arrayContaining([
        expect.objectContaining({ symbol: 'SIM001', quantity: 996, frozenQuantity: 6 }),
      ]),
    });
    expect(JSON.stringify(alice.messages[1])).not.toMatch(/bob|buyerUserId|sellerUserId/);
  });

  it('does not publish duplicate public or private frames when a committed order is replayed', async () => {
    const f = await setup();
    const alice = await f.connect();
    const bob = await f.connect('bob');
    const input = keyedOrder();
    const original = await f.post('alice', input).expect(201);
    await vi.waitFor(() => {
      expect(alice.messages).toHaveLength(3);
      expect(bob.messages).toHaveLength(2);
    });
    const sends = [...f.realtime.webSocketServer.clients].map((socket) => vi.spyOn(socket, 'send'));
    const replay = await f.post('alice', input).expect(200);
    expect(replay.body.data).toEqual(original.body.data);
    for (const send of sends) expect(send).not.toHaveBeenCalled();
    expect(alice.messages).toHaveLength(3);
    expect(bob.messages).toHaveLength(2);
  });

  it('sends nothing for rejected orders and never turns a publisher failure into an HTTP failure', async () => {
    const f = await setup();
    const peer = await f.connect();
    peer.messages.length = 0;
    await f.post('alice', { ...keyedOrder(), side: 'SELL' }).expect(409);
    expect(peer.messages).toEqual([]);
    const callback = vi.fn(() => {
      throw new Error('publisher unavailable');
    });
    const app = createApp({
      store: f.store,
      sessions: f.sessions,
      allowedOrigins: [origin],
      onTradeCommitted: callback,
    });
    await request(app)
      .post('/api/orders')
      .set('Origin', origin)
      .set('Cookie', 'stock_session=' + f.tokens.get('alice'))
      .send(keyedOrder())
      .expect(201);
    expect(callback).toHaveBeenCalledOnce();
    expect(f.store.orders.size).toBe(1);
  });

  it('closes only the revoked session immediately and keeps another session for the same user active', async () => {
    const f = await setup();
    const first = await f.connect();
    const second = await f.connect();
    f.tokens.set('alice', f.sessions.create('alice').id);
    const otherSession = await f.connect();
    const closed = Promise.all([once(first.ws, 'close'), once(second.ws, 'close')]);
    const original = [...f.store.sessions.values()].find((s) => s.userId === 'alice')!;
    await request(f.server)
      .post('/api/auth/logout')
      .set('Origin', origin)
      .set('Cookie', 'stock_session=' + original.id)
      .expect(204);
    expect((await closed).map(([code]) => code)).toEqual([4401, 4401]);
    expect(otherSession.ws.readyState).toBe(WebSocket.OPEN);
    await f.post('alice').expect(201);
    await vi.waitFor(() => expect(otherSession.messages).toHaveLength(3));
    expect(first.messages).toHaveLength(1);
    expect(f.realtime.connectionCount).toBe(1);
  });

  it('stops expired connections before any publication, even before the cleanup interval', async () => {
    const f = await setup();
    const peer = await f.connect();
    const closed = once(peer.ws, 'close');
    f.store.now = () => 1_700_000_060_000;
    f.realtime.publishTrade(['alice']);
    expect((await closed)[0]).toBe(4401);
    expect(peer.messages).toHaveLength(1);
    expect(f.realtime.connectionCount).toBe(0);
  });

  it.each(['throw', 'callback'] as const)(
    'isolates socket send %s from the committed command and healthy peers',
    async (failure) => {
      const f = await setup();
      const broken = await f.connect();
      const healthy = await f.connect('bob');
      const serverSocket = [...f.realtime.webSocketServer.clients][0]!;
      vi.spyOn(serverSocket, 'send').mockImplementation((_data, optionsOrCallback, callback) => {
        if (failure === 'throw') throw new Error('send failed');
        const cb = typeof optionsOrCallback === 'function' ? optionsOrCallback : callback;
        cb?.(new Error('send failed'));
      });
      const closed = once(broken.ws, 'close');
      await f.post('alice').expect(201);
      await closed;
      await vi.waitFor(() => expect(healthy.messages).toHaveLength(2));
      expect(f.store.accounts.get('alice')!.frozenCashCents).toBe(10_000);
      expect(f.realtime.connectionCount).toBe(1);
    },
  );

  it('isolates an errored socket and cleans its expiry timer before subsequent broadcasts', async () => {
    const f = await setup();
    const broken = await f.connect();
    const healthy = await f.connect('bob');
    const serverPeer = [...f.realtime.webSocketServer.clients][0]!;
    const closed = once(broken.ws, 'close');
    expect(() => serverPeer.emit('error', new Error('transport failure'))).not.toThrow();
    await closed;
    await f.post('bob', { ...keyedOrder(), side: 'SELL' }).expect(201);
    await vi.waitFor(() => expect(healthy.messages).toHaveLength(3));
    expect(f.realtime.connectionCount).toBe(1);
    expect(broken.messages).toHaveLength(1);
  });

  it('terminates slow connections instead of indefinitely buffering snapshots', async () => {
    const f = await setup({ maxBufferedBytes: 1_000_000 });
    const peer = await f.connect();
    const serverSocket = [...f.realtime.webSocketServer.clients][0]!;
    Object.defineProperty(serverSocket, 'bufferedAmount', { get: () => 1_000_001 });
    const closed = once(peer.ws, 'close');
    f.realtime.publishTrade(['alice']);
    await closed;
    expect(peer.messages).toHaveLength(1);
    expect(f.realtime.connectionCount).toBe(0);
  });

  it('uses one market timer for all clients and removes timers on shutdown', async () => {
    const f = await setup({ marketIntervalMs: 1000 });
    const alice = await f.connect();
    const bob = await f.connect('bob');
    f.realtime.close();
    await Promise.all([once(alice.ws, 'close'), once(bob.ws, 'close')]);
    vi.useFakeTimers();
    const other = createRealtimeService({
      store: f.store,
      sessions: f.sessions,
      allowedOrigins: [origin],
      random: () => 0,
    });
    const server = createServer();
    const before = vi.getTimerCount();
    other.attach(server);
    vi.advanceTimersByTime(3000);
    expect(f.store.marketVersion).toBe(3);
    expect(vi.getTimerCount()).toBeGreaterThan(before);
    other.close();
    expect(vi.getTimerCount()).toBe(before);
    vi.advanceTimersByTime(5000);
    expect(f.store.marketVersion).toBe(3);
    expect(server.listenerCount('upgrade')).toBe(0);
  });

  it('broadcasts one identical market snapshot per tick to every authenticated client', async () => {
    const f = await setup();
    const alice = await f.connect();
    const bob = await f.connect('bob');
    f.realtime.close();
    await Promise.all([once(alice.ws, 'close'), once(bob.ws, 'close')]);
    // Fake only intervals; HTTP and WebSocket handshakes continue to use real event I/O.
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const realtime = createRealtimeService({
      store: f.store,
      sessions: f.sessions,
      allowedOrigins: [origin],
      random: () => 0,
    });
    realtime.attach(f.server);
    const a = await f.connect();
    const b = await f.connect('bob');
    const received = Promise.all([once(a.ws, 'message'), once(b.ws, 'message')]);
    vi.advanceTimersByTime(1000);
    await received;
    expect(f.store.marketVersion).toBe(1);
    expect(a.messages).toHaveLength(2);
    expect(b.messages).toHaveLength(2);
    expect(a.messages[1]).toEqual(b.messages[1]);
    expect(a.messages[1]!.type).toBe('market.updated');
    expect(a.messages[1]!.payload).toMatchObject({ marketVersion: 1 });
    const closed = Promise.all([once(a.ws, 'close'), once(b.ws, 'close')]);
    realtime.close();
    await closed;
    expect(vi.getTimerCount()).toBe(0);
  });

  it('closes precisely on the session TTL timer without a tick, broadcast or prune call', async () => {
    const f = await setup();
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const peer = await f.connect();
    expect(vi.getTimerCount()).toBe(1);
    f.store.now = () => 1_700_000_059_999;
    vi.advanceTimersByTime(59_999);
    expect(peer.ws.readyState).toBe(WebSocket.OPEN);
    const closed = once(peer.ws, 'close');
    f.store.now = () => 1_700_000_060_000;
    vi.advanceTimersByTime(1);
    expect((await closed)[0]).toBe(4401);
    expect(f.store.sessions.has(f.tokens.get('alice')!)).toBe(false);
    expect(f.realtime.connectionCount).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('reconnects with a complete current snapshot after a trade happened while disconnected', async () => {
    const f = await setup();
    const bob = await f.connect('bob');
    await f.post('bob', { ...keyedOrder(), side: 'SELL', priceCents: 980 }).expect(201);
    const disconnected = once(bob.ws, 'close');
    bob.ws.close();
    await disconnected;
    await f.post('alice', { ...keyedOrder(), quantity: 4 }).expect(201);
    const restored = await f.connect('bob');
    expect(restored.messages).toHaveLength(1);
    expect(restored.messages[0]).toMatchObject({
      type: 'state.snapshot',
      payload: {
        account: {
          userId: 'bob',
          accountVersion: 2,
          account: { cashBalanceCents: 100_003_920 },
          activeOrders: [expect.objectContaining({ filledQuantity: 4 })],
          recentTrades: [expect.objectContaining({ quantity: 4, side: 'SELL' })],
        },
        market: { marketVersion: 2, recentTrades: [expect.objectContaining({ quantity: 4 })] },
      },
    });
  });

  it('clears expiry timers on normal disconnect and refuses attaching a stopped service', async () => {
    const f = await setup();
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const peer = await f.connect();
    expect(vi.getTimerCount()).toBe(1);
    const disconnected = Promise.all([
      once(peer.ws, 'close'),
      once([...f.realtime.webSocketServer.clients][0]!, 'close'),
    ]);
    peer.ws.close();
    await disconnected;
    expect(vi.getTimerCount()).toBe(0);
    expect(f.realtime.connectionCount).toBe(0);
    expect(() => f.realtime.attach(f.server)).toThrow();
    f.realtime.close();
    expect(() => f.realtime.attach(f.server)).toThrow();
  });

  it('always sends the initial state before a command submitted immediately when the socket opens', async () => {
    const f = await setup();
    const ws = new WebSocket(f.url, {
      origin,
      headers: { Cookie: 'stock_session=' + f.tokens.get('alice') },
    });
    f.clients.push(ws);
    const messages: RealtimeEvent[] = [];
    ws.on('message', (data) => messages.push(JSON.parse(data.toString()) as RealtimeEvent));
    await once(ws, 'open');
    await f.post('alice').expect(201);
    await vi.waitFor(() => expect(messages).toHaveLength(3));
    expect(messages.map((event) => event.type)).toEqual([
      'state.snapshot',
      'market.updated',
      'account.updated',
    ]);
    expect(messages[0]).toMatchObject({
      payload: { account: { accountVersion: 0, activeOrders: [] } },
    });
    expect(messages[2]).toMatchObject({
      payload: { accountVersion: 1, activeOrders: [expect.objectContaining(buy)] },
    });
  });

  it('bounds shutdown when a peer never answers the close handshake and clears every timer', async () => {
    const f = await setup();
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const raw = connectTcp({ host: '127.0.0.1', port: (f.server.address() as AddressInfo).port });
    raw.on('error', () => undefined);
    try {
      await once(raw, 'connect');
      const upgraded = once(raw, 'data');
      raw.write(
        [
          'GET /ws HTTP/1.1',
          'Host: 127.0.0.1',
          'Connection: Upgrade',
          'Upgrade: websocket',
          'Sec-WebSocket-Version: 13',
          'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==',
          'Origin: ' + origin,
          'Cookie: stock_session=' + f.tokens.get('alice'),
          '',
          '',
        ].join('\r\n'),
      );
      expect((await upgraded)[0].toString()).toContain('101 Switching Protocols');
      const serverPeer = [...f.realtime.webSocketServer.clients][0]!;
      const serverClosed = once(serverPeer, 'close');
      f.realtime.close();
      expect(f.realtime.connectionCount).toBe(0);
      expect(serverPeer.readyState).toBe(WebSocket.CLOSING);
      vi.advanceTimersByTime(999);
      expect(serverPeer.readyState).toBe(WebSocket.CLOSING);
      vi.advanceTimersByTime(1);
      await serverClosed;
      expect(serverPeer.readyState).toBe(WebSocket.CLOSED);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      raw.destroy();
    }
  });

  it('rejects client commands on the push channel without changing business state', async () => {
    const f = await setup();
    const peer = await f.connect();
    const closed = once(peer.ws, 'close');
    peer.ws.send(JSON.stringify(buy));
    expect((await closed)[0]).toBe(1008);
    expect(f.store.orders.size).toBe(0);
  });

  it('terminates a connection without pong while a healthy connection survives', async () => {
    const f = await setup();
    const dead = await f.connect('alice', false);
    const healthy = await f.connect('bob');
    const pong = once([...f.realtime.webSocketServer.clients][1]!, 'pong');
    f.realtime.heartbeat();
    // Wait for the server to process the pong; no wall-clock sleeps.
    await pong;
    const closed = once(dead.ws, 'close');
    f.realtime.heartbeat();
    await closed;
    expect(healthy.ws.readyState).toBe(WebSocket.OPEN);
    expect(f.realtime.connectionCount).toBe(1);
  });
});

import { scryptSync } from 'node:crypto';
import type { Express } from 'express';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { createApp } from '../app.js';
import { createMemoryStore } from '../store/memory-store.js';
import { SYSTEM_USER_ID } from '../store/seed.js';

const origin = 'http://localhost:5173';
const password = 'correct horse battery';

function fixture(options: { secureCookies?: boolean } = {}) {
  const clock = { now: 1_700_000_000_000 };
  const store = createMemoryStore({ now: () => clock.now });
  const app = createApp({ store, sessionTtlMs: 1_000, allowedOrigins: [origin], ...options });
  return { app, store, clock };
}
function register(app: Express, username = 'alice', secret = password) {
  return request(app)
    .post('/api/auth/register')
    .set('Origin', origin)
    .send({ username, password: secret });
}
function cookieOf(response: { headers: Record<string, unknown> }): string {
  const header = response.headers['set-cookie'] as string[];
  return header[0]!.split(';')[0]!;
}

describe('registration and initial account', () => {
  it('normalizes usernames, authenticates immediately and issues exactly one million', async () => {
    const { app, store } = fixture();
    const response = await register(app, '  Alice_1  ').expect(201);
    expect(response.body.data.user.username).toBe('alice_1');
    expect(response.body.data.serverEpoch).toBe(store.serverEpoch);
    expect(response.body.data.expiresAt).toBe('2023-11-14T22:13:21.000Z');
    const cookie = cookieOf(response);
    const me = await request(app).get('/api/auth/me').set('Cookie', cookie).expect(200);
    expect(me.body.data.user).toEqual(response.body.data.user);
    const state = await request(app).get('/api/me/snapshot').set('Cookie', cookie).expect(200);
    expect(state.body.data).toMatchObject({
      serverEpoch: store.serverEpoch,
      accountVersion: 0,
      account: {
        cashBalanceCents: 100_000_000,
        frozenCashCents: 0,
        availableCashCents: 100_000_000,
      },
      positions: [],
      activeOrders: [],
      recentClosedOrders: [],
      recentTrades: [],
    });
    expect(state.body.data.userId).toBe(response.body.data.user.id);
    expect(state.headers['cache-control']).toBe('no-store');
  });

  it('stores salted scrypt hashes and never serializes credentials or tokens', async () => {
    const { app, store } = fixture();
    const a = await register(app, 'alice').expect(201);
    const b = await register(app, 'bravo').expect(201);
    const first = store.users.get(a.body.data.user.id)!;
    const second = store.users.get(b.body.data.user.id)!;
    if (first.kind !== 'USER' || second.kind !== 'USER') throw new Error('Expected users');
    expect(first.passwordSalt).toMatch(/^[a-f0-9]{32}$/);
    expect(first.passwordHash).toMatch(/^[a-f0-9]{128}$/);
    expect(first.passwordHash).toBe(scryptSync(password, first.passwordSalt, 64).toString('hex'));
    expect(first.passwordSalt).not.toBe(second.passwordSalt);
    expect(first.passwordHash).not.toBe(second.passwordHash);
    for (const body of [a.body, b.body]) {
      const encoded = JSON.stringify(body);
      expect(encoded).not.toContain(password);
      expect(encoded).not.toMatch(/passwordHash|passwordSalt|sessionId/);
    }
  });

  it('preserves password whitespace rather than silently trimming it', async () => {
    const { app } = fixture();
    await register(app, 'alice', '  password123  ').expect(201);
    await request(app)
      .post('/api/auth/login')
      .set('Origin', origin)
      .send({ username: 'ALICE', password: '  password123  ' })
      .expect(200);
    await request(app)
      .post('/api/auth/login')
      .set('Origin', origin)
      .send({ username: 'alice', password: 'password123' })
      .expect(401);
  });

  it('accepts exact username and password length boundaries', async () => {
    const { app } = fixture();
    await register(app, 'abc', '12345678').expect(201);
    await register(app, 'x'.repeat(20), 'p'.repeat(64)).expect(201);
  });

  it.each([
    { username: 'ab', password },
    { username: 'x'.repeat(21), password },
    { username: 'bad-name', password },
    { username: '中文用户', password },
    { username: '', password },
    { username: 123, password },
    { username: 'alice', password: '1234567' },
    { username: 'alice', password: 'p'.repeat(65) },
    { username: 'alice', password: null },
    { username: 'alice' },
    { username: 'alice', password, userId: SYSTEM_USER_ID },
    { username: 'alice', password, cashBalanceCents: 999_999_999 },
  ])('rejects invalid registration without mutating state: %j', async (body) => {
    const { app, store } = fixture();
    await request(app).post('/api/auth/register').set('Origin', origin).send(body).expect(400);
    expect(store.users.size).toBe(1);
    expect(store.accounts.size).toBe(1);
    expect(store.sessions.size).toBe(0);
  });

  it('rejects case-insensitive duplicates without another account or session', async () => {
    const { app, store } = fixture();
    await register(app).expect(201);
    const duplicate = await register(app, 'ALICE').expect(409);
    expect(duplicate.body.error.code).toBe('USERNAME_EXISTS');
    expect(store.users.size).toBe(2);
    expect(store.accounts.size).toBe(2);
    expect(store.sessions.size).toBe(1);
  });

  it('handles concurrent duplicate registration atomically', async () => {
    const { app, store } = fixture();
    const responses = await Promise.all([register(app, 'Alice'), register(app, 'ALICE')]);
    expect(responses.map((r) => r.status).sort()).toEqual([201, 409]);
    expect(store.users.size).toBe(2);
    expect(store.accounts.size).toBe(2);
    expect(store.sessions.size).toBe(1);
  });

  it('prevents registering the reserved system identity', async () => {
    const { app } = fixture();
    await register(app, 'SYSTEM').expect(409);
  });
});

describe('login, logout and lifetime', () => {
  it('logs in without reissuing initial assets and rotates the browser session', async () => {
    const { app, store } = fixture();
    const initial = await register(app).expect(201);
    const id = initial.body.data.user.id as string;
    store.accounts.get(id)!.cashBalanceCents = 90_000_000;
    const oldCookie = cookieOf(initial);
    const login = await request(app)
      .post('/api/auth/login')
      .set('Origin', origin)
      .set('Cookie', oldCookie)
      .send({ username: 'ALICE', password })
      .expect(200);
    expect(cookieOf(login)).not.toBe(oldCookie);
    await request(app).get('/api/auth/me').set('Cookie', oldCookie).expect(401);
    const state = await request(app)
      .get('/api/me/account')
      .set('Cookie', cookieOf(login))
      .expect(200);
    expect(state.body.data.account.cashBalanceCents).toBe(90_000_000);
    expect(store.accounts.size).toBe(2);
    expect(store.sessions.size).toBe(1);
  });

  it.each(['missing', 'system', 'alice'])(
    'uses one generic credential error for %s',
    async (username) => {
      const { app, store } = fixture();
      await register(app).expect(201);
      const result = await request(app)
        .post('/api/auth/login')
        .set('Origin', origin)
        .send({ username, password: 'wrong-password' })
        .expect(401);
      expect(result.body.error).toEqual({
        code: 'INVALID_CREDENTIALS',
        message: '用户名或密码错误',
      });
      expect(result.headers['set-cookie']).toBeUndefined();
      expect(store.sessions.size).toBe(1);
    },
  );

  it('does not revoke an existing login when a replacement login fails', async () => {
    const { app } = fixture();
    const first = await register(app).expect(201);
    const cookie = cookieOf(first);
    await request(app)
      .post('/api/auth/login')
      .set('Origin', origin)
      .set('Cookie', cookie)
      .send({ username: 'alice', password: 'wrong-password' })
      .expect(401);
    await request(app).get('/api/auth/me').set('Cookie', cookie).expect(200);
  });

  it('invalidates only the logged-out session and clears its cookie', async () => {
    const { app } = fixture();
    const a = await register(app).expect(201);
    const b = await request(app)
      .post('/api/auth/login')
      .set('Origin', origin)
      .send({ username: 'alice', password })
      .expect(200);
    const logout = await request(app)
      .post('/api/auth/logout')
      .set('Origin', origin)
      .set('Cookie', cookieOf(a))
      .expect(204);
    expect((logout.headers['set-cookie'] as unknown as string[])[0]).toContain(
      'Expires=Thu, 01 Jan 1970',
    );
    await request(app).get('/api/auth/me').set('Cookie', cookieOf(a)).expect(401);
    await request(app).get('/api/auth/me').set('Cookie', cookieOf(b)).expect(200);
  });

  it('expires at the server deadline and clears invalid browser cookies', async () => {
    const { app, clock, store } = fixture();
    const response = await register(app).expect(201);
    clock.now += 1_000;
    const expired = await request(app)
      .get('/api/auth/me')
      .set('Cookie', cookieOf(response))
      .expect(401);
    expect(expired.body.error.code).toBe('UNAUTHENTICATED');
    expect(expired.headers['set-cookie']).toBeDefined();
    expect(store.sessions.size).toBe(0);
  });

  it('does not accept old cookies after a new in-memory application is created', async () => {
    const first = fixture();
    const response = await register(first.app).expect(201);
    const second = fixture();
    await request(second.app).get('/api/auth/me').set('Cookie', cookieOf(response)).expect(401);
    expect(second.store.users.size).toBe(1);
    expect(first.store.serverEpoch).not.toBe(second.store.serverEpoch);
  });

  it('uses HttpOnly, SameSite=Lax, root path and configurable Secure cookies', async () => {
    const local = await register(fixture().app).expect(201);
    const localHeader = (local.headers['set-cookie'] as unknown as string[])[0]!;
    expect(localHeader).toContain('HttpOnly');
    expect(localHeader).toContain('SameSite=Lax');
    expect(localHeader).toContain('Path=/');
    expect(localHeader).toContain('Max-Age=1');
    expect(localHeader).not.toContain('Secure');
    const secure = await register(fixture({ secureCookies: true }).app).expect(201);
    expect((secure.headers['set-cookie'] as unknown as string[])[0]).toContain('Secure');
  });
});

describe('access control and public views', () => {
  it.each([
    '/api/auth/me',
    '/api/me/account',
    '/api/me/positions',
    '/api/me/snapshot',
    '/api/stocks',
  ])('requires a valid session for %s', async (path) => {
    const { app } = fixture();
    await request(app).get(path).expect(401);
    await request(app).get(path).set('Cookie', 'stock_session=forged').expect(401);
  });

  it('rejects anonymous logout and malformed session cookies', async () => {
    const { app } = fixture();
    await request(app).post('/api/auth/logout').set('Origin', origin).expect(401);
    await request(app).get('/api/auth/me').set('Cookie', 'stock_session=%E0%A4%A').expect(401);
  });

  it('always reads assets from the authenticated identity', async () => {
    const { app, store } = fixture();
    const a = await register(app, 'alice').expect(201);
    const b = await register(app, 'bravo').expect(201);
    const bId = b.body.data.user.id as string;
    store.accounts.get(bId)!.cashBalanceCents = 5_000;
    const account = await request(app)
      .get('/api/me/account')
      .query({ userId: bId })
      .set('Cookie', cookieOf(a))
      .expect(200);
    expect(account.body.data.account.availableCashCents).toBe(100_000_000);
    const positions = await request(app)
      .get('/api/me/positions')
      .set('Cookie', cookieOf(a))
      .expect(200);
    expect(positions.body.data.positions).toEqual([]);
  });

  it('returns three reference quotes without system inventory or credentials', async () => {
    const { app } = fixture();
    const response = await register(app).expect(201);
    const stocks = await request(app)
      .get('/api/stocks')
      .set('Cookie', cookieOf(response))
      .expect(200);
    expect(stocks.body.data.quotes.map((q: { symbol: string }) => q.symbol)).toEqual([
      'SIM001',
      'SIM002',
      'SIM003',
    ]);
    expect(stocks.body.data.marketVersion).toBe(0);
    expect(JSON.stringify(stocks.body)).not.toMatch(/password|userId|frozenQuantity/);
  });

  it.each(['/api/auth/register', '/api/auth/login', '/api/auth/logout'])(
    'rejects foreign and missing Origin on %s',
    async (path) => {
      const { app, store } = fixture();
      for (const disallowed of ['https://attacker.example', 'null']) {
        const response = await request(app)
          .post(path)
          .set('Origin', disallowed)
          .send({ username: 'alice', password })
          .expect(403);
        expect(response.body.error.code).toBe('FORBIDDEN_ORIGIN');
      }
      await request(app).post(path).send({ username: 'alice', password }).expect(403);
      expect(store.users.size).toBe(1);
    },
  );

  it('requires JSON for credentials while allowing bodyless logout', async () => {
    const { app } = fixture();
    await request(app)
      .post('/api/auth/register')
      .set('Origin', origin)
      .type('form')
      .send({ username: 'alice', password })
      .expect(415);
    const response = await register(app).expect(201);
    await request(app)
      .post('/api/auth/logout')
      .set('Origin', origin)
      .set('Cookie', cookieOf(response))
      .expect(204);
  });
});

import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { createApp } from '../app.js';
import { SESSION_COOKIE } from '../middleware/auth.js';
import { createSessionService } from '../services/session.service.js';
import type { TradingOptions } from '../services/trading.service.js';
import { fixture } from './trading-fixture.js';

export const origin = 'http://localhost:5173';
export const buy = { symbol: 'SIM001', side: 'BUY', priceCents: 1_000, quantity: 10 };
export const keyedOrder = () => ({ ...buy, clientOrderId: randomUUID() });
export function apiFixture(options: TradingOptions = {}) {
  const core = fixture(options);
  const sessions = createSessionService(core.store, { ttlMs: 1_000 });
  const cookies = new Map(
    ['alice', 'bob', 'carol', 'dave'].map((id) => [
      id,
      SESSION_COOKIE + '=' + sessions.create(id).id,
    ]),
  );
  const app = createApp({
    store: core.store,
    sessions,
    allowedOrigins: [origin],
    tradingOptions: options,
  });
  const post = (userId: string, input: unknown = keyedOrder()) =>
    request(app)
      .post('/api/orders')
      .set('Origin', origin)
      .set('Cookie', cookies.get(userId)!)
      .send(input as object);
  const get = (userId: string, path: string) =>
    request(app).get(path).set('Cookie', cookies.get(userId)!);
  return { ...core, app, sessions, cookies, post, get };
}

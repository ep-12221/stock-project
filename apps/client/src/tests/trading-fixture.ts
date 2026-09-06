import type { AccountStateDto, OrderDto, StockQuote } from '@stock/shared';
import { useAuthStore } from '../stores/auth.js';
export const quote = (symbol = 'SIM001', price = 1000): StockQuote => ({
  symbol,
  name: symbol === 'SIM001' ? '星河科技' : '远航制造',
  previousCloseCents: price,
  lastPriceCents: price,
  changePercent: 0,
  bestBidCents: price - 1,
  bestAskCents: price + 1,
  updatedAt: '2026-09-05T10:00:00.000Z',
});
export const snapshot = (version = 1): AccountStateDto => ({
  userId: 'alice',
  serverEpoch: 'epoch',
  accountVersion: version,
  account: { cashBalanceCents: 100000000, frozenCashCents: 0, availableCashCents: 100000000 },
  positions: [],
  activeOrders: [],
  recentClosedOrders: [],
  recentTrades: [],
});
export const order = (id = 'order-1', sequence = 1): OrderDto => ({
  id,
  sequence,
  symbol: 'SIM001',
  side: 'BUY',
  priceCents: 1001,
  quantity: 100,
  filledQuantity: 0,
  executedValueCents: 0,
  status: 'OPEN',
  createdAt: '2026-09-05T10:00:00.000Z',
  updatedAt: '2026-09-05T10:00:00.000Z',
});
export const ok = (data: unknown) => new Response(JSON.stringify({ data }), { status: 200 });
export const failure = (status: number, code = 'INSUFFICIENT_FUNDS', message = '可用资金不足') =>
  new Response(JSON.stringify({ error: { code, message }, requestId: 'test' }), { status });
export function authenticated() {
  const auth = useAuthStore();
  auth.initialized = true;
  auth.user = { id: 'alice', username: 'alice' };
  auth.serverEpoch = 'epoch';
  auth.account = snapshot();
  auth.quotes = [quote(), quote('SIM002', 2000)];
  return auth;
}
export const input = { symbol: 'SIM001', side: 'BUY' as const, priceCents: 1001, quantity: 100 };

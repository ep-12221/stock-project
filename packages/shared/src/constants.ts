import type { StockDefinition } from './dto.js';

export const INITIAL_CASH_CENTS = 100_000_000;
export const MAX_PRICE_CENTS = 10_000_000;
export const MAX_ORDER_QUANTITY = 100_000;
export const MARKET_INTERVAL_MS = 1_000;

export const STOCKS = [
  { symbol: 'SIM001', name: '星河科技', initialPriceCents: 1_000 },
  { symbol: 'SIM002', name: '远航制造', initialPriceCents: 2_000 },
  { symbol: 'SIM003', name: '青禾能源', initialPriceCents: 3_000 },
] as const satisfies readonly StockDefinition[];

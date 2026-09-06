import type { OrderBook } from '../domain/models.js';
import { PriceTreeOrderBook } from './price-tree-book.js';

export type MatchingEngine = 'array' | 'price-tree';
export function createOrderBook(symbol: string, engine: MatchingEngine): OrderBook {
  if (engine === 'price-tree') return new PriceTreeOrderBook(symbol);
  if (engine === 'array') return { buyOrderIds: [], sellOrderIds: [] };
  throw new Error('Unsupported matching engine: ' + String(engine));
}

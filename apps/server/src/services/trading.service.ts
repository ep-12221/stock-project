import type { MemoryStore } from '../store/memory-store.js';
import { createTradingService as createArrayTradingService } from './trading-array.service.js';
import { createTradingService as createTreeTradingService } from './trading-tree.service.js';
import type { TradingOptions } from './trading-array.service.js';

export type { TradingOptions, SubmitOrderResult } from './trading-array.service.js';

/** Engine selection belongs to the store lifetime; never randomly split a live order book. */
export function createTradingService(store: MemoryStore, options: TradingOptions = {}) {
  return store.matchingEngine === 'array'
    ? createArrayTradingService(store, options)
    : createTreeTradingService(store, options);
}

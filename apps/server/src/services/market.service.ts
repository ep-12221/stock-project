import { MAX_PRICE_CENTS, type MarketSnapshot } from '@stock/shared';
import { integer, invariant } from '../matching/checked.js';
import type { MemoryStore } from '../store/memory-store.js';
import { publicTradeDto } from './trading-dto.js';

export function marketSnapshot(store: MemoryStore): MarketSnapshot {
  return {
    marketVersion: store.marketVersion,
    quotes: [...store.stocks.values()].map((quote) => ({ ...quote })),
    recentTrades: store.marketTradeIds
      .slice(-50)
      .reverse()
      .map((id) => publicTradeDto(store.trades.get(id)!)),
  };
}

export function createMarketService(store: MemoryStore, options: { random?: () => number } = {}) {
  const random = options.random ?? Math.random;
  function tick(): MarketSnapshot {
    const marketVersion = integer(store.marketVersion + 1);
    const updatedAt = new Date(store.now()).toISOString();
    // Compute every quote before committing, so a bad injected source cannot partially update a tick.
    const quotes = [...store.stocks.values()].map((quote) => {
      const sample = random();
      invariant(Number.isFinite(sample) && sample >= 0 && sample < 1);
      const index = Math.floor(sample * 40);
      const bps = index < 20 ? index - 20 : index - 19;
      const rounded = Math.round((quote.lastPriceCents * bps) / 10_000);
      const delta = rounded || Math.sign(bps);
      const lastPriceCents = Math.max(1, Math.min(MAX_PRICE_CENTS, quote.lastPriceCents + delta));
      return {
        ...quote,
        lastPriceCents,
        changePercent:
          ((lastPriceCents - quote.previousCloseCents) / quote.previousCloseCents) * 100,
        updatedAt,
      };
    });
    for (const quote of quotes) store.stocks.set(quote.symbol, quote);
    store.marketVersion = marketVersion;
    return marketSnapshot(store);
  }
  return { tick };
}

import type { PublicTradeDto, StockQuote, StocksDto } from '@stock/shared';
import { defineStore } from 'pinia';
import { ref } from 'vue';
export const useMarketStore = defineStore('market', () => {
  const quotes = ref<StockQuote[]>([]);
  const recentTrades = ref<PublicTradeDto[]>([]);
  const marketVersion = ref(-1);
  // HTTP quotes have no trade window. An equal-version WS snapshot can still supply it.
  const tradeWindowVersion = ref(-1);
  const serverEpoch = ref<string | null>(null);
  function applySnapshot(
    next: StocksDto & { recentTrades?: PublicTradeDto[] },
    expectedEpoch: string,
  ): boolean {
    if (
      next.serverEpoch !== expectedEpoch ||
      !Number.isSafeInteger(next.marketVersion) ||
      next.marketVersion < 0
    )
      return false;
    if (serverEpoch.value !== expectedEpoch) reset();
    serverEpoch.value = next.serverEpoch;
    let applied = false;
    if (next.marketVersion > marketVersion.value) {
      quotes.value = next.quotes;
      marketVersion.value = next.marketVersion;
      applied = true;
    }
    if (next.recentTrades !== undefined && next.marketVersion > tradeWindowVersion.value) {
      recentTrades.value = next.recentTrades;
      tradeWindowVersion.value = next.marketVersion;
      applied = true;
    }
    return applied;
  }
  function reset() {
    quotes.value = [];
    recentTrades.value = [];
    marketVersion.value = -1;
    tradeWindowVersion.value = -1;
    serverEpoch.value = null;
  }
  return {
    quotes,
    recentTrades,
    marketVersion,
    tradeWindowVersion,
    serverEpoch,
    applySnapshot,
    reset,
  };
});

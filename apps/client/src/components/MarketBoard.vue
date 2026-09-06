<script setup lang="ts">
import type { StockQuote } from '@stock/shared';
import { formatMoney, formatTime } from '../utils/money.js';
defineProps<{ quotes: StockQuote[]; selectedSymbol: string }>();
defineEmits<{ 'update:selectedSymbol': [symbol: string] }>();
</script>
<template>
  <section class="desk-panel market-board" aria-labelledby="market-title">
    <div class="panel-heading">
      <div>
        <p class="eyebrow">MARKET WATCH</p>
        <h2 id="market-title">股票行情</h2>
      </div>
      <span class="muted-label">虚拟币 / 股</span>
    </div>
    <p v-if="!quotes.length" class="empty-state">暂无行情，请刷新重试</p>
    <button
      v-for="stock in quotes"
      :key="stock.symbol"
      class="market-row"
      :class="{ selected: stock.symbol === selectedSymbol }"
      :data-symbol="stock.symbol"
      :aria-pressed="stock.symbol === selectedSymbol"
      @click="$emit('update:selectedSymbol', stock.symbol)"
    >
      <span class="quote-title"
        ><span
          ><strong>{{ stock.name }}</strong
          ><small>{{ stock.symbol }}</small></span
        ><span class="quote-value"
          ><strong>{{ formatMoney(stock.lastPriceCents) }}</strong
          ><small
            :class="
              stock.changePercent > 0 ? 'price-up' : stock.changePercent < 0 ? 'price-down' : ''
            "
            >{{ stock.changePercent > 0 ? '+' : '' }}{{ stock.changePercent.toFixed(2) }}%</small
          ></span
        ></span
      >
      <span class="quote-depth"
        ><span>买 {{ stock.bestBidCents === null ? '—' : formatMoney(stock.bestBidCents) }}</span
        ><span
          >卖 {{ stock.bestAskCents === null ? '—' : formatMoney(stock.bestAskCents) }}</span
        ></span
      >
      <span class="quote-updated">模拟最新价 · {{ formatTime(stock.updatedAt) }}</span>
    </button>
  </section>
</template>

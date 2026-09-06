<script setup lang="ts">
import type { AccountStateDto, StockQuote } from '@stock/shared';
import { computed } from 'vue';
import { formatMoney, portfolioValue } from '../utils/money.js';
const props = defineProps<{ account: AccountStateDto | null; quotes: StockQuote[] }>();
const holdings = computed(() => props.account?.positions.filter((p) => p.quantity > 0).length ?? 0);
const value = computed(() => portfolioValue(props.account?.positions ?? [], props.quotes));
const complete = computed(
  () =>
    props.account?.positions.every(
      (p) => p.quantity === 0 || props.quotes.some((q) => q.symbol === p.symbol),
    ) ?? false,
);
</script>
<template>
  <section class="account-overview" aria-label="我的资产">
    <div class="asset-metric asset-primary">
      <span>可用资金 <small>虚拟币</small></span
      ><strong data-testid="available-cash">{{
        account ? formatMoney(account.account.availableCashCents) : '—'
      }}</strong>
      <p>可用于新的买入委托</p>
    </div>
    <div class="asset-metric">
      <span>冻结资金</span
      ><strong>{{ account ? formatMoney(account.account.frozenCashCents) : '—' }}</strong>
      <p>未成交买单占用</p>
    </div>
    <div class="asset-metric">
      <span>持仓市值</span
      ><strong data-testid="portfolio-value">{{ complete ? formatMoney(value) : '—' }}</strong>
      <p class="holdings-empty">{{ holdings ? '已持有 ' + holdings + ' 只股票' : '暂无持仓' }}</p>
    </div>
    <div class="asset-metric">
      <span>总资产</span
      ><strong data-testid="total-assets">{{
        account && complete ? formatMoney(BigInt(account.account.cashBalanceCents) + value) : '—'
      }}</strong>
      <p>总现金 + 持仓市值</p>
    </div>
  </section>
</template>

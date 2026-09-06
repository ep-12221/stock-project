<script setup lang="ts">
import type { PositionDto, StockQuote } from '@stock/shared';
import { computed } from 'vue';
import { formatMoney } from '../utils/money.js';
const props = defineProps<{ positions: PositionDto[]; quotes: StockQuote[] }>();
const rows = computed(() =>
  props.positions
    .filter((p) => p.quantity > 0)
    .map((p) => ({ ...p, quote: props.quotes.find((q) => q.symbol === p.symbol) })),
);
</script>
<template>
  <section
    class="desk-panel position-panel"
    data-testid="position-table"
    aria-labelledby="positions-title"
  >
    <div class="panel-heading">
      <div>
        <p class="eyebrow">MY PORTFOLIO</p>
        <h2 id="positions-title">我的持仓</h2>
      </div>
      <span class="muted-label">{{ rows.length }} 只股票</span>
    </div>
    <div v-if="!rows.length" class="empty-state">
      <span class="empty-symbol" aria-hidden="true">↗</span><strong>暂无持仓</strong>
      <p>买入成交后，在这里查看你的股票资产。</p>
    </div>
    <div v-else class="table-scroll">
      <table>
        <thead>
          <tr>
            <th scope="col">股票</th>
            <th scope="col">总持仓</th>
            <th scope="col">可用 / 冻结</th>
            <th scope="col">模拟最新价</th>
            <th scope="col">持仓市值</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="row in rows" :key="row.symbol">
            <td>
              <strong>{{ row.quote?.name ?? row.symbol }}</strong
              ><small>{{ row.symbol }}</small>
            </td>
            <td>{{ row.quantity.toLocaleString('zh-CN') }}</td>
            <td>{{ row.availableQuantity }} / {{ row.frozenQuantity }}</td>
            <td>{{ row.quote ? formatMoney(row.quote.lastPriceCents) : '—' }}</td>
            <td>
              {{
                row.quote
                  ? formatMoney(BigInt(row.quantity) * BigInt(row.quote.lastPriceCents))
                  : '—'
              }}
            </td>
          </tr>
        </tbody>
      </table>
    </div>
    <p class="panel-note">市值按模拟最新价估算，包含已冻结的持仓。</p>
  </section>
</template>

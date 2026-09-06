<script setup lang="ts">
import type { OrderStatus } from '@stock/shared';
import { computed, onMounted, ref, watch } from 'vue';
import { useAuthStore } from '../stores/auth.js';
import { useTradingStore } from '../stores/trading.js';
import { formatMoney, formatTime } from '../utils/money.js';
const auth = useAuthStore();
const trading = useTradingStore();
const tab = ref<'orders' | 'personal' | 'market'>('orders');
const symbol = ref('');
const status = ref<OrderStatus | ''>('');
const list = computed(() =>
  tab.value === 'orders'
    ? trading.orders
    : tab.value === 'personal'
      ? trading.personalTrades
      : trading.marketTrades,
);
const labels: Record<OrderStatus, string> = {
  OPEN: '已挂单',
  PARTIALLY_FILLED: '部分成交',
  FILLED: '全部成交',
  CANCELLED: '已撤销',
};
const rows = computed(() =>
  list.value.items.map((item) => ({
    ...item,
    sideLabel: 'side' in item ? (item.side === 'BUY' ? '买入' : '卖出') : '',
    time: 'createdAt' in item ? item.createdAt : item.executedAt,
    statusLabel: 'status' in item ? labels[item.status] : '',
    filled: 'filledQuantity' in item ? item.filledQuantity + '/' + item.quantity : '',
    amount:
      'executedValueCents' in item
        ? item.executedValueCents
        : BigInt(item.priceCents) * BigInt(item.quantity),
    orderId: 'orderId' in item ? item.orderId : '',
  })),
);
function reload(more = false) {
  return list.value.load(
    { symbol: symbol.value, ...(tab.value === 'orders' ? { status: status.value } : {}) },
    more,
  );
}
watch([tab, symbol, status], () => void reload());
onMounted(() => void reload());
</script>
<template>
  <section class="desk-panel history-panel" aria-labelledby="history-title">
    <div class="panel-heading">
      <div>
        <p class="eyebrow">TRADING ACTIVITY</p>
        <h2 id="history-title">交易记录</h2>
      </div>
      <button
        class="secondary-button"
        data-action="reload-history"
        :disabled="list.loading"
        @click="reload()"
      >
        {{ list.loading ? '加载中…' : '刷新记录' }}
      </button>
    </div>
    <div class="history-toolbar">
      <div class="history-tabs" aria-label="记录类型">
        <button
          v-for="item in [
            { key: 'orders', label: '我的委托' },
            { key: 'personal', label: '我的成交' },
            { key: 'market', label: '市场成交' },
          ] as const"
          :key="item.key"
          :data-history="item.key"
          :aria-pressed="tab === item.key"
          :class="{ active: tab === item.key }"
          @click="tab = item.key"
        >
          {{ item.label }}
        </button>
      </div>
      <div class="history-filters">
        <label
          >股票<select v-model="symbol" name="history-symbol">
            <option value="">全部股票</option>
            <option v-for="quote in auth.quotes" :key="quote.symbol" :value="quote.symbol">
              {{ quote.name }}
            </option>
          </select></label
        ><label v-if="tab === 'orders'"
          >状态<select v-model="status" name="order-status">
            <option value="">全部状态</option>
            <option v-for="(label, key) in labels" :key="key" :value="key">{{ label }}</option>
          </select></label
        >
      </div>
    </div>
    <p v-if="list.error" class="auth-error" role="alert">{{ list.error }}，可点击刷新记录重试。</p>
    <p v-if="list.loading && !rows.length" class="empty-state" role="status">正在加载记录…</p>
    <p v-else-if="!rows.length && !list.error" class="empty-state">
      {{ tab === 'orders' ? '暂无委托' : '暂无成交' }}
    </p>
    <div v-if="rows.length" class="table-scroll" :aria-busy="list.loading">
      <table>
        <thead>
          <tr>
            <th scope="col">{{ tab === 'orders' ? '委托时间' : '成交时间' }}</th>
            <th scope="col">股票</th>
            <th v-if="tab !== 'market'" scope="col">方向</th>
            <th scope="col">{{ tab === 'orders' ? '限价' : '成交价' }}</th>
            <th scope="col">{{ tab === 'orders' ? '已成交 / 委托' : '成交数量' }}</th>
            <th scope="col">成交金额</th>
            <th v-if="tab === 'orders'" scope="col">状态</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="row in rows" :key="row.id">
            <td :title="row.id + (row.orderId ? ' / 委托 ' + row.orderId : '')">
              {{ formatTime(row.time) }}
            </td>
            <td>{{ row.symbol }}</td>
            <td v-if="tab !== 'market'">
              <span :class="row.sideLabel === '买入' ? 'buy-label' : 'sell-label'">{{
                row.sideLabel
              }}</span>
            </td>
            <td>{{ formatMoney(row.priceCents) }}</td>
            <td>{{ tab === 'orders' ? row.filled : row.quantity.toLocaleString('zh-CN') }}</td>
            <td>{{ formatMoney(row.amount) }}</td>
            <td v-if="tab === 'orders'">
              <span class="order-status">{{ row.statusLabel }}</span>
            </td>
          </tr>
        </tbody>
      </table>
    </div>
    <div class="history-bottom">
      <span>{{ tab === 'market' ? '市场成交仅展示价格与数量' : '按时间从新到旧展示' }}</span
      ><button
        v-if="list.nextCursor !== null"
        class="secondary-button"
        :disabled="list.loading"
        data-action="load-more"
        @click="reload(true)"
      >
        {{ list.loading ? '加载中…' : '加载更多' }}</button
      ><span v-else-if="rows.length">已显示全部记录</span>
    </div>
  </section>
</template>

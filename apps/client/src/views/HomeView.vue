<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import { useRouter } from 'vue-router';
import ServiceStatus from '../components/ServiceStatus.vue';
import AccountSummary from '../components/AccountSummary.vue';
import MarketBoard from '../components/MarketBoard.vue';
import OrderForm from '../components/OrderForm.vue';
import PositionTable from '../components/PositionTable.vue';
import TradingHistory from '../components/TradingHistory.vue';
import { useServiceStore } from '../stores/service.js';
import { useAuthStore } from '../stores/auth.js';
import { useTradingStore } from '../stores/trading.js';
import { useRealtimeStore } from '../stores/realtime.js';
import { formatMoney } from '../utils/money.js';
const auth = useAuthStore();
const service = useServiceStore();
const realtime = useRealtimeStore();
const trading = useTradingStore();
const router = useRouter();
const selectedSymbol = ref('');
const leaving = ref(false);
const operationError = ref<string | null>(null);
watch(
  () => auth.quotes,
  (quotes) => {
    if (!quotes.some((q) => q.symbol === selectedSymbol.value))
      selectedSymbol.value = quotes[0]?.symbol ?? '';
  },
  { immediate: true },
);
const selected = computed(() => auth.quotes.find((q) => q.symbol === selectedSymbol.value));
const availableQuantity = computed(
  () =>
    auth.account?.positions.find((p) => p.symbol === selectedSymbol.value)?.availableQuantity ?? 0,
);
async function logout() {
  if (leaving.value || trading.submitting || trading.refreshing) return;
  leaving.value = true;
  operationError.value = null;
  try {
    await auth.logout();
    await router.replace('/login');
  } catch (cause) {
    operationError.value = cause instanceof Error ? cause.message : '退出失败，请重试';
  } finally {
    leaving.value = false;
  }
}
async function refreshAccount() {
  operationError.value = null;
  await Promise.all([trading.refresh(), service.refresh()]);
}
onMounted(() => void service.refresh());
</script>
<template>
  <div class="app-shell trading-shell">
    <header class="topbar">
      <a class="brand" href="/" aria-label="股票模拟交易首页"
        ><span class="brand-icon" aria-hidden="true"
          ><svg viewBox="0 0 24 24" fill="none">
            <path d="M4 17L9 12L13 15L20 6M14 6H20V12" /></svg></span
        ><span>模拟交易<span class="brand-subtitle">STOCK LAB</span></span></a
      >
      <div class="header-right">
        <ServiceStatus /><span class="account-name">{{ auth.user?.username }}</span
        ><button
          class="secondary-button"
          data-action="logout"
          :disabled="auth.busy || leaving || trading.submitting || trading.refreshing"
          @click="logout"
        >
          {{ leaving ? '正在退出…' : '退出登录' }}
        </button>
      </div>
    </header>
    <main>
      <div class="workspace-heading">
        <div>
          <p class="eyebrow">YOUR TRADING DESK</p>
          <h1>交易工作台</h1>
          <p>你好，{{ auth.user?.username }}。从一笔限价委托开始。</p>
        </div>
        <div class="refresh-controls">
          <button
            class="secondary-button"
            data-action="refresh-account"
            :disabled="auth.busy || trading.refreshing || trading.submitting"
            @click="refreshAccount"
          >
            {{ trading.refreshing ? '同步中…' : '刷新账户与行情' }}
            <span aria-hidden="true">↻</span></button
          ><small>行情每秒更新 · 账户实时同步</small>
        </div>
      </div>
      <AccountSummary :account="auth.account" :quotes="auth.quotes" />
      <div class="workspace-feedback" aria-live="polite">
        <div
          v-if="realtime.enabled && !realtime.ready"
          class="realtime-notice"
          :class="{ interrupted: ['offline', 'reconnecting'].includes(realtime.status) }"
          data-testid="realtime-notice"
          role="status"
        >
          <div>
            <strong>{{
              ['offline', 'reconnecting'].includes(realtime.status)
                ? '实时连接中断，数据可能过期'
                : '正在同步账户与行情'
            }}</strong>
            <p>
              {{
                ['offline', 'reconnecting'].includes(realtime.status)
                  ? '已保留当前资产与输入，恢复同步后即可继续下单。'
                  : '首次完整同步完成后即可下单，请稍候。'
              }}
            </p>
            <p v-if="realtime.error" class="realtime-detail">{{ realtime.error }}</p>
          </div>
          <button
            v-if="['offline', 'reconnecting'].includes(realtime.status)"
            class="secondary-button"
            data-action="reconnect"
            :disabled="auth.busy"
            @click="realtime.reconnect()"
          >
            重新连接
          </button>
        </div>
        <p v-if="operationError || auth.error || trading.error" class="auth-error" role="alert">
          {{ operationError || auth.error || trading.error }}
        </p>
        <p v-if="trading.notice" class="success-notice" role="status">{{ trading.notice }}</p>
        <p v-if="trading.warning || service.error" class="warning-notice" role="alert">
          {{ trading.warning || service.error }}
        </p>
        <div
          v-if="trading.uncertain && trading.pendingOrder"
          class="uncertain-notice"
          data-testid="pending-order"
        >
          <strong>这笔委托等待确认</strong>
          <p class="pending-order-summary">
            {{ trading.pendingOrder.symbol }} ·
            {{ trading.pendingOrder.side === 'BUY' ? '买入' : '卖出' }} · 限价
            {{ formatMoney(trading.pendingOrder.priceCents) }} ·
            {{ trading.pendingOrder.quantity }} 股
          </p>
          <p>将按上方原委托重试；如果上次未被受理，本次会提交。请勿另建相同委托。</p>
          <button
            class="secondary-button"
            data-action="retry-order"
            :disabled="!trading.canRetry || leaving"
            @click="trading.retryPending()"
          >
            {{ trading.submitting ? '正在确认…' : '重试并确认此委托' }}
          </button>
        </div>
      </div>
      <div class="workspace-grid">
        <MarketBoard v-model:selected-symbol="selectedSymbol" :quotes="auth.quotes" /><OrderForm
          v-if="selected"
          :quote="selected"
          :available-cash-cents="auth.account?.account.availableCashCents ?? 0"
          :available-quantity="availableQuantity"
          :disabled="!trading.canSubmit || leaving || (realtime.enabled && !realtime.ready)"
          :submitting="trading.submitting"
          @submit="trading.submit"
        />
        <section v-else class="desk-panel empty-state">行情加载后即可提交委托</section>
        <PositionTable :positions="auth.account?.positions ?? []" :quotes="auth.quotes" />
      </div>
      <TradingHistory />
    </main>
    <footer><span>STOCK LAB</span><span>虚拟资产，仅用于演示；服务重启后数据清空。</span></footer>
  </div>
</template>

<script setup lang="ts">
import type { Side, StockQuote } from '@stock/shared';
import { computed, ref, watch } from 'vue';
import type { LimitOrderInput } from '../stores/trading.js';
import { formatMoney, parsePrice, parseQuantity, priceInput } from '../utils/money.js';
const props = defineProps<{
  quote: StockQuote;
  availableCashCents: number;
  availableQuantity: number;
  disabled: boolean;
  submitting?: boolean;
}>();
const emit = defineEmits<{ submit: [input: LimitOrderInput] }>();
const side = ref<Side>('BUY');
const price = ref('');
const quantity = ref('100');
const error = ref<string | null>(null);
const best = computed(() =>
  side.value === 'BUY' ? props.quote.bestAskCents : props.quote.bestBidCents,
);
watch(
  () => props.quote.symbol,
  () => {
    price.value = priceInput(best.value ?? props.quote.lastPriceCents);
    error.value = null;
  },
  { immediate: true },
);
watch([price, quantity, side], () => {
  error.value = null;
});
const estimate = computed(() => {
  try {
    return formatMoney(BigInt(parsePrice(price.value)) * BigInt(parseQuantity(quantity.value)));
  } catch {
    return '—';
  }
});
function submit() {
  if (props.disabled) return;
  try {
    const priceCents = parsePrice(price.value);
    const shares = parseQuantity(quantity.value);
    if (
      side.value === 'BUY' &&
      BigInt(priceCents) * BigInt(shares) > BigInt(props.availableCashCents)
    )
      throw new Error('可用资金不足，请降低价格或数量');
    if (side.value === 'SELL' && shares > props.availableQuantity)
      throw new Error('可用持仓不足，请减少卖出数量');
    error.value = null;
    emit('submit', { symbol: props.quote.symbol, side: side.value, priceCents, quantity: shares });
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : '请检查输入';
  }
}
</script>
<template>
  <section class="desk-panel order-panel" data-testid="order-form" aria-labelledby="order-title">
    <div class="panel-heading">
      <div>
        <p class="eyebrow">PLACE AN ORDER</p>
        <h2 id="order-title">限价委托</h2>
      </div>
      <span class="muted-label">{{ quote.symbol }}</span>
    </div>
    <h3 class="order-stock">
      {{ quote.name }} <small>模拟最新价 {{ formatMoney(quote.lastPriceCents) }}</small>
    </h3>
    <form novalidate @submit.prevent="submit">
      <div class="side-switch" aria-label="交易方向">
        <button
          type="button"
          data-side="BUY"
          :class="{ active: side === 'BUY' }"
          :aria-pressed="side === 'BUY'"
          :disabled="disabled"
          @click="side = 'BUY'"
        >
          买入</button
        ><button
          type="button"
          data-side="SELL"
          :class="{ active: side === 'SELL' }"
          :aria-pressed="side === 'SELL'"
          :disabled="disabled"
          @click="side = 'SELL'"
        >
          卖出
        </button>
      </div>
      <div class="field-heading">
        <label for="order-price">委托价格 <small>虚拟币 / 股</small></label
        ><button
          type="button"
          class="text-button"
          data-action="best-price"
          :disabled="best === null || disabled"
          @click="price = priceInput(best!)"
        >
          使用最佳{{ side === 'BUY' ? '卖' : '买' }}价
        </button>
      </div>
      <input
        id="order-price"
        v-model="price"
        name="price"
        inputmode="decimal"
        autocomplete="off"
        :disabled="disabled"
        aria-describedby="price-hint"
      />
      <p id="price-hint" class="field-hint">
        {{
          best === null
            ? '暂无对手盘，可提交限价挂单等待成交'
            : '最佳' +
              (side === 'BUY' ? '卖' : '买') +
              '价 ' +
              formatMoney(best) +
              ' · 按可成交的对手价撮合'
        }}
      </p>
      <label for="order-quantity">委托数量 <small>股</small></label>
      <input
        id="order-quantity"
        v-model="quantity"
        name="quantity"
        inputmode="numeric"
        autocomplete="off"
        :disabled="disabled"
        aria-describedby="quantity-hint"
      />
      <p id="quantity-hint" class="field-hint">1～100,000 股，整数股即可</p>
      <div class="order-estimate">
        <span>{{ side === 'BUY' ? '最大占用资金' : '委托参考金额' }}</span
        ><strong>{{ estimate }}</strong>
      </div>
      <p class="order-available">
        {{
          side === 'BUY'
            ? '可用资金 ' + formatMoney(availableCashCents)
            : '可卖持仓 ' + availableQuantity.toLocaleString('zh-CN') + ' 股'
        }}
      </p>
      <p v-if="error" class="auth-error" role="alert">{{ error }}</p>
      <button class="trade-submit" type="submit" :disabled="disabled">
        {{ submitting ? '提交中…' : '确认' + (side === 'BUY' ? '买入' : '卖出') }}
        <span aria-hidden="true">↗</span>
      </button>
      <p class="field-hint order-footnote">限价委托可能全部成交、部分成交或挂单等待。</p>
    </form>
  </section>
</template>

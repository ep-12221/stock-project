// @vitest-environment jsdom
import { createPinia, disposePinia, setActivePinia } from 'pinia';
import { flushPromises, mount } from '@vue/test-utils';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createMemoryHistory, createRouter } from 'vue-router';
import OrderForm from '../components/OrderForm.vue';
import MarketBoard from '../components/MarketBoard.vue';
import AccountSummary from '../components/AccountSummary.vue';
import TradingHistory from '../components/TradingHistory.vue';
import HomeView from '../views/HomeView.vue';
import App from '../App.vue';
import { useRealtimeStore } from '../stores/realtime.js';
import { useServiceStore } from '../stores/service.js';
import { authenticated, failure, input, ok, order, quote, snapshot } from './trading-fixture.js';
let pinia: ReturnType<typeof createPinia>;
const wrappers: Array<{ unmount(): void }> = [];
let fetchMock: ReturnType<typeof vi.fn>;
beforeEach(() => {
  sessionStorage.clear();
  pinia = createPinia();
  setActivePinia(pinia);
  authenticated();
  vi.spyOn(useServiceStore(), 'refresh').mockResolvedValue();
  vi.spyOn(useRealtimeStore(), 'start').mockImplementation(() => {});
  vi.spyOn(useRealtimeStore(), 'stop').mockImplementation(() => {});
  fetchMock = vi.fn(async (url: string) => {
    if (url === '/api/stocks')
      return ok({
        serverEpoch: 'epoch',
        marketVersion: 2,
        quotes: [quote(), quote('SIM002', 2000)],
      });
    return ok({
      userId: 'alice',
      serverEpoch: 'epoch',
      accountVersion: 2,
      marketVersion: 2,
      items: [],
      nextCursor: null,
    });
  });
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => {
  wrappers.splice(0).forEach((w) => w.unmount());
  disposePinia(pinia);
  vi.unstubAllGlobals();
});
function form(props = {}) {
  const wrapper = mount(OrderForm, {
    props: {
      quote: quote(),
      availableCashCents: 100000000,
      availableQuantity: 10,
      disabled: false,
      ...props,
    },
  });
  wrappers.push(wrapper);
  return wrapper;
}
it('submits a limit buy in integer cents without an identity or idempotency field', async () => {
  const wrapper = form();
  await wrapper.get('form').trigger('submit');
  expect(wrapper.emitted('submit')?.[0]).toEqual([input]);
});
it('uses the best bid to submit an immediately marketable sell', async () => {
  const wrapper = form();
  await wrapper.get('[data-side="SELL"]').trigger('click');
  await wrapper.get('[data-action="best-price"]').trigger('click');
  await wrapper.get('[name="quantity"]').setValue('5');
  await wrapper.get('form').trigger('submit');
  expect(wrapper.emitted('submit')?.[0]).toEqual([
    { ...input, side: 'SELL', priceCents: 999, quantity: 5 },
  ]);
});
it('retains edited prices across quote refreshes and initializes the next stock', async () => {
  const wrapper = form();
  await wrapper.get('[name="price"]').setValue('12.34');
  await wrapper.setProps({ quote: { ...quote(), bestAskCents: 1100 } });
  expect((wrapper.get('[name="price"]').element as HTMLInputElement).value).toBe('12.34');
  await wrapper.setProps({ quote: quote('SIM002', 2000) });
  expect((wrapper.get('[name="price"]').element as HTMLInputElement).value).toBe('20.01');
});
it.each([
  ['price', '0.001'],
  ['price', '1e2'],
  ['quantity', '1.5'],
  ['quantity', '100001'],
])('rejects invalid %s input %s', async (field, value) => {
  const wrapper = form();
  await wrapper.get('[name="' + field + '"]').setValue(value!);
  await wrapper.get('form').trigger('submit');
  expect(wrapper.emitted('submit')).toBeUndefined();
  expect(wrapper.find('[role="alert"]').exists()).toBe(true);
});
it('checks available cash without spending frozen cash', async () => {
  const wrapper = form({ availableCashCents: 1000 });
  await wrapper.get('form').trigger('submit');
  expect(wrapper.emitted('submit')).toBeUndefined();
  expect(wrapper.text()).toContain('可用资金不足');
});
it('checks available shares rather than total shares', async () => {
  const wrapper = form({ availableQuantity: 0 });
  await wrapper.get('[data-side="SELL"]').trigger('click');
  await wrapper.get('form').trigger('submit');
  expect(wrapper.emitted('submit')).toBeUndefined();
  expect(wrapper.text()).toContain('可用持仓不足');
});
it('shows no counterparty and still permits a valid resting limit order', async () => {
  const wrapper = form({ quote: { ...quote(), bestAskCents: null, bestBidCents: null } });
  expect(wrapper.text()).toContain('暂无对手盘');
  expect(wrapper.get('[data-action="best-price"]').attributes('disabled')).toBeDefined();
  await wrapper.get('form').trigger('submit');
  expect(wrapper.emitted('submit')).toHaveLength(1);
});
it('blocks disabled form submits while keeping the entered values', async () => {
  const wrapper = form();
  await wrapper.get('[name="price"]').setValue('11.25');
  await wrapper.setProps({ disabled: true });
  await wrapper.get('form').trigger('submit');
  expect(wrapper.emitted('submit')).toBeUndefined();
  expect((wrapper.get('[name="price"]').element as HTMLInputElement).value).toBe('11.25');
});
it('selects stocks by button and displays real best prices and signed changes', async () => {
  const wrapper = mount(MarketBoard, {
    props: {
      quotes: [quote(), { ...quote('SIM002', 2000), changePercent: -0.5 }],
      selectedSymbol: 'SIM001',
    },
  });
  wrappers.push(wrapper);
  await wrapper.get('[data-symbol="SIM002"]').trigger('click');
  expect(wrapper.emitted('update:selectedSymbol')?.[0]).toEqual(['SIM002']);
  expect(wrapper.text()).toContain('9.99');
  expect(wrapper.text()).toContain('10.01');
  expect(wrapper.text()).toContain('-0.50%');
});
it('computes portfolio and total assets without double counting frozen cash or shares', () => {
  const data = snapshot();
  data.account = { cashBalanceCents: 10000, frozenCashCents: 5000, availableCashCents: 5000 };
  data.positions = [{ symbol: 'SIM001', quantity: 10, frozenQuantity: 10, availableQuantity: 0 }];
  const wrapper = mount(AccountSummary, { props: { account: data, quotes: [quote()] } });
  wrappers.push(wrapper);
  expect(wrapper.get('[data-testid="available-cash"]').text()).toContain('50.00');
  expect(wrapper.get('[data-testid="portfolio-value"]').text()).toContain('100.00');
  expect(wrapper.get('[data-testid="total-assets"]').text()).toContain('200.00');
});
it('loads order filters and switches between private and anonymous trades', async () => {
  const wrapper = mount(TradingHistory);
  wrappers.push(wrapper);
  await flushPromises();
  expect(fetchMock.mock.calls.some(([url]) => url.startsWith('/api/me/orders?'))).toBe(true);
  await wrapper.get('[name="order-status"]').setValue('PARTIALLY_FILLED');
  await flushPromises();
  expect(fetchMock.mock.calls.at(-1)![0]).toContain('status=PARTIALLY_FILLED');
  await wrapper.get('[data-history="personal"]').trigger('click');
  await flushPromises();
  expect(fetchMock.mock.calls.at(-1)![0]).toContain('/api/me/trades?');
  await wrapper.get('[data-history="market"]').trigger('click');
  await flushPromises();
  expect(fetchMock.mock.calls.at(-1)![0]).toContain('/api/trades?');
  expect(wrapper.text()).toContain('暂无成交');
});
it('renders history failures as retryable errors', async () => {
  fetchMock.mockRejectedValueOnce(new TypeError('network'));
  const wrapper = mount(TradingHistory);
  wrappers.push(wrapper);
  await flushPromises();
  expect(wrapper.find('[role="alert"]').exists()).toBe(true);
  await wrapper.get('[data-action="reload-history"]').trigger('click');
  await flushPromises();
  expect(wrapper.find('[role="alert"]').exists()).toBe(false);
  expect(wrapper.text()).toContain('暂无委托');
});
async function workspace() {
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/', component: HomeView, meta: { requiresAuth: true } },
      { path: '/login', component: { template: '<h1>登录页</h1>' } },
    ],
  });
  await router.push('/');
  const wrapper = mount(App, { global: { plugins: [pinia, router] } });
  wrappers.push(wrapper);
  await flushPromises();
  return { wrapper, router };
}
it('connects market selection, the order form, positions and account in the workspace', async () => {
  const next = snapshot(2);
  next.account = { cashBalanceCents: 99899900, availableCashCents: 99899900, frozenCashCents: 0 };
  next.positions = [{ symbol: 'SIM001', quantity: 100, frozenQuantity: 0, availableQuantity: 100 }];
  const { wrapper } = await workspace();
  fetchMock.mockResolvedValueOnce(
    ok({ order: { ...order(), status: 'FILLED', filledQuantity: 100 }, snapshot: next }),
  );
  await wrapper.get('[data-testid="order-form"] form').trigger('submit');
  await flushPromises();
  expect(wrapper.get('[data-testid="available-cash"]').text()).toContain('998,999.00');
  expect(wrapper.get('[data-testid="position-table"]').text()).toContain('100');
  expect(wrapper.text()).toContain('全部成交');
  await wrapper.get('[data-symbol="SIM002"]').trigger('click');
  expect((wrapper.get('[name="price"]').element as HTMLInputElement).value).toBe('20.01');
});
it('leaves the workspace on an expired order session', async () => {
  const { wrapper, router } = await workspace();
  fetchMock.mockResolvedValueOnce(failure(401, 'UNAUTHENTICATED', '请先登录'));
  await wrapper.get('[data-testid="order-form"] form').trigger('submit');
  await flushPromises();
  expect(router.currentRoute.value.path).toBe('/login');
});

it('appends a history page and resets the cursor when a filter changes', async () => {
  const page = (items: ReturnType<typeof order>[], nextCursor: number | null) =>
    ok({ userId: 'alice', serverEpoch: 'epoch', accountVersion: 2, items, nextCursor });
  fetchMock.mockResolvedValueOnce(page([order('latest', 3), order('middle', 2)], 2));
  const wrapper = mount(TradingHistory);
  wrappers.push(wrapper);
  await flushPromises();
  fetchMock.mockResolvedValueOnce(page([order('oldest', 1)], null));
  await wrapper.get('[data-action="load-more"]').trigger('click');
  await flushPromises();
  expect(fetchMock.mock.calls.at(-1)![0]).toContain('cursor=2');
  expect(wrapper.findAll('tbody tr')).toHaveLength(3);
  expect(wrapper.find('[data-action="load-more"]').exists()).toBe(false);
  fetchMock.mockResolvedValueOnce(page([], null));
  await wrapper.get('[name="history-symbol"]').setValue('SIM002');
  await flushPromises();
  expect(fetchMock.mock.calls.at(-1)![0]).toContain('symbol=SIM002');
  expect(fetchMock.mock.calls.at(-1)![0]).not.toContain('cursor=');
  expect(wrapper.findAll('tbody tr')).toHaveLength(0);
  expect(wrapper.text()).toContain('暂无委托');
});

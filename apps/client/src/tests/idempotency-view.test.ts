// @vitest-environment jsdom
import { createPinia, disposePinia, setActivePinia } from 'pinia';
import { flushPromises, mount } from '@vue/test-utils';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createMemoryHistory, createRouter } from 'vue-router';
import HomeView from '../views/HomeView.vue';
import { useTradingStore } from '../stores/trading.js';
import { useRealtimeStore } from '../stores/realtime.js';
import { useServiceStore } from '../stores/service.js';
import { authenticated, failure, input, ok, order, snapshot } from './trading-fixture.js';

let pinia: ReturnType<typeof createPinia>;
let fetchMock: ReturnType<typeof vi.fn>;
const wrappers: Array<{ unmount(): void }> = [];
beforeEach(() => {
  sessionStorage.clear();
  pinia = createPinia();
  setActivePinia(pinia);
  authenticated();
  const realtime = useRealtimeStore();
  realtime.enabled = true;
  realtime.status = 'live';
  vi.spyOn(useServiceStore(), 'refresh').mockResolvedValue();
  vi.spyOn(useTradingStore().orders, 'load').mockResolvedValue();
  fetchMock = vi.fn().mockRejectedValue(new TypeError('response lost'));
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => {
  wrappers.splice(0).forEach((wrapper) => wrapper.unmount());
  disposePinia(pinia);
  sessionStorage.clear();
  vi.unstubAllGlobals();
});
async function workspace() {
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/', component: HomeView },
      { path: '/login', component: { template: '<h1>登录页</h1>' } },
    ],
  });
  await router.push('/');
  const wrapper = mount(HomeView, { global: { plugins: [pinia, router] } });
  wrappers.push(wrapper);
  await flushPromises();
  return wrapper;
}
async function unknownOrder() {
  const wrapper = await workspace();
  await wrapper.get('[data-testid="order-form"] form').trigger('submit');
  await flushPromises();
  return wrapper;
}
const confirmed = () => {
  const data = snapshot(2);
  data.account = { cashBalanceCents: 99899900, frozenCashCents: 0, availableCashCents: 99899900 };
  data.positions = [{ symbol: 'SIM001', quantity: 100, frozenQuantity: 0, availableQuantity: 100 }];
  const filled = {
    ...order(),
    status: 'FILLED' as const,
    filledQuantity: 100,
    executedValueCents: 100100,
  };
  data.recentClosedOrders = [filled];
  return ok({ order: filled, snapshot: data });
};
it('shows the original unknown order and an explicit retry without allowing manual bypass', async () => {
  const wrapper = await unknownOrder();
  const pending = wrapper.get('[data-testid="pending-order"]');
  expect(pending.text()).toContain('SIM001');
  expect(pending.text()).toContain('买入');
  expect(pending.text()).toContain('10.01');
  expect(pending.text()).toContain('100');
  expect(pending.text()).toContain('如果上次未被受理，本次会提交');
  expect(wrapper.get('[data-action="retry-order"]').text()).toContain('重试并确认此委托');
  expect(wrapper.get('.trade-submit').attributes('disabled')).toBeDefined();
  expect(wrapper.text()).not.toContain('已核对委托，继续交易');
  expect(fetchMock).toHaveBeenCalledOnce();
});
it('retries the original request after the selected stock changes and prevents a second click in flight', async () => {
  const wrapper = await unknownOrder();
  const originalBody = JSON.parse(fetchMock.mock.calls[0]![1].body);
  await wrapper.get('[data-symbol="SIM002"]').trigger('click');
  expect(wrapper.get('[data-testid="pending-order"]').text()).toContain('SIM001');
  let resolve!: (response: Response) => void;
  fetchMock.mockImplementationOnce(
    () =>
      new Promise<Response>((done) => {
        resolve = done;
      }),
  );
  await wrapper.get('[data-action="retry-order"]').trigger('click');
  expect(wrapper.get('[data-action="retry-order"]').attributes('disabled')).toBeDefined();
  await wrapper.get('[data-action="retry-order"]').trigger('click');
  expect(fetchMock).toHaveBeenCalledTimes(2);
  expect(JSON.parse(fetchMock.mock.calls[1]![1].body)).toEqual(originalBody);
  expect(originalBody).toEqual({ ...input, clientOrderId: expect.any(String) });
  resolve(confirmed());
  await flushPromises();
  expect(wrapper.find('[data-testid="pending-order"]').exists()).toBe(false);
  expect(wrapper.get('[data-testid="available-cash"]').text()).toContain('998,999.00');
  expect(wrapper.text()).toContain('全部成交');
  expect(wrapper.get('.trade-submit').attributes('disabled')).toBeUndefined();
  expect(fetchMock).toHaveBeenCalledTimes(2);
});
it('keeps the pending request locked while offline and offers retry only after realtime sync', async () => {
  const wrapper = await unknownOrder();
  useRealtimeStore().status = 'reconnecting';
  await flushPromises();
  expect(wrapper.get('[data-action="retry-order"]').attributes('disabled')).toBeDefined();
  await wrapper.get('[data-action="retry-order"]').trigger('click');
  expect(fetchMock).toHaveBeenCalledOnce();
  useRealtimeStore().status = 'live';
  await flushPromises();
  expect(wrapper.get('[data-action="retry-order"]').attributes('disabled')).toBeUndefined();
  expect(wrapper.get('.trade-submit').attributes('disabled')).toBeDefined();
});
it('does not unlock a conflicting request or hide its original details', async () => {
  const wrapper = await unknownOrder();
  fetchMock.mockResolvedValueOnce(failure(409, 'IDEMPOTENCY_CONFLICT', '此委托标识对应另一组参数'));
  await wrapper.get('[data-action="retry-order"]').trigger('click');
  await flushPromises();
  expect(wrapper.get('[data-testid="pending-order"]').text()).toContain('SIM001');
  expect(wrapper.text()).toContain('参数冲突');
  expect(wrapper.text()).toContain('原结果仍未确认');
  expect(wrapper.get('.trade-submit').attributes('disabled')).toBeDefined();
  expect(wrapper.text()).not.toContain('已核对委托，继续交易');
});

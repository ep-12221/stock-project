// @vitest-environment jsdom
import { createPinia, disposePinia, setActivePinia } from 'pinia';
import { flushPromises, mount } from '@vue/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createMemoryHistory, createRouter } from 'vue-router';
import HomeView from '../views/HomeView.vue';
import App from '../App.vue';
import { useHistoryStore } from '../stores/history.js';
import { useRealtimeStore } from '../stores/realtime.js';
import { useAuthStore } from '../stores/auth.js';
import { useServiceStore } from '../stores/service.js';

let pinia: ReturnType<typeof createPinia>;
const wrappers: Array<{ unmount: () => void }> = [];
beforeEach(() => {
  sessionStorage.clear();
  pinia = createPinia();
  setActivePinia(pinia);
  vi.spyOn(window, 'scrollTo').mockImplementation(() => {});
  vi.spyOn(useServiceStore(), 'refresh').mockResolvedValue();
  vi.spyOn(useRealtimeStore(), 'start').mockImplementation(() => {});
  vi.spyOn(useRealtimeStore(), 'stop').mockImplementation(() => {});
  const auth = useAuthStore();
  auth.initialized = true;
  auth.serverEpoch = 'a';
  auth.user = { id: 'alice', username: 'alice' };
  auth.account = {
    userId: 'alice',
    serverEpoch: 'a',
    accountVersion: 0,
    account: { cashBalanceCents: 12_345_678, frozenCashCents: 100, availableCashCents: 12_345_578 },
    positions: [],
    activeOrders: [],
    recentClosedOrders: [],
    recentTrades: [],
  };
  vi.spyOn(useHistoryStore().orders, 'load').mockResolvedValue();
  auth.quotes = [
    {
      symbol: 'TEST001',
      name: '服务端股票',
      previousCloseCents: 2345,
      lastPriceCents: 2345,
      changePercent: 0,
      bestBidCents: null,
      bestAskCents: null,
      updatedAt: new Date().toISOString(),
    },
  ];
});
afterEach(() => {
  wrappers.splice(0).forEach((w) => w.unmount());
  disposePinia(pinia);
});

async function setup(root = false) {
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/', component: HomeView, meta: { requiresAuth: true } },
      { path: '/login', component: { template: '<h1>登录页</h1>' } },
    ],
  });
  await router.push('/');
  const wrapper = mount(root ? App : HomeView, { global: { plugins: [pinia, router] } });
  wrappers.push(wrapper);
  return { wrapper, router, auth: useAuthStore() };
}
describe('authenticated account overview', () => {
  it('renders the current user, exact account values, and server-provided stocks', async () => {
    const { wrapper } = await setup();
    expect(wrapper.text()).toContain('alice');
    expect(wrapper.get('[data-testid="available-cash"]').text()).toContain('123,455.78');
    expect(wrapper.text()).toContain('服务端股票');
    expect(wrapper.text()).toContain('23.45');
    expect(wrapper.text()).toContain('暂无持仓');
    expect(wrapper.text()).not.toContain('星河科技');
  });
  it('logs out and returns to the login page', async () => {
    const { wrapper, router, auth } = await setup();
    const logout = vi.spyOn(auth, 'logout').mockResolvedValue();
    await wrapper.get('[data-action="logout"]').trigger('click');
    await flushPromises();
    expect(logout).toHaveBeenCalledOnce();
    expect(router.currentRoute.value.path).toBe('/login');
  });
  it('shows a failed logout and remains on the current account', async () => {
    const { wrapper, router, auth } = await setup();
    vi.spyOn(auth, 'logout').mockRejectedValue(new Error('退出失败，请重试'));
    await wrapper.get('[data-action="logout"]').trigger('click');
    await flushPromises();
    expect(wrapper.get('[role="alert"]').text()).toContain('退出失败');
    expect(router.currentRoute.value.path).toBe('/');
  });
  it('rechecks identity when the user refreshes the account', async () => {
    const { wrapper, auth } = await setup();
    const restore = vi.spyOn(auth, 'restoreSession').mockResolvedValue();
    await wrapper.get('[data-action="refresh-account"]').trigger('click');
    await flushPromises();
    expect(restore).toHaveBeenCalledOnce();
  });
  it('leaves the protected page if the identity expires while it is open', async () => {
    const { router, auth } = await setup(true);
    auth.user = null;
    auth.account = null;
    await flushPromises();
    expect(router.currentRoute.value.path).toBe('/login');
  });
});

it('shows no holdings after the last share is sold', async () => {
  const { wrapper, auth } = await setup();
  auth.account!.positions = [
    { symbol: 'SIM001', quantity: 0, frozenQuantity: 0, availableQuantity: 0 },
  ];
  await flushPromises();
  expect(wrapper.get('.holdings-empty').text()).toBe('暂无持仓');
});

it('counts a fully frozen holding but excludes a previously closed position', async () => {
  const { wrapper, auth } = await setup();
  auth.account!.positions = [
    { symbol: 'SIM001', quantity: 0, frozenQuantity: 0, availableQuantity: 0 },
    { symbol: 'SIM002', quantity: 10, frozenQuantity: 10, availableQuantity: 0 },
  ];
  await flushPromises();
  expect(wrapper.get('.holdings-empty').text()).toBe('已持有 1 只股票');
});

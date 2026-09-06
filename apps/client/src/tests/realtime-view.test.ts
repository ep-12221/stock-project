// @vitest-environment jsdom
import { createPinia, disposePinia, setActivePinia } from 'pinia';
import { flushPromises, mount } from '@vue/test-utils';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createMemoryHistory, createRouter } from 'vue-router';
import App from '../App.vue';
import HomeView from '../views/HomeView.vue';
import { useRealtimeStore } from '../stores/realtime.js';
import { useServiceStore } from '../stores/service.js';
import { authenticated, ok, order, quote, snapshot } from './trading-fixture.js';

class TestSocket extends EventTarget {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;
  static instances: TestSocket[] = [];
  readyState = 0;
  binaryType = 'blob';
  url: string;
  onopen: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onclose: ((event: CloseEvent) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  constructor(url: string) {
    super();
    this.url = url;
    TestSocket.instances.push(this);
  }
  open() {
    this.readyState = 1;
    const event = new Event('open');
    this.dispatchEvent(event);
    this.onopen?.(event);
  }
  receive(data: unknown) {
    const event = new MessageEvent('message', { data: JSON.stringify(data) });
    this.dispatchEvent(event);
    this.onmessage?.(event);
  }
  close(code = 1000) {
    this.readyState = 3;
    const event = new CloseEvent('close', { code });
    this.dispatchEvent(event);
    this.onclose?.(event);
  }
  send() {
    /* Browser only receives state frames. */
  }
}
let pinia: ReturnType<typeof createPinia>;
const wrappers: Array<{ unmount(): void }> = [];
let fetchMock: ReturnType<typeof vi.fn>;
beforeEach(() => {
  sessionStorage.clear();
  pinia = createPinia();
  setActivePinia(pinia);
  authenticated();
  TestSocket.instances = [];
  vi.stubGlobal('WebSocket', TestSocket);
  vi.spyOn(useServiceStore(), 'refresh').mockResolvedValue();
  fetchMock = vi.fn(async (url: string) => {
    if (url === '/api/auth/me')
      return ok({
        user: { id: 'alice', username: 'alice' },
        serverEpoch: 'epoch',
        expiresAt: new Date(Date.now() + 60000).toISOString(),
      });
    return ok({
      userId: 'alice',
      serverEpoch: 'epoch',
      accountVersion: 1,
      marketVersion: 1,
      items: [],
      nextCursor: null,
    });
  });
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => {
  wrappers.splice(0).forEach((wrapper) => wrapper.unmount());
  disposePinia(pinia);
  vi.unstubAllGlobals();
});
const market = (version = 1) => ({
  marketVersion: version,
  quotes: [quote(), quote('SIM002', 2000)],
  recentTrades: [],
});
const frame = (type: string, payload: unknown) => ({
  type,
  serverEpoch: 'epoch',
  emittedAt: '2026-09-06T00:00:00.000Z',
  payload,
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
  return { wrapper, router, socket: TestSocket.instances[0]! };
}
async function connect(socket: TestSocket) {
  socket.open();
  socket.receive(frame('state.snapshot', { market: market(), account: snapshot() }));
  await flushPromises();
}
it('starts one session connection and blocks orders until the initial full snapshot', async () => {
  const { wrapper, socket } = await workspace();
  expect(TestSocket.instances).toHaveLength(1);
  expect(wrapper.get('.trade-submit').attributes('disabled')).toBeDefined();
  expect(wrapper.get('[data-testid="realtime-notice"]').text()).toContain('同步');
  socket.open();
  await flushPromises();
  expect(wrapper.get('.trade-submit').attributes('disabled')).toBeDefined();
  socket.receive(frame('state.snapshot', { market: market(), account: snapshot() }));
  await flushPromises();
  expect(wrapper.get('.trade-submit').attributes('disabled')).toBeUndefined();
  expect(wrapper.get('[data-testid="realtime-status"]').text()).toContain('实时已连接');
  useRealtimeStore().start();
  expect(TestSocket.instances).toHaveLength(1);
  wrapper.unmount();
  wrappers.splice(wrappers.indexOf(wrapper), 1);
  expect(socket.readyState).toBe(TestSocket.CLOSED);
});
it('updates passive fills and market prices without a refresh or overwriting the entered price', async () => {
  const { wrapper, socket } = await workspace();
  await connect(socket);
  await wrapper.get('[name="price"]').setValue('12.34');
  const reads = fetchMock.mock.calls.length;
  const next = snapshot(2);
  next.account = { cashBalanceCents: 99899900, availableCashCents: 99899900, frozenCashCents: 0 };
  next.positions = [{ symbol: 'SIM001', quantity: 100, availableQuantity: 100, frozenQuantity: 0 }];
  next.recentClosedOrders = [
    { ...order(), status: 'FILLED', filledQuantity: 100, executedValueCents: 100100 },
  ];
  socket.receive(frame('account.updated', next));
  socket.receive(
    frame('market.updated', {
      ...market(2),
      quotes: [{ ...quote(), lastPriceCents: 1100, changePercent: 10 }, quote('SIM002', 2000)],
    }),
  );
  await flushPromises();
  expect(wrapper.get('[data-testid="available-cash"]').text()).toContain('998,999.00');
  expect(wrapper.get('[data-testid="position-table"]').text()).toContain('100');
  expect(wrapper.get('.history-panel').text()).toContain('全部成交');
  expect(wrapper.get('[data-symbol="SIM001"]').text()).toContain('11.00');
  expect((wrapper.get('[name="price"]').element as HTMLInputElement).value).toBe('12.34');
  expect(fetchMock.mock.calls.length).toBe(reads);
});
it('retains assets and input while disconnected and offers an explicit reconnect', async () => {
  const { wrapper, socket } = await workspace();
  await connect(socket);
  await wrapper.get('[name="price"]').setValue('12.34');
  socket.close(1006);
  await flushPromises();
  expect(wrapper.get('.trade-submit').attributes('disabled')).toBeDefined();
  expect(wrapper.get('[data-testid="available-cash"]').text()).toContain('1,000,000.00');
  expect(wrapper.get('[data-testid="realtime-notice"]').text()).toContain('过期');
  await wrapper.get('[data-action="reconnect"]').trigger('click');
  await flushPromises();
  expect(TestSocket.instances).toHaveLength(2);
  await connect(TestSocket.instances[1]!);
  expect(wrapper.get('.trade-submit').attributes('disabled')).toBeUndefined();
  expect((wrapper.get('[name="price"]').element as HTMLInputElement).value).toBe('12.34');
});
it('leaves the private workspace when the server expires the WebSocket session', async () => {
  const { router, socket } = await workspace();
  await connect(socket);
  socket.close(4401);
  await flushPromises();
  expect(router.currentRoute.value.path).toBe('/login');
});

import type {
  AccountStateDto,
  CreateOrderRequest,
  CreateOrderResponse,
  OrderDto,
  OrderStatus,
  Paginated,
  PersonalTradeDto,
  PublicTradeDto,
  StocksDto,
} from '@stock/shared';
import { defineStore } from 'pinia';
import { computed, onScopeDispose, ref, shallowReactive, shallowRef, watch } from 'vue';
import { apiRequest, HttpError } from '../services/http.js';
import {
  readPendingOrder,
  removePendingOrder,
  writePendingOrder,
} from '../services/pending-order.js';
import { isAccountStateDto, isOrderDto } from '../services/realtime-event.js';
import { useAuthStore } from './auth.js';
import { useAccountStore } from './account.js';
import { useMarketStore } from './market.js';
import { useRealtimeStore } from './realtime.js';
export type LimitOrderInput = Pick<
  CreateOrderRequest,
  'symbol' | 'side' | 'priceCents' | 'quantity'
>;
export interface HistoryFilters {
  symbol?: string;
  status?: OrderStatus | '';
}
interface Identity {
  userId: string;
  serverEpoch: string;
  revision: number;
}
interface HistoryPage<T> extends Paginated<T> {
  serverEpoch: string;
  userId?: string;
  accountVersion?: number;
  marketVersion?: number;
}
export const useTradingStore = defineStore('trading', () => {
  const auth = useAuthStore();
  const accounts = useAccountStore();
  const market = useMarketStore();
  const realtime = useRealtimeStore();
  const submitting = ref(false);
  const refreshing = ref(false);
  const stale = ref(false);
  const uncertain = ref(false);
  const pendingOrder = shallowRef<Readonly<CreateOrderRequest> | null>(null);
  const storageBlocked = ref(false);
  const accountReviewed = ref(false);
  const error = ref<string | null>(null);
  const notice = ref<string | null>(null);
  const warning = ref<string | null>(null);
  let command = 0;
  function identity(): Identity | null {
    return auth.user && auth.serverEpoch
      ? { userId: auth.user.id, serverEpoch: auth.serverEpoch, revision: auth.sessionRevision }
      : null;
  }
  function current(owner: Identity): boolean {
    return (
      auth.user?.id === owner.userId &&
      auth.serverEpoch === owner.serverEpoch &&
      auth.sessionRevision === owner.revision
    );
  }
  function assertIdentity(
    data: { serverEpoch: string; userId?: string },
    owner: Identity,
    privateData: boolean,
  ) {
    if (data.serverEpoch !== owner.serverEpoch || (privateData && data.userId !== owner.userId)) {
      auth.invalidateSession('登录身份或服务状态已变化，请重新登录');
      throw new Error('登录身份或服务状态已变化，请重新登录');
    }
  }
  function handleAuthFailure(cause: unknown) {
    if (cause instanceof HttpError && cause.status === 401) auth.invalidateSession();
  }
  const message = (cause: unknown) =>
    cause instanceof Error ? cause.message : '请求失败，请稍后重试';
  function history<T extends { id: string; sequence: number; symbol: string }>(
    path: string,
    privateData: boolean,
    capacity: number,
  ) {
    let revision = 0;
    let windowVersion = -1;
    let windowRecords: T[] = [];
    let recentWindow: T[] = [];
    let activeIds: Set<string> | null = null;
    let records = new Map<string, { item: T; version: number }>();
    let baseCursor: number | null = null;
    // A cursor is exclusive. Gaps reopen pagination above potentially missing records.
    // A stale HTTP page cannot certify that a gap created by a later snapshot is filled.
    const gaps = new Map<number, number>();
    const state = shallowReactive({
      items: [] as T[],
      nextCursor: null as number | null,
      loading: false,
      loaded: false,
      error: null as string | null,
      filters: {} as HistoryFilters,
    });
    const isActive = (item: T) =>
      'status' in item && (item.status === 'OPEN' || item.status === 'PARTIALLY_FILLED');
    function matches(item: T) {
      return (
        (!state.filters.symbol || item.symbol === state.filters.symbol) &&
        (!state.filters.status || !('status' in item) || item.status === state.filters.status)
      );
    }
    function markGap(cursor: number, version: number) {
      gaps.set(cursor, Math.max(gaps.get(cursor) ?? -1, version));
    }
    function render() {
      state.items = [...records.values()]
        .map((record) => record.item)
        .filter(matches)
        .sort((left, right) => right.sequence - left.sequence);
      const cursor = Math.max(baseCursor ?? 0, ...gaps.keys());
      state.nextCursor = cursor || null;
    }
    function merge(items: T[], version: number, fromPage = false) {
      for (const item of items) {
        // Active membership is complete even when old closed orders fall out of the window.
        if (
          fromPage &&
          version < windowVersion &&
          activeIds &&
          isActive(item) &&
          !activeIds.has(item.id)
        ) {
          if (!windowRecords.some((record) => record.id === item.id))
            markGap(item.sequence + 1, windowVersion);
          continue;
        }
        const previous = records.get(item.id);
        if (!previous || previous.version <= version) records.set(item.id, { item, version });
      }
    }
    function applyWindow(items: T[], version: number, recent: T[], active?: T[]) {
      if (version <= windowVersion) return;
      const previousWindow = windowRecords;
      const previousHigh = Math.max(0, ...recentWindow.map((item) => item.sequence));
      const floor = recent.length ? Math.min(...recent.map((item) => item.sequence)) : 0;
      windowVersion = version;
      windowRecords = items;
      recentWindow = recent;
      activeIds = active ? new Set(active.map((item) => item.id)) : null;
      if (!state.loaded && !state.loading) return;
      if (recent.length >= capacity && floor > previousHigh) markGap(floor, version);
      if (activeIds) {
        const nextIds = new Set(items.map((item) => item.id));
        // Initial/refresh HTTP reads clear the page cache while in flight. Compare
        // complete active windows too, so a just-closed ancient order still opens
        // a gap when it is absent from both the page cache and the recent window.
        for (const previous of previousWindow) {
          if (
            isActive(previous) &&
            !activeIds.has(previous.id) &&
            !nextIds.has(previous.id) &&
            !records.has(previous.id)
          )
            markGap(previous.sequence + 1, version);
        }
      }
      for (const [id, record] of records) {
        if (activeIds && record.version <= version && isActive(record.item) && !activeIds.has(id)) {
          records.delete(id);
          if (!items.some((item) => item.id === id)) markGap(record.item.sequence + 1, version);
        }
      }
      merge(items, version);
      render();
    }
    function reset() {
      revision++;
      windowVersion = -1;
      windowRecords = [];
      recentWindow = [];
      activeIds = null;
      records.clear();
      gaps.clear();
      baseCursor = null;
      state.items = [];
      state.nextCursor = null;
      state.loading = false;
      state.loaded = false;
      state.error = null;
      state.filters = {};
    }
    async function load(filters: HistoryFilters = state.filters, more = false): Promise<void> {
      const owner = identity();
      if (!owner) {
        reset();
        return;
      }
      if (more && (state.loading || state.nextCursor === null)) return;
      const request = ++revision;
      const cursor = more ? state.nextCursor : null;
      state.filters = { ...filters };
      state.loading = true;
      state.error = null;
      if (!more) {
        records = new Map();
        gaps.clear();
        baseCursor = null;
        state.items = [];
        state.nextCursor = null;
      }
      const query = new URLSearchParams({ limit: '50' });
      if (filters.symbol) query.set('symbol', filters.symbol);
      if (filters.status && path === '/api/me/orders') query.set('status', filters.status);
      if (cursor !== null) query.set('cursor', String(cursor));
      try {
        const data = await apiRequest<HistoryPage<T>>(path + '?' + query);
        if (request !== revision || !current(owner)) return;
        assertIdentity(data, owner, privateData);
        const version = privateData ? data.accountVersion : data.marketVersion;
        if (version === undefined || !Number.isSafeInteger(version) || version < 0)
          throw new Error('记录版本无效，请刷新列表');
        // Trade rows and closed orders are immutable. Old page metadata is normal while
        // quotes tick or an unrelated order changes; per-record versions protect mutations.
        merge(data.items, version, true);
        merge(windowRecords, windowVersion);
        baseCursor = data.nextCursor;
        for (const [gap, createdAt] of gaps) {
          if (
            version >= createdAt &&
            gap <= (cursor ?? Infinity) &&
            (data.nextCursor === null || gap > data.nextCursor)
          )
            gaps.delete(gap);
        }
        const floor = recentWindow.length
          ? Math.min(...recentWindow.map((item) => item.sequence))
          : 0;
        const pageHigh = Math.max(0, ...data.items.map((item) => item.sequence));
        if (version < windowVersion && recentWindow.length >= capacity && floor > pageHigh)
          markGap(floor, windowVersion);
        state.loaded = true;
        render();
      } catch (cause) {
        if (request !== revision || !current(owner)) return;
        handleAuthFailure(cause);
        if (current(owner)) state.error = message(cause);
      } finally {
        if (request === revision) state.loading = false;
      }
    }
    return Object.assign(state, { load, reset, applyWindow });
  }
  const orders = history<OrderDto>('/api/me/orders', true, 100);
  const personalTrades = history<PersonalTradeDto>('/api/me/trades', true, 50);
  const marketTrades = history<PublicTradeDto>('/api/trades', false, 50);
  watch(
    () => accounts.snapshot,
    (next) => {
      if (!next || next.userId !== auth.user?.id || next.serverEpoch !== auth.serverEpoch) return;
      orders.applyWindow(
        [...next.activeOrders, ...next.recentClosedOrders],
        next.accountVersion,
        next.recentClosedOrders,
        next.activeOrders,
      );
      personalTrades.applyWindow(next.recentTrades, next.accountVersion, next.recentTrades);
    },
    { immediate: true, flush: 'sync' },
  );
  watch(
    () => market.tradeWindowVersion,
    (version) => {
      if (version < 0 || market.serverEpoch !== auth.serverEpoch) return;
      marketTrades.applyWindow(market.recentTrades, version, market.recentTrades);
    },
    { immediate: true, flush: 'sync' },
  );
  const reviewReady = computed(
    () =>
      !pendingOrder.value &&
      accountReviewed.value &&
      orders.loaded &&
      !orders.loading &&
      !orders.error &&
      !orders.filters.symbol &&
      !orders.filters.status,
  );
  async function refreshMarket(owner: Identity) {
    const data = await apiRequest<StocksDto>('/api/stocks');
    if (!current(owner)) return;
    assertIdentity(data, owner, false);
    market.applySnapshot(data, owner.serverEpoch);
  }
  async function refreshBalances(owner: Identity) {
    const results = await Promise.allSettled([
      apiRequest<AccountStateDto>('/api/me/snapshot'),
      ...(!realtime.enabled ? [refreshMarket(owner)] : []),
    ]);
    if (!current(owner)) return;
    const account = results[0];
    if (account.status === 'fulfilled') {
      assertIdentity(account.value, owner, true);
      accounts.applySnapshot(account.value, owner);
    }
    for (const result of results)
      if (result.status === 'rejected') {
        handleAuthFailure(result.reason);
        throw result.reason;
      }
  }
  async function reloadLoaded() {
    await Promise.all(
      [orders, personalTrades, marketTrades]
        .filter((list) => list.loaded || list.loading)
        .map((list) => list.load()),
    );
  }
  const canOperate = computed(
    () =>
      !!auth.user &&
      !!auth.serverEpoch &&
      accounts.snapshot?.userId === auth.user.id &&
      accounts.snapshot.serverEpoch === auth.serverEpoch &&
      !auth.busy &&
      !submitting.value &&
      !refreshing.value &&
      (!realtime.enabled || realtime.ready),
  );
  const canSubmit = computed(
    () =>
      canOperate.value &&
      !storageBlocked.value &&
      !pendingOrder.value &&
      !stale.value &&
      !uncertain.value,
  );
  // Retrying the original request is valid even after its first attempt froze the
  // available balance or shares. Only identity, connection and concurrency gate it.
  const canRetry = computed(() => canOperate.value && !!pendingOrder.value);
  function markUncertain(reason = '下单结果未确认，请使用原委托重试并确认，勿另建相同委托。') {
    uncertain.value = true;
    stale.value = true;
    accountReviewed.value = false;
    error.value = reason;
  }
  function restorePending() {
    const owner = identity();
    if (!owner) return;
    try {
      pendingOrder.value = readPendingOrder(owner);
      storageBlocked.value = false;
      if (pendingOrder.value)
        markUncertain('已恢复待确认委托。请核对原委托后重试；页面不会自动提交。');
    } catch (cause) {
      storageBlocked.value = true;
      error.value = message(cause);
    }
  }
  function finishPending(owner: Identity, input: CreateOrderRequest): boolean {
    try {
      removePendingOrder(owner, input);
      pendingOrder.value = null;
      storageBlocked.value = false;
      uncertain.value = false;
      stale.value = false;
      accountReviewed.value = false;
      return true;
    } catch (cause) {
      // Keep the original key locked until its durable recovery record is removed.
      // A later explicit retry remains safe because the server replays the same order.
      markUncertain('服务已返回结果，但本地委托恢复记录未清除。请恢复浏览器存储后重试原委托确认。');
      warning.value = message(cause);
      return false;
    }
  }
  async function sendOrder(owner: Identity, input: Readonly<CreateOrderRequest>): Promise<boolean> {
    const request = ++command;
    const active = () => request === command && current(owner);
    submitting.value = true;
    error.value = null;
    notice.value = null;
    warning.value = null;
    try {
      // This is synchronous and precedes POST, including every explicit retry.
      // Never use the edited form to replace the durable original request.
      try {
        writePendingOrder(owner, input);
      } catch (cause) {
        storageBlocked.value = true;
        error.value = message(cause);
        return false;
      }
      pendingOrder.value = Object.freeze({ ...input });
      const data = await apiRequest<CreateOrderResponse>('/api/orders', {
        method: 'POST',
        body: input,
      });
      if (!active()) return false;
      if (!data || !isAccountStateDto(data.snapshot) || !isOrderDto(data.order))
        throw new Error('委托响应格式不正确');
      assertIdentity(data.snapshot, owner, true);
      if (
        data.order.symbol !== input.symbol ||
        data.order.side !== input.side ||
        data.order.priceCents !== input.priceCents ||
        data.order.quantity !== input.quantity
      )
        throw new Error('委托响应与原请求不一致');
      accounts.applySnapshot(data.snapshot, owner);
      const labels: Record<OrderStatus, string> = {
        OPEN: '已挂单',
        PARTIALLY_FILLED: '部分成交',
        FILLED: '全部成交',
        CANCELLED: '已撤销',
      };
      notice.value =
        labels[data.order.status] +
        ' · ' +
        data.order.symbol +
        ' · ' +
        data.order.filledQuantity +
        '/' +
        data.order.quantity +
        ' 股';
      finishPending(owner, input);
      try {
        if (!realtime.enabled) {
          await refreshMarket(owner);
          await reloadLoaded();
        }
      } catch (cause) {
        if (active()) {
          handleAuthFailure(cause);
          if (active()) {
            stale.value = true;
            warning.value = '委托已受理，行情刷新失败，请刷新后继续下单。';
          }
        }
      }
      return true;
    } catch (cause) {
      if (!active()) return false;
      handleAuthFailure(cause);
      if (!active()) return false;
      if (cause instanceof HttpError && cause.code === 'IDEMPOTENCY_CONFLICT') {
        markUncertain('委托标识与服务端原委托参数冲突，原结果仍未确认。已保留原委托并暂停新下单。');
      } else if (!(cause instanceof HttpError) || cause.status >= 500 || cause.status === 408) {
        markUncertain();
      } else {
        const cleared = finishPending(owner, input);
        if (cleared) error.value = message(cause);
        if (cause.status === 409) {
          try {
            await refreshBalances(owner);
            if (active() && !realtime.enabled) await reloadLoaded();
          } catch {
            if (active()) {
              stale.value = true;
              warning.value = '账户刷新失败，请刷新后继续下单。';
            }
          }
        }
      }
      return false;
    } finally {
      if (request === command) submitting.value = false;
    }
  }
  async function submit(input: LimitOrderInput): Promise<boolean> {
    const owner = identity();
    if (!owner || !canSubmit.value) return false;
    let clientOrderId: string;
    try {
      clientOrderId = crypto.randomUUID();
    } catch {
      error.value = '浏览器无法创建安全的委托标识，请在 localhost 或 HTTPS 页面下单。';
      return false;
    }
    return sendOrder(
      owner,
      Object.freeze({
        clientOrderId,
        symbol: input.symbol,
        side: input.side,
        priceCents: input.priceCents,
        quantity: input.quantity,
      }),
    );
  }
  async function retryPending(): Promise<boolean> {
    const owner = identity();
    const original = pendingOrder.value;
    if (!owner || !original || !canRetry.value) return false;
    return sendOrder(owner, original);
  }
  async function refresh(): Promise<void> {
    if (refreshing.value || submitting.value || auth.busy) return;
    const owner = identity();
    if (!owner) return;
    refreshing.value = true;
    try {
      if (storageBlocked.value) {
        restorePending();
        if (storageBlocked.value) throw new Error(error.value ?? '浏览器存储不可用');
      }
      if (realtime.enabled) {
        // The live channel owns market/history synchronization. Explicit refresh still
        // verifies the account; an unknown POST additionally requires HTTP order review.
        await refreshBalances(owner);
        if (!current(owner)) return;
        if (uncertain.value) await orders.load();
      } else {
        await auth.restoreSession();
        if (!current(owner)) return;
        if (auth.error) throw new Error(auth.error);
        await Promise.all([
          orders.load(),
          ...[personalTrades, marketTrades]
            .filter((list) => list.loaded || list.loading)
            .map((list) => list.load()),
        ]);
      }
      if (!current(owner)) return;
      stale.value = false;
      warning.value = null;
      if (uncertain.value) accountReviewed.value = true;
      else error.value = null;
    } catch (cause) {
      if (current(owner)) {
        stale.value = true;
        warning.value = message(cause);
      }
    } finally {
      if (current(owner)) refreshing.value = false;
    }
  }
  function acknowledgeOutcome(): boolean {
    if (
      pendingOrder.value ||
      storageBlocked.value ||
      !uncertain.value ||
      !reviewReady.value ||
      stale.value ||
      !auth.user
    )
      return false;
    uncertain.value = false;
    accountReviewed.value = false;
    error.value = null;
    return true;
  }
  function reset() {
    command++;
    submitting.value = false;
    refreshing.value = false;
    stale.value = false;
    uncertain.value = false;
    pendingOrder.value = null;
    storageBlocked.value = false;
    accountReviewed.value = false;
    error.value = null;
    notice.value = null;
    warning.value = null;
    orders.reset();
    personalTrades.reset();
    marketTrades.reset();
  }
  watch(
    [() => auth.user?.id, () => auth.serverEpoch],
    () => {
      reset();
      restorePending();
    },
    { flush: 'sync' },
  );
  restorePending();
  watch(
    () => auth.sessionRevision,
    () => {
      refreshing.value = false;
      if (submitting.value) {
        command++;
        submitting.value = false;
        if (pendingOrder.value) markUncertain();
      }
    },
    { flush: 'sync' },
  );
  onScopeDispose(reset);
  return {
    submitting,
    refreshing,
    stale,
    uncertain,
    pendingOrder,
    canRetry,
    reviewReady,
    error,
    notice,
    warning,
    canSubmit,
    orders,
    personalTrades,
    marketTrades,
    submit,
    retryPending,
    refresh,
    acknowledgeOutcome,
  };
});

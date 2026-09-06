import type {
  OrderDto,
  OrderStatus,
  Paginated,
  PersonalTradeDto,
  PublicTradeDto,
} from '@stock/shared';
import { defineStore } from 'pinia';
import { onScopeDispose, shallowReactive, watch } from 'vue';
import { apiRequest, HttpError } from '../services/http.js';
import { useAuthStore } from './auth.js';
import { useAccountStore } from './account.js';
import { useMarketStore } from './market.js';

export interface HistoryFilters {
  symbol?: string;
  status?: OrderStatus | '';
}
interface HistoryPage<T> extends Paginated<T> {
  serverEpoch: string;
  userId?: string;
  accountVersion?: number;
  marketVersion?: number;
}

/** Query state and snapshot/page merging are independent of submitting or retrying an order. */
export const useHistoryStore = defineStore('history', () => {
  const auth = useAuthStore();
  const accounts = useAccountStore();
  const market = useMarketStore();
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
      const owner = auth.captureIdentity();
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
        if (request !== revision || !auth.isCurrentIdentity(owner)) return;
        auth.assertResponseIdentity(data, owner, privateData);
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
        if (request !== revision || !auth.isCurrentIdentity(owner)) return;
        if (cause instanceof HttpError && cause.status === 401) auth.invalidateSession();
        if (auth.isCurrentIdentity(owner))
          state.error = cause instanceof Error ? cause.message : '请求失败，请稍后重试';
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
  const lists = [orders, personalTrades, marketTrades];
  async function reloadLoaded() {
    await Promise.all(
      lists.filter((list) => list.loaded || list.loading).map((list) => list.load()),
    );
  }
  function reset() {
    for (const list of lists) list.reset();
  }
  watch([() => auth.user?.id, () => auth.serverEpoch], reset, { flush: 'sync' });
  onScopeDispose(reset);
  return { orders, personalTrades, marketTrades, reloadLoaded };
});

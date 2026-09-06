import type {
  AccountStateDto,
  CreateOrderRequest,
  CreateOrderResponse,
  OrderStatus,
  StocksDto,
} from '@stock/shared';
import { defineStore } from 'pinia';
import { computed, onScopeDispose, ref, shallowRef, watch } from 'vue';
import { apiRequest, HttpError } from '../services/http.js';
import {
  readPendingOrder,
  removePendingOrder,
  writePendingOrder,
} from '../services/pending-order.js';
import { isAccountStateDto, isOrderDto } from '../services/realtime-event.js';
import { useAuthStore, type SessionIdentity } from './auth.js';
import { useHistoryStore } from './history.js';
import { useAccountStore } from './account.js';
import { useMarketStore } from './market.js';
import { useRealtimeStore } from './realtime.js';
export type LimitOrderInput = Pick<
  CreateOrderRequest,
  'symbol' | 'side' | 'priceCents' | 'quantity'
>;
export const useTradingStore = defineStore('trading', () => {
  const auth = useAuthStore();
  const accounts = useAccountStore();
  const market = useMarketStore();
  const realtime = useRealtimeStore();
  const history = useHistoryStore();
  const { orders, personalTrades, marketTrades } = history;
  const submitting = ref(false);
  const refreshing = ref(false);
  const stale = ref(false);
  const uncertain = ref(false);
  const pendingOrder = shallowRef<Readonly<CreateOrderRequest> | null>(null);
  const storageBlocked = ref(false);
  const error = ref<string | null>(null);
  const notice = ref<string | null>(null);
  const warning = ref<string | null>(null);
  let command = 0;
  function handleAuthFailure(cause: unknown) {
    if (cause instanceof HttpError && cause.status === 401) auth.invalidateSession();
  }
  const message = (cause: unknown) =>
    cause instanceof Error ? cause.message : '请求失败，请稍后重试';
  async function refreshMarket(owner: SessionIdentity) {
    const data = await apiRequest<StocksDto>('/api/stocks');
    if (!auth.isCurrentIdentity(owner)) return;
    auth.assertResponseIdentity(data, owner, false);
    market.applySnapshot(data, owner.serverEpoch);
  }
  async function refreshBalances(owner: SessionIdentity) {
    const results = await Promise.allSettled([
      apiRequest<AccountStateDto>('/api/me/snapshot'),
      ...(!realtime.enabled ? [refreshMarket(owner)] : []),
    ]);
    if (!auth.isCurrentIdentity(owner)) return;
    const account = results[0];
    if (account.status === 'fulfilled') {
      auth.assertResponseIdentity(account.value, owner, true);
      accounts.applySnapshot(account.value, owner);
    }
    for (const result of results)
      if (result.status === 'rejected') {
        handleAuthFailure(result.reason);
        throw result.reason;
      }
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
    error.value = reason;
  }
  function restorePending() {
    const owner = auth.captureIdentity();
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
  function finishPending(owner: SessionIdentity, input: CreateOrderRequest): boolean {
    try {
      removePendingOrder(owner, input);
      pendingOrder.value = null;
      storageBlocked.value = false;
      uncertain.value = false;
      stale.value = false;
      return true;
    } catch (cause) {
      // Keep the original key locked until its durable recovery record is removed.
      // A later explicit retry remains safe because the server replays the same order.
      markUncertain('服务已返回结果，但本地委托恢复记录未清除。请恢复浏览器存储后重试原委托确认。');
      warning.value = message(cause);
      return false;
    }
  }
  async function sendOrder(
    owner: SessionIdentity,
    input: Readonly<CreateOrderRequest>,
  ): Promise<boolean> {
    const request = ++command;
    const active = () => request === command && auth.isCurrentIdentity(owner);
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
      auth.assertResponseIdentity(data.snapshot, owner, true);
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
          await history.reloadLoaded();
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
            if (active() && !realtime.enabled) await history.reloadLoaded();
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
    const owner = auth.captureIdentity();
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
    const owner = auth.captureIdentity();
    const original = pendingOrder.value;
    if (!owner || !original || !canRetry.value) return false;
    return sendOrder(owner, original);
  }
  async function refresh(): Promise<void> {
    if (refreshing.value || submitting.value || auth.busy) return;
    const owner = auth.captureIdentity();
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
        if (!auth.isCurrentIdentity(owner)) return;
        if (uncertain.value) await orders.load();
      } else {
        await auth.restoreSession();
        if (!auth.isCurrentIdentity(owner)) return;
        if (auth.error) throw new Error(auth.error);
        await Promise.all([
          orders.load(),
          ...[personalTrades, marketTrades]
            .filter((list) => list.loaded || list.loading)
            .map((list) => list.load()),
        ]);
      }
      if (!auth.isCurrentIdentity(owner)) return;
      stale.value = false;
      warning.value = null;
      if (!uncertain.value) error.value = null;
    } catch (cause) {
      if (auth.isCurrentIdentity(owner)) {
        stale.value = true;
        warning.value = message(cause);
      }
    } finally {
      if (auth.isCurrentIdentity(owner)) refreshing.value = false;
    }
  }
  function reset() {
    command++;
    submitting.value = false;
    refreshing.value = false;
    stale.value = false;
    uncertain.value = false;
    pendingOrder.value = null;
    storageBlocked.value = false;
    error.value = null;
    notice.value = null;
    warning.value = null;
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
    error,
    notice,
    warning,
    canSubmit,
    submit,
    retryPending,
    refresh,
  };
});

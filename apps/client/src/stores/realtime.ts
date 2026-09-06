import type { AuthDto } from '@stock/shared';
import { defineStore } from 'pinia';
import { computed, onScopeDispose, ref, watch, type WatchStopHandle } from 'vue';
import { apiRequest, HttpError } from '../services/http.js';
import { parseRealtimeEvent } from '../services/realtime-event.js';
import { useAccountStore } from './account.js';
import { useAuthStore, type SessionIdentity } from './auth.js';
import { useMarketStore } from './market.js';

type ConnectionStatus = 'idle' | 'connecting' | 'syncing' | 'live' | 'reconnecting' | 'offline';

export const useRealtimeStore = defineStore('realtime', () => {
  const auth = useAuthStore();
  const accounts = useAccountStore();
  const market = useMarketStore();
  const enabled = ref(false);
  const status = ref<ConnectionStatus>('idle');
  const error = ref<string | null>(null);
  const ready = computed(() => status.value === 'live');
  let socket: WebSocket | null = null;
  let generation = 0;
  let failures = 0;
  let stopWatching: WatchStopHandle | undefined;
  let retryTimer: ReturnType<typeof setTimeout> | undefined;
  let handshakeTimer: ReturnType<typeof setTimeout> | undefined;
  let livenessTimer: ReturnType<typeof setTimeout> | undefined;
  let probeTimer: ReturnType<typeof setTimeout> | undefined;
  let probeController: AbortController | undefined;

  function owner(): SessionIdentity | null {
    return auth.busy ? null : auth.captureIdentity();
  }
  function owns(expected: SessionIdentity, revision: number): boolean {
    return (
      enabled.value && generation === revision && !auth.busy && auth.isCurrentIdentity(expected)
    );
  }
  function releaseSocket() {
    clearTimeout(handshakeTimer);
    handshakeTimer = undefined;
    clearTimeout(livenessTimer);
    livenessTimer = undefined;
    const old = socket;
    socket = null;
    if (!old) return;
    old.onopen = old.onmessage = old.onclose = old.onerror = null;
    old.close();
  }
  function cancelPending() {
    clearTimeout(retryTimer);
    retryTimer = undefined;
    clearTimeout(probeTimer);
    probeTimer = undefined;
    probeController?.abort();
    probeController = undefined;
  }
  function resetConnection() {
    generation++;
    cancelPending();
    releaseSocket();
    status.value = 'idle';
  }
  async function probeIdentity(expected: SessionIdentity, revision: number) {
    const controller = new AbortController();
    probeController = controller;
    probeTimer = setTimeout(() => controller.abort(), 5000);
    try {
      const identity = await apiRequest<AuthDto>('/api/auth/me', { signal: controller.signal });
      if (!owns(expected, revision) || probeController !== controller) return;
      if (
        identity?.user?.id &&
        identity.serverEpoch &&
        (identity.user.id !== expected.userId || identity.serverEpoch !== expected.serverEpoch)
      ) {
        auth.invalidateSession('登录身份或服务状态已变化，请重新登录');
      }
    } catch (cause) {
      if (
        owns(expected, revision) &&
        probeController === controller &&
        cause instanceof HttpError &&
        cause.status === 401
      ) {
        auth.invalidateSession('登录已失效，请重新登录');
      }
    } finally {
      if (probeController === controller) {
        clearTimeout(probeTimer);
        probeTimer = undefined;
        probeController = undefined;
      }
    }
  }
  function retry(expected: SessionIdentity, revision: number, message: string) {
    if (!owns(expected, revision)) return;
    // Detach handlers before closing, so error + close cannot schedule twice.
    releaseSocket();
    status.value = 'reconnecting';
    error.value = message;
    const delay = Math.min(
      30000,
      1000 * 2 ** Math.min(failures++, 5) * (0.8 + Math.random() * 0.4),
    );
    retryTimer = setTimeout(() => {
      if (owns(expected, revision)) connect();
    }, delay);
    void probeIdentity(expected, revision);
  }
  function connect() {
    resetConnection();
    const expected = owner();
    if (!enabled.value || !expected) return;
    const revision = generation;
    status.value = failures ? 'reconnecting' : 'connecting';
    let connection: WebSocket;
    try {
      const url = new URL('/ws', globalThis.location.href);
      url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
      connection = new WebSocket(url.toString());
      socket = connection;
    } catch {
      retry(expected, revision, '实时连接暂时不可用，正在重试');
      return;
    }
    const active = () => owns(expected, revision) && socket === connection;
    let synchronized = false;
    handshakeTimer = setTimeout(() => {
      if (active()) retry(expected, revision, '同步等待超时，正在重新连接');
    }, 10000);
    connection.onopen = () => {
      if (active()) status.value = 'syncing';
    };
    connection.onmessage = (message) => {
      if (!active()) return;
      const event = parseRealtimeEvent(message.data);
      if (!event || (!synchronized && event.type !== 'state.snapshot')) {
        retry(expected, revision, '实时数据格式不正确，正在重新同步');
        return;
      }
      const account =
        event.type === 'state.snapshot'
          ? event.payload.account
          : event.type === 'account.updated'
            ? event.payload
            : null;
      if (
        event.serverEpoch !== expected.serverEpoch ||
        (account &&
          (account.userId !== expected.userId || account.serverEpoch !== expected.serverEpoch))
      ) {
        auth.invalidateSession('登录身份或服务状态已变化，请重新登录');
        return;
      }
      // Versions belong to independent domains. Receiving an equal/older first
      // snapshot still completes this handshake without rolling either domain back.
      if (account) accounts.applySnapshot(account, expected);
      if (event.type === 'state.snapshot' || event.type === 'market.updated') {
        const next = {
          ...(event.type === 'state.snapshot' ? event.payload.market : event.payload),
          serverEpoch: event.serverEpoch,
        };
        market.applySnapshot(next, expected.serverEpoch);
      }
      if (event.type === 'state.snapshot') {
        synchronized = true;
        clearTimeout(handshakeTimer);
        handshakeTimer = undefined;
        failures = 0;
        error.value = null;
        status.value = 'live';
      }
      // The server sends market frames every second. TCP black holes can leave
      // the browser socket apparently open, so missing valid frames must also
      // suspend trading and restart synchronization.
      clearTimeout(livenessTimer);
      livenessTimer = setTimeout(() => {
        if (active()) retry(expected, revision, '实时数据长时间未更新，正在重新同步');
      }, 15000);
    };
    connection.onclose = (event) => {
      if (!active()) return;
      if (event.code === 4401) {
        auth.invalidateSession('登录已失效，请重新登录');
        return;
      }
      retry(expected, revision, '实时连接已断开，正在重连');
    };
    connection.onerror = () => {
      if (active()) retry(expected, revision, '无法建立实时连接，正在重试');
    };
  }
  function start() {
    if (enabled.value) return;
    enabled.value = true;
    stopWatching = watch(
      [() => auth.user?.id, () => auth.serverEpoch, () => auth.sessionRevision, () => auth.busy],
      () => {
        resetConnection();
        failures = 0;
        error.value = null;
        const revision = generation;
        // Identity operations update several refs synchronously. Close immediately,
        // then wait for those writes to settle before creating the next connection.
        queueMicrotask(() => {
          if (enabled.value && revision === generation && owner()) connect();
        });
      },
      { flush: 'sync' },
    );
    connect();
  }
  function stop() {
    enabled.value = false;
    stopWatching?.();
    stopWatching = undefined;
    resetConnection();
    failures = 0;
    error.value = null;
  }
  function reconnect() {
    if (!enabled.value) {
      start();
      return;
    }
    failures = 0;
    error.value = null;
    connect();
  }
  onScopeDispose(stop);
  return { enabled, status, error, ready, start, stop, reconnect };
});

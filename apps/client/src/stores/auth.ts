import type { AccountStateDto, AuthCredentials, AuthDto, StocksDto, UserDto } from '@stock/shared';
import { defineStore, storeToRefs } from 'pinia';
import { useAccountStore } from './account.js';
import { useMarketStore } from './market.js';
import { onScopeDispose, ref } from 'vue';
import { apiRequest, HttpError } from '../services/http.js';

export interface SessionIdentity {
  userId: string;
  serverEpoch: string;
  revision: number;
}

class IdentityChangedError extends Error {}
export const useAuthStore = defineStore('auth', () => {
  const user = ref<UserDto | null>(null);
  const accounts = useAccountStore();
  const marketState = useMarketStore();
  const { snapshot: account } = storeToRefs(accounts);
  const { quotes } = storeToRefs(marketState);
  const sessionRevision = ref(0);
  const serverEpoch = ref<string | null>(null);
  const initialized = ref(false);
  const busy = ref(false);
  const error = ref<string | null>(null);
  let generation = 0;
  let pendingRestore: Promise<void> | null = null;
  let pendingMutation: Promise<void> | null = null;
  let expiryTimer: ReturnType<typeof setTimeout> | undefined;

  /** Capture the session before an async request; a later login must not own its response. */
  function captureIdentity(): SessionIdentity | null {
    return user.value && serverEpoch.value
      ? { userId: user.value.id, serverEpoch: serverEpoch.value, revision: sessionRevision.value }
      : null;
  }
  function isCurrentIdentity(owner: SessionIdentity): boolean {
    return (
      user.value?.id === owner.userId &&
      serverEpoch.value === owner.serverEpoch &&
      sessionRevision.value === owner.revision
    );
  }
  function assertResponseIdentity(
    data: { serverEpoch: string; userId?: string },
    owner: SessionIdentity,
    privateData: boolean,
  ) {
    if (data.serverEpoch !== owner.serverEpoch || (privateData && data.userId !== owner.userId)) {
      invalidateSession('登录身份或服务状态已变化，请重新登录');
      throw new Error('登录身份或服务状态已变化，请重新登录');
    }
  }

  function clearPrivate() {
    clearTimeout(expiryTimer);
    user.value = null;
    accounts.reset();
    marketState.reset();
    sessionRevision.value++;
    serverEpoch.value = null;
  }
  function scheduleExpiry(expiresAt: string) {
    clearTimeout(expiryTimer);
    const remaining = Date.parse(expiresAt) - Date.now();
    if (!Number.isFinite(remaining)) throw new IdentityChangedError('登录信息无效，请重新登录');
    expiryTimer = setTimeout(
      () => {
        if (Date.parse(expiresAt) > Date.now()) {
          scheduleExpiry(expiresAt);
          return;
        }
        generation++;
        clearPrivate();
        error.value = '登录已过期，请重新登录';
      },
      Math.max(0, Math.min(remaining, 2_147_483_647)),
    );
  }

  async function loadPrivate(identity: AuthDto, revision: number) {
    if (revision !== generation) return;
    // Wait for both reads before releasing the session operation, including on failure.
    const [snapshotResult, marketResult] = await Promise.allSettled([
      apiRequest<AccountStateDto>('/api/me/snapshot'),
      apiRequest<StocksDto>('/api/stocks'),
    ]);
    if (revision !== generation) return;
    if (snapshotResult.status === 'rejected') throw snapshotResult.reason;
    if (marketResult.status === 'rejected') throw marketResult.reason;
    const snapshot = snapshotResult.value;
    const market = marketResult.value;
    // Do not combine a profile from one session with another user's assets or another process.
    if (
      snapshot.serverEpoch !== identity.serverEpoch ||
      market.serverEpoch !== identity.serverEpoch ||
      snapshot.userId !== identity.user.id
    ) {
      throw new IdentityChangedError('登录身份或服务状态已变化，请重新登录');
    }
    scheduleExpiry(identity.expiresAt);
    user.value = identity.user;
    accounts.applySnapshot(snapshot, {
      userId: identity.user.id,
      serverEpoch: identity.serverEpoch,
    });
    marketState.applySnapshot(market, identity.serverEpoch);
    serverEpoch.value = identity.serverEpoch;
    error.value = null;
  }

  function restoreSession(): Promise<void> {
    if (pendingMutation) return pendingMutation.catch(() => undefined);
    if (pendingRestore) return pendingRestore;
    const revision = ++generation;
    const task = (async () => {
      try {
        const identity = await apiRequest<AuthDto>('/api/auth/me');
        await loadPrivate(identity, revision);
      } catch (cause) {
        if (revision !== generation) return;
        if (
          (cause instanceof HttpError && cause.status === 401) ||
          cause instanceof IdentityChangedError
        ) {
          clearPrivate();
        }
        error.value =
          cause instanceof HttpError && cause.status === 401
            ? null
            : cause instanceof Error
              ? cause.message
              : '恢复登录失败，请重试';
      } finally {
        if (revision === generation) initialized.value = true;
      }
    })();
    const pending = task.finally(() => {
      if (pendingRestore === pending) pendingRestore = null;
    });
    pendingRestore = pending;
    return pending;
  }
  function ensureSession(): Promise<void> {
    return initialized.value ? Promise.resolve() : restoreSession();
  }

  // A stale response can still replace HttpOnly cookies even when its JS result is ignored.
  // Keep login, registration, logout and their snapshot loading mutually exclusive.
  function changeSession(operation: (revision: number) => Promise<void>): Promise<void> {
    if (pendingMutation) return Promise.reject(new Error('身份操作正在进行，请稍候再试'));
    const revision = ++generation;
    sessionRevision.value++;
    pendingRestore = null;
    busy.value = true;
    const pending = Promise.resolve()
      .then(() => operation(revision))
      .finally(() => {
        pendingMutation = null;
        busy.value = false;
        if (revision === generation) initialized.value = true;
      });
    pendingMutation = pending;
    return pending;
  }

  function authenticate(action: 'login' | 'register', credentials: AuthCredentials) {
    return changeSession(async (revision) => {
      error.value = null;
      let sessionCreated = false;
      try {
        const identity = await apiRequest<AuthDto>('/api/auth/' + action, {
          method: 'POST',
          body: credentials,
        });
        sessionCreated = true;
        await loadPrivate(identity, revision);
      } catch (cause) {
        if (revision === generation) {
          if (sessionCreated) clearPrivate();
          error.value = cause instanceof Error ? cause.message : '登录失败，请重试';
        }
        throw cause;
      }
    });
  }
  const login = (credentials: AuthCredentials) => authenticate('login', credentials);
  const register = (credentials: AuthCredentials) => authenticate('register', credentials);

  function logout() {
    return changeSession(async (revision) => {
      try {
        await apiRequest('/api/auth/logout', { method: 'POST' });
      } catch (cause) {
        if (!(cause instanceof HttpError && cause.status === 401)) {
          if (revision === generation)
            error.value = cause instanceof Error ? cause.message : '退出失败，请重试';
          throw cause;
        }
      }
      if (revision === generation) {
        clearPrivate();
        error.value = null;
      }
    });
  }
  function invalidateSession(message = '登录已失效，请重新登录') {
    generation++;
    pendingRestore = null;
    clearPrivate();
    initialized.value = true;
    error.value = message;
  }
  onScopeDispose(() => {
    generation++;
    clearTimeout(expiryTimer);
  });
  return {
    user,
    account,
    quotes,
    serverEpoch,
    initialized,
    sessionRevision,
    invalidateSession,
    captureIdentity,
    isCurrentIdentity,
    assertResponseIdentity,
    busy,
    error,
    restoreSession,
    ensureSession,
    login,
    register,
    logout,
  };
});

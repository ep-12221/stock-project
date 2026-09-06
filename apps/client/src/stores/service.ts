import { defineStore } from 'pinia';
import { ref } from 'vue';
import { getHealth } from '../services/http.js';

export const useServiceStore = defineStore('service', () => {
  const status = ref<'idle' | 'checking' | 'online' | 'offline'>('idle');
  const checkedAt = ref<string | null>(null);
  const error = ref<string | null>(null);

  async function refresh() {
    if (status.value === 'checking') return;
    status.value = 'checking';
    error.value = null;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5_000);
    try {
      const health = await getHealth(controller.signal);
      checkedAt.value = health.serverTime;
      status.value = 'online';
    } catch (cause) {
      status.value = 'offline';
      error.value = controller.signal.aborted
        ? '连接超时，请确认后端已启动后重试。'
        : cause instanceof Error
          ? cause.message
          : '无法连接后端，请稍后重试。';
    } finally {
      clearTimeout(timeout);
    }
  }

  return { status, checkedAt, error, refresh };
});

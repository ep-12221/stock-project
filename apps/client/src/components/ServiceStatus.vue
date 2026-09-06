<script setup lang="ts">
import { computed } from 'vue';
import { useRealtimeStore } from '../stores/realtime.js';
const realtime = useRealtimeStore();
const label = computed(() => {
  if (realtime.status === 'live') return '实时已连接';
  if (realtime.status === 'syncing') return '正在同步账户';
  if (realtime.status === 'connecting') return '正在连接实时行情';
  if (realtime.status === 'reconnecting') return '正在恢复实时连接';
  if (realtime.status === 'offline') return '实时连接已中断';
  return '等待实时连接';
});
const style = computed(() =>
  realtime.ready
    ? 'online'
    : ['offline', 'reconnecting'].includes(realtime.status)
      ? 'offline'
      : 'checking',
);
</script>
<template>
  <span
    class="service-status"
    :class="style"
    data-testid="realtime-status"
    role="status"
    aria-live="polite"
  >
    <span class="status-dot" aria-hidden="true"></span>{{ label }}
  </span>
</template>

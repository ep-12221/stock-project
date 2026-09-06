<script setup lang="ts">
import { onMounted, onUnmounted, watch } from 'vue';
import { RouterView, useRouter } from 'vue-router';
import { useAuthStore } from './stores/auth.js';
import { useRealtimeStore } from './stores/realtime.js';

const auth = useAuthStore();
const router = useRouter();
const realtime = useRealtimeStore();
onMounted(() => realtime.start());
onUnmounted(() => realtime.stop());
watch(
  () => auth.user,
  (user) => {
    if (auth.initialized && !user && router.currentRoute.value.meta.requiresAuth) {
      void router.replace('/login');
    }
  },
);
</script>

<template>
  <RouterView :key="$route.path" />
</template>

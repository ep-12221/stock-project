<script setup lang="ts">
import { computed, ref } from 'vue';
import { RouterLink, useRouter } from 'vue-router';
import { useAuthStore } from '../stores/auth.js';

const props = defineProps<{ mode: 'login' | 'register' }>();
const isRegister = computed(() => props.mode === 'register');
const auth = useAuthStore();
const router = useRouter();
const username = ref('');
const password = ref('');
const confirmPassword = ref('');
const submitting = ref(false);
const formBusy = computed(() => submitting.value || auth.busy);
const formError = ref<string | null>(null);

async function submit() {
  if (formBusy.value) return;
  formError.value = null;
  const normalized = username.value.trim().toLowerCase();
  if (!/^[a-z0-9_]{3,20}$/.test(normalized)) {
    formError.value = '用户名须为 3～20 位英文字母、数字或下划线';
    return;
  }
  if (password.value.length < 8 || password.value.length > 64) {
    formError.value = '密码须为 8～64 个字符';
    return;
  }
  if (isRegister.value && password.value !== confirmPassword.value) {
    formError.value = '两次输入的密码不一致';
    return;
  }
  submitting.value = true;
  try {
    await auth[props.mode]({ username: normalized, password: password.value });
    password.value = '';
    confirmPassword.value = '';
    await router.replace('/');
  } catch (cause) {
    formError.value = cause instanceof Error ? cause.message : '提交失败，请重试';
  } finally {
    submitting.value = false;
  }
}
</script>

<template>
  <main class="auth-page">
    <section class="auth-intro">
      <p class="eyebrow">STOCK LAB · 模拟交易</p>
      <h1>从第一笔<br />虚拟资产开始。</h1>
      <p>创建你的交易账户，获得 100 万虚拟币。<br />在自己的节奏里，认识市场与交易。</p>
      <span class="auth-note">仅用于学习与演示 · 服务重启后数据清空</span>
    </section>
    <section class="auth-card" :aria-labelledby="mode + '-title'">
      <p class="eyebrow">{{ isRegister ? '开启你的模拟账户' : '欢迎回来' }}</p>
      <h2 :id="mode + '-title'">{{ isRegister ? '注册账户' : '登录账户' }}</h2>
      <p class="auth-description">
        {{ isRegister ? '每个新账户拥有 1,000,000 虚拟币。' : '登录后查看你的资金与持仓。' }}
      </p>
      <form novalidate @submit.prevent="submit">
        <label for="username">用户名</label>
        <input
          id="username"
          v-model="username"
          name="username"
          autocomplete="username"
          maxlength="20"
          :disabled="formBusy"
          aria-describedby="username-hint"
        />
        <small id="username-hint">3～20 位英文字母、数字或下划线，不区分大小写</small>
        <label for="password">密码</label>
        <input
          id="password"
          v-model="password"
          name="password"
          type="password"
          :autocomplete="isRegister ? 'new-password' : 'current-password'"
          maxlength="64"
          :disabled="formBusy"
          aria-describedby="password-hint"
        />
        <small id="password-hint">8～64 个字符</small>
        <template v-if="isRegister">
          <label for="confirm-password">确认密码</label>
          <input
            id="confirm-password"
            v-model="confirmPassword"
            name="confirmPassword"
            type="password"
            autocomplete="new-password"
            maxlength="64"
            :disabled="formBusy"
          />
        </template>
        <p v-if="formError || auth.error" class="auth-error" role="alert">
          {{ formError || auth.error }}
        </p>
        <button type="submit" class="primary-link auth-submit" :disabled="formBusy">
          {{ formBusy ? '正在提交…' : isRegister ? '创建账户' : '登录' }}
          <span aria-hidden="true">↗</span>
        </button>
      </form>
      <p class="auth-switch">
        {{ isRegister ? '已有账户？' : '还没有账户？' }}
        <RouterLink v-if="!formBusy" :to="isRegister ? '/login' : '/register'">{{
          isRegister ? '去登录' : '立即注册'
        }}</RouterLink>
        <span v-else aria-disabled="true">{{ isRegister ? '去登录' : '立即注册' }}</span>
      </p>
    </section>
  </main>
</template>

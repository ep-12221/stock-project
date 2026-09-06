<script setup lang="ts">
import { RouterLink } from 'vue-router';
</script>

<template>
  <main class="not-found">
    <p class="eyebrow">404</p>
    <h1>这个页面还不存在</h1>
    <p>返回工作台，继续浏览股票预览。</p>
    <RouterLink class="primary-link" to="/">返回首页 <span aria-hidden="true">↗</span></RouterLink>
  </main>
</template>

import vue from '@vitejs/plugin-vue';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [vue()],
  test: {
    environment: 'node',
    include: [
      'apps/server/src/**/*.test.ts',
      'apps/client/src/**/*.test.ts',
      'packages/shared/src/**/*.test.ts',
    ],
    clearMocks: true,
    restoreMocks: true,
  },
});

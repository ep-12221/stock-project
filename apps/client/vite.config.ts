import { fileURLToPath } from 'node:url';
import vue from '@vitejs/plugin-vue';
import { defineConfig, loadEnv } from 'vite';

const projectRoot = fileURLToPath(new URL('../../', import.meta.url));

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, projectRoot, '');
  const target = 'http://127.0.0.1:' + (process.env.PORT ?? env.PORT ?? '3000');

  return {
    plugins: [vue()],
    envDir: projectRoot,
    server: {
      host: '0.0.0.0',
      port: 5173,
      strictPort: true,
      proxy: {
        '/api': { target },
        '/ws': { target, ws: true },
      },
    },
  };
});

import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';

// dev 代理到本地 backend（默认 3210 本地联调端口，可用 env 覆盖）
const target = process.env.VITE_PROXY_TARGET ?? 'http://127.0.0.1:3210';

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: { '@zc/shared': fileURLToPath(new URL('../../packages/shared/src/index.ts', import.meta.url)) },
  },
  server: {
    proxy: {
      '/api': { target, changeOrigin: true },
    },
  },
  build: {
    outDir: 'dist',
    sourcemap: false,
    // antd/react 等第三方拆独立 chunk：业务迭代时 vendor 命中缓存
    rollupOptions: {
      output: {
        manualChunks: {
          react: ['react', 'react-dom', 'react-router-dom'],
          antd: ['antd', '@ant-design/icons'],
        },
      },
    },
  },
});

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
    // react 运行时单独成块（几乎不变，长期命中缓存）。
    // antd 不再强制打成一个整包：交给 Rollup 按页面实际用到的组件分摊到各懒加载 chunk，
    // 登录页 / 学生端不再为管理端的 Table、Upload、DatePicker 等付下载与解析成本。
    rollupOptions: {
      output: {
        manualChunks: {
          react: ['react', 'react-dom', 'react-router-dom'],
        },
      },
    },
  },
});

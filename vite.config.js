import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const apiTarget = process.env.API_PROXY_TARGET ?? 'http://localhost:3000';

export default defineConfig({
  root: 'frontend',
  plugins: [react()],
  server: {
    host: '0.0.0.0',
    proxy: { '/api': { target: apiTarget, changeOrigin: true, rewrite: path => path.replace(/^\/api/, '') } },
  },
  build: { outDir: 'dist', emptyOutDir: true },
});

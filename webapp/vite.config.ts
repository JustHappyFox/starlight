import { defineConfig } from 'vite';
import preact from '@preact/preset-vite';

export default defineConfig({
  plugins: [preact()],
  server: {
    port: 5173,
    proxy: {
      '/api': 'http://localhost:3000',
      '/tonconnect-manifest.json': 'http://localhost:3000',
      '/icon.png': 'http://localhost:3000',
    },
  },
  build: { target: 'es2020', sourcemap: false },
});

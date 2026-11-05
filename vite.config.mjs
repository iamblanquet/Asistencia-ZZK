import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { VitePWA } from 'vite-plugin-pwa';
import { pwaOptions } from './pwa.config.mjs';

export default defineConfig({
  plugins: [react(), tailwindcss(), VitePWA(pwaOptions)],
  server: {
    port: 5175,
    strictPort: true,
    proxy: {
      '/api': 'http://127.0.0.1:5174',
    },
  },
});

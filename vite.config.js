import { defineConfig } from 'vite';

export default defineConfig({
  // relative base so the built site works from any static host path
  base: './',
  server: {
    port: 5173,
    // Multiplayer in dev: `npm run serve` starts the presence server on
    // 8080 and this proxies /ws, /api and /unlock to it. If it isn't
    // running, the client just retries quietly — single-player is unaffected.
    proxy: {
      '/ws': { target: 'ws://localhost:8080', ws: true },
      '/api': { target: 'http://localhost:8080' },
      '/unlock': { target: 'http://localhost:8080' },
    },
  },
});

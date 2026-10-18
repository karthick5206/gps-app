import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

// Overridable so several dev servers can run side by side (e.g. API_TARGET=http://localhost:4100 WEB_PORT=5174).
const API_TARGET = process.env.API_TARGET ?? 'http://localhost:4000';
const WEB_PORT = Number(process.env.WEB_PORT ?? 5173);

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
      // Compile the shared TS source directly; its dist is CommonJS.
      '@veetracer/shared': fileURLToPath(new URL('../../packages/shared/src/index.ts', import.meta.url)),
    },
  },
  server: {
    port: WEB_PORT,
    strictPort: true,
    proxy: {
      '/api': { target: API_TARGET, changeOrigin: true },
      '/socket.io': { target: API_TARGET, ws: true, changeOrigin: true },
    },
  },
  build: {
    // maplibre-gl alone is ~800 kB minified and is already isolated in the lazily loaded live-map chunk.
    chunkSizeWarningLimit: 1100,
  },
});

import { readFileSync } from 'node:fs';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { VitePWA } from 'vite-plugin-pwa';

// Cross-origin isolation unlocks SharedArrayBuffer, which wllama needs for
// multi-threaded inference. firebase.json sends the same headers in production.
const hosting = JSON.parse(readFileSync('firebase.json', 'utf8')).hosting;
const global: { key: string; value: string }[] = hosting.headers.find((h: { source: string }) => h.source === '**').headers;
const header = (key: string) => global.find((h) => h.key === key)!.value;
const isolation = {
  'Cross-Origin-Opener-Policy': header('Cross-Origin-Opener-Policy'),
  'Cross-Origin-Embedder-Policy': header('Cross-Origin-Embedder-Policy'),
  'Cross-Origin-Resource-Policy': header('Cross-Origin-Resource-Policy'),
};

export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['icon.svg', 'apple-touch-icon.png', 'fonts/*'],
      manifest: {
        name: 'TableSpace — 3D SQL Visualizer',
        short_name: 'TableSpace',
        description: 'Explore SQL schemas as a 3D space, with a local AI data architect that runs in your browser.',
        theme_color: '#070b14',
        background_color: '#070b14',
        display: 'standalone',
        orientation: 'any',
        start_url: '/',
        icons: [
          { src: 'icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: 'icon-512.png', sizes: '512x512', type: 'image/png' },
          { src: 'icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
      workbox: {
        // The app shell and fonts. wllama's wasm (tens of MB) is cached on first use
        // instead; model files live in wllama's own OPFS cache.
        globPatterns: ['**/*.{js,css,html,svg,png,woff,woff2}'],
        globIgnores: ['wllama/**'],
        maximumFileSizeToCacheInBytes: 6 * 1024 * 1024,
        navigateFallback: '/index.html',
        runtimeCaching: [
          {
            urlPattern: ({ url }) => url.pathname.startsWith('/wllama/'),
            handler: 'CacheFirst',
            options: { cacheName: 'wllama-wasm', expiration: { maxEntries: 6 } },
          },
        ],
      },
    }),
  ],
  clearScreen: false,
  server: { port: 5183, strictPort: true, headers: isolation },
  // preview serves the production build with the production CSP, so a violation shows up before deploy
  preview: { port: 5184, strictPort: true, headers: { ...isolation, 'Content-Security-Policy': header('Content-Security-Policy') } },
  optimizeDeps: { exclude: ['@wllama/wllama'] },
  build: { target: 'safari16', chunkSizeWarningLimit: 2500 },
});

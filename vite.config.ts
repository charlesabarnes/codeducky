import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'
import { VitePWA } from 'vite-plugin-pwa'
import { buildIdAt } from './shared/clientVersion.ts'
import { NAVIGATE_DENYLIST, SERVER_PREFIXES } from './shared/serverPaths.ts'

export default defineConfig({
  define: {
    __CODEDUCKY_BUILD__: JSON.stringify(buildIdAt(new Date())),
  },
  plugins: [
    react(),
    VitePWA({
      registerType: 'prompt',
      includeAssets: ['favicon.ico', 'favicon.svg', 'apple-touch-icon-180x180.png', 'codeducky.svg'],
      manifest: {
        id: '/',
        name: 'Code Ducky',
        short_name: 'Code Ducky',
        description: 'Review your own changes before you push them.',
        theme_color: '#fcf5e3',
        background_color: '#fcf5e3',
        display: 'standalone',
        start_url: '/',
        scope: '/',
        launch_handler: { client_mode: 'focus-existing' },
        handle_links: 'preferred',
        icons: [
          { src: 'pwa-192x192.png', sizes: '192x192', type: 'image/png' },
          { src: 'pwa-512x512.png', sizes: '512x512', type: 'image/png' },
          { src: 'maskable-icon-512x512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
      workbox: {
        globPatterns: ['**/*.{js,css,html,ico,png,svg,woff2}'],
        navigateFallback: 'index.html',
        // Server-rendered routes (API, MCP, OAuth consent) must reach the network; PR deep links stay in the app.
        navigateFallbackDenylist: NAVIGATE_DENYLIST,
      },
    }),
  ],
  server: {
    proxy: Object.fromEntries(
      SERVER_PREFIXES.map((path) => [path, `http://localhost:${process.env.CODEDUCKY_SERVER_PORT ?? 8787}`]),
    ),
  },
  build: {
    chunkSizeWarningLimit: 900,
  },
  worker: {
    format: 'es',
  },
})

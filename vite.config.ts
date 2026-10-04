import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'
import { VitePWA } from 'vite-plugin-pwa'
import { NAVIGATE_DENYLIST, SERVER_PREFIXES } from './shared/serverPaths.ts'

export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['favicon.ico', 'favicon.svg', 'apple-touch-icon-180x180.png', 'rubberduck.svg'],
      manifest: {
        name: 'Rubberduck',
        short_name: 'Rubberduck',
        description: 'Review your own changes before you push them.',
        theme_color: '#fcf5e3',
        background_color: '#fcf5e3',
        display: 'standalone',
        start_url: '/',
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
      SERVER_PREFIXES.map((path) => [path, `http://localhost:${process.env.RUBBERDUCK_SERVER_PORT ?? 8787}`]),
    ),
  },
  build: {
    chunkSizeWarningLimit: 900,
  },
  worker: {
    format: 'es',
  },
})

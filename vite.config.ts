import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'
import { VitePWA } from 'vite-plugin-pwa'

export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['favicon.ico', 'apple-touch-icon-180x180.png', 'icon.svg'],
      manifest: {
        name: 'Skelbert',
        short_name: 'Skelbert',
        description: 'Review your own changes before you push them.',
        theme_color: '#1f2430',
        background_color: '#1f2430',
        display: 'standalone',
        start_url: '/',
        icons: [
          { src: 'pwa-64x64.png', sizes: '64x64', type: 'image/png' },
          { src: 'pwa-192x192.png', sizes: '192x192', type: 'image/png' },
          { src: 'pwa-512x512.png', sizes: '512x512', type: 'image/png' },
          { src: 'maskable-icon-512x512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
      workbox: {
        globPatterns: ['**/*.{js,css,html,ico,png,svg,woff2}'],
        navigateFallback: 'index.html',
        // Server-rendered routes (API, MCP, OAuth consent) must reach the network.
        navigateFallbackDenylist: [/^\/api\//, /^\/mcp/, /^\/oauth/, /^\/\.well-known\//],
      },
    }),
  ],
  server: {
    proxy: { '/api': `http://localhost:${process.env.SKELBERT_SERVER_PORT ?? 8787}` },
  },
  build: {
    chunkSizeWarningLimit: 900,
  },
  worker: {
    format: 'es',
  },
})

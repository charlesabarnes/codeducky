import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'
import { VitePWA } from 'vite-plugin-pwa'
import { buildIdAt } from './shared/clientVersion.ts'
import { NAVIGATE_DENYLIST, SERVER_PREFIXES } from './shared/serverPaths.ts'

const SHORTCUT_ICONS = [{ src: 'pwa-192x192.png', sizes: '192x192', type: 'image/png' }]

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
        description:
          'Review your own branches like a pull request before you push them: line notes, checklists, an inbox of review requests, and Claude Code to fix what you find.',
        categories: ['developer', 'productivity', 'utilities'],
        theme_color: '#fcf5e3',
        background_color: '#fcf5e3',
        display: 'standalone',
        display_override: ['window-controls-overlay', 'standalone'],
        start_url: '/',
        scope: '/',
        launch_handler: { client_mode: 'focus-existing' },
        handle_links: 'preferred',
        // Opened files arrive through launchQueue (src/pwa/launchQueue.ts) and become patch sessions (PATCH_ACCEPT).
        file_handlers: [{ action: '/', accept: { 'text/x-diff': ['.diff'], 'text/x-patch': ['.patch'] } }],
        // GET, so a share is a plain navigation the SPA routes; /share is not a server path (shared/serverPaths.ts).
        share_target: { action: '/share', method: 'GET', params: { title: 'title', text: 'text', url: 'url' } },
        icons: [
          { src: 'pwa-192x192.png', sizes: '192x192', type: 'image/png' },
          { src: 'pwa-512x512.png', sizes: '512x512', type: 'image/png' },
          { src: 'maskable-icon-512x512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
        shortcuts: [
          { name: 'Inbox', short_name: 'Inbox', description: 'Pull requests waiting for your review', url: '/inbox', icons: SHORTCUT_ICONS },
          { name: 'Repos', short_name: 'Repos', description: 'Your repos and their review sessions', url: '/', icons: SHORTCUT_ICONS },
          { name: 'Last session', short_name: 'Last session', description: 'The review you opened last', url: '/last', icons: SHORTCUT_ICONS },
        ],
        screenshots: [
          { src: 'screenshots/wide-session.png', sizes: '1280x800', type: 'image/png', form_factor: 'wide', label: 'Reviewing a branch with line notes' },
          { src: 'screenshots/wide-inbox.png', sizes: '1280x800', type: 'image/png', form_factor: 'wide', label: 'The inbox of review requests' },
          { src: 'screenshots/narrow-inbox.png', sizes: '390x844', type: 'image/png', form_factor: 'narrow', label: 'The inbox on a phone' },
        ],
      },
      workbox: {
        globPatterns: ['**/*.{js,css,html,ico,png,svg,woff2}'],
        // Store screenshots are for the install dialog, not the offline app.
        globIgnores: ['screenshots/**'],
        // Opens the app on a click on a notification the service worker shows.
        importScripts: ['notification-click.js'],
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

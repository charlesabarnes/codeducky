// Imported by the generated service worker (vite.config.ts, workbox.importScripts). Notifications the
// service worker shows (where pages cannot construct them, as on Android) carry the app path to open:
// focus an open window and let it navigate (src/pwa/browserPresence.ts), or open a new one.
self.addEventListener('notificationclick', (event) => {
  event.notification.close()
  const path = event.notification.data && event.notification.data.path
  const target = typeof path === 'string' && path.startsWith('/') && !path.startsWith('//') ? path : '/'
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((windows) => {
      const open = windows.find((client) => new URL(client.url).origin === self.location.origin)
      if (!open) return self.clients.openWindow(target)
      return open.focus().then(() => open.postMessage({ type: 'codeducky:navigate', path: target }))
    }),
  )
})

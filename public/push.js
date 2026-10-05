// Imported by the generated service worker (vite.config.ts, workbox.importScripts). Shows Web Push messages
// from the Code Ducky server ({title, body, url, tag}) while the app is closed or in the background. A focused
// window already shows its own notification for the same event, so nothing is shown then; the tag matches
// the in-app one, so a background window's notification and the push replace each other instead of stacking.
// Safari may end a subscription after pushes that showed nothing; the PWA subscribes again when it next opens.
// Clicks are handled in notification-click.js.
function pushMessage(data) {
  try {
    const message = data ? data.json() : null
    return message && typeof message.title === 'string' ? message : null
  } catch {
    return null
  }
}

function appPath(url) {
  try {
    const target = new URL(url, self.location.origin)
    return target.origin === self.location.origin ? `${target.pathname}${target.search}${target.hash}` : '/'
  } catch {
    return '/'
  }
}

self.addEventListener('push', (event) => {
  const message = pushMessage(event.data)
  if (!message) return
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((windows) => {
      if (windows.some((client) => client.focused && new URL(client.url).origin === self.location.origin)) return
      return self.registration.showNotification(message.title, {
        body: typeof message.body === 'string' ? message.body : '',
        tag: typeof message.tag === 'string' ? message.tag : undefined,
        icon: '/pwa-192x192.png',
        data: { path: appPath(message.url) },
      })
    }),
  )
})

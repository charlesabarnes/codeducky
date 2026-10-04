import { registerSW } from 'virtual:pwa-register'
import { updates, type UpdateController } from './updates'

const CHECK_INTERVAL_MS = 60 * 60_000

/** Resolves once the registration's installing worker, if any, has finished installing or failed. */
function installed(registration: ServiceWorkerRegistration): Promise<void> {
  const worker = registration.installing
  if (!worker) return Promise.resolve()
  return new Promise((resolve) => {
    const settle = () => {
      if (worker.state === 'installing') return
      worker.removeEventListener('statechange', settle)
      resolve()
    }
    worker.addEventListener('statechange', settle)
  })
}

/** Registers the service worker in prompt mode: new versions wait until the banner, or a 426, activates them. */
export function startServiceWorker(controller: UpdateController = updates) {
  let registration: ServiceWorkerRegistration | undefined
  let reloading = false
  const reloadOnce = () => {
    if (reloading) return
    reloading = true
    window.location.reload()
  }

  const updateSW = registerSW({
    immediate: true,
    onNeedRefresh: () => controller.needRefresh(),
    onNeedReload: reloadOnce,
    onRegisteredSW: (_url, registered) => {
      registration = registered
      if (!registered) return
      setInterval(() => {
        if (navigator.onLine) registered.update().catch(() => undefined)
      }, CHECK_INTERVAL_MS)
    },
  })

  controller.attach({
    check: async () => {
      if (!registration) return false
      await registration.update()
      await installed(registration)
      return registration.waiting !== null
    },
    activate: async () => {
      navigator.serviceWorker?.addEventListener('controllerchange', reloadOnce)
      await updateSW(true)
    },
  })
}

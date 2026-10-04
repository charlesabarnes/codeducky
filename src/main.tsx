import '@fontsource/ibm-plex-mono/latin-400.css'
import '@fontsource/ibm-plex-mono/latin-600.css'
import '@fontsource/ibm-plex-mono/latin-700.css'
import '@fontsource/ibm-plex-sans/latin-400.css'
import '@fontsource/ibm-plex-sans/latin-400-italic.css'
import '@fontsource/ibm-plex-sans/latin-600.css'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { RouterProvider } from 'react-router'
import { router } from './app/router'
import { startAppearance } from './app/appearance'
import { db } from './db/db'
import { openLaunchedFiles } from './features/patch/openPatch'
import { startBrowserPresence } from './pwa/browserPresence'
import { startInstallPrompt } from './pwa/installPrompt'
import { handleLaunches } from './pwa/launchQueue'
import { startStoragePersistence } from './pwa/storage'
import { startWindowControls } from './pwa/windowControls'
import { syncController } from './sync/client'
import { startServiceWorker } from './update/serviceWorker'
import './styles.css'
import './palettes.css'

const navigate = (path: string) => void router.navigate(path)

startAppearance()
startWindowControls()
startInstallPrompt()
startServiceWorker()
startStoragePersistence(db)
handleLaunches({
  launchQueue: window.launchQueue,
  location: window.location,
  navigate,
  openServerPage: (url) => window.location.assign(url),
  openFiles: (files) =>
    void openLaunchedFiles(db, files).then(({ to, patchError }) => router.navigate(to, patchError ? { state: { patchError } } : undefined)),
})
startBrowserPresence(navigate)
void syncController.start()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <RouterProvider router={router} />
  </StrictMode>,
)

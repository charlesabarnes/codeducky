import '@fontsource/ibm-plex-mono/latin-400.css'
import '@fontsource/ibm-plex-mono/latin-600.css'
import '@fontsource/ibm-plex-mono/latin-700.css'
import '@fontsource/ibm-plex-sans/latin-400.css'
import '@fontsource/ibm-plex-sans/latin-400-italic.css'
import '@fontsource/ibm-plex-sans/latin-600.css'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { RouterProvider } from 'react-router'
import { registerSW } from 'virtual:pwa-register'
import { router } from './app/router'
import { startTheme } from './app/theme'
import { syncController } from './sync/client'
import './styles.css'

startTheme()
registerSW({ immediate: true })
void syncController.start()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <RouterProvider router={router} />
  </StrictMode>,
)

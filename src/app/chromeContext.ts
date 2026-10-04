import { createContext } from 'react'

/** Where pages render into the app shell: breadcrumbs in the header and the status bar at the bottom. */
export interface ChromeSlots {
  crumbs: HTMLElement | null
  status: HTMLElement | null
}

export const ChromeContext = createContext<ChromeSlots>({ crumbs: null, status: null })

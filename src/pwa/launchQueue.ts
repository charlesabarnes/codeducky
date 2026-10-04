import { isServerPath } from '../../shared/serverPaths'

interface LaunchDeps {
  launchQueue: LaunchQueue | undefined
  /** The app's origin and the URL it shows now. */
  location: Pick<Location, 'origin' | 'href'>
  /** Client-side navigation inside the app. */
  navigate: (path: string) => void
  /** Pages the server renders (OAuth consent, MCP) cannot load in the app's router. */
  openServerPage: (url: string) => void
}

/**
 * With `launch_handler: focus-existing` the browser focuses the open window and hands it the URL
 * that was launched (a session link from MCP, the channel or the gate) instead of navigating.
 */
export function handleLaunches({ launchQueue, location, navigate, openServerPage }: LaunchDeps): boolean {
  if (!launchQueue) return false
  launchQueue.setConsumer(({ targetURL }) => {
    if (!targetURL || targetURL === location.href) return
    let url: URL
    try {
      url = new URL(targetURL)
    } catch {
      return
    }
    if (url.origin !== location.origin) return
    if (isServerPath(url.pathname)) openServerPage(url.href)
    else navigate(`${url.pathname}${url.search}${url.hash}`)
  })
  return true
}

import { isServerPath } from '../../shared/serverPaths'

interface LaunchDeps {
  launchQueue: LaunchQueue | undefined
  /** The app's origin and the URL it shows now. */
  location: Pick<Location, 'origin' | 'href'>
  /** Client-side navigation inside the app. */
  navigate: (path: string) => void
  /** Pages the server renders (OAuth consent, MCP) cannot load in the app's router. */
  openServerPage: (url: string) => void
  /** Files opened with the app (a .diff or .patch, through file_handlers). */
  openFiles?: (files: readonly FileSystemHandle[]) => void
}

/**
 * With `launch_handler: focus-existing` the browser focuses the open window and hands it the URL
 * that was launched (a session link from MCP, the channel or the gate) instead of navigating.
 * A launch with files is a patch opened from the file manager; it goes to `openFiles` instead.
 */
export function handleLaunches({ launchQueue, location, navigate, openServerPage, openFiles }: LaunchDeps): boolean {
  if (!launchQueue) return false
  launchQueue.setConsumer(({ targetURL, files }) => {
    if (files?.length && openFiles) return openFiles(files)
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

export interface LocationLike {
  pathname: string
  search: string
}

/** Whether a navigation leaves the file being edited: another page, or another file of the session. */
export function leavesFile(path: string, current: LocationLike, next: LocationLike): boolean {
  return next.pathname !== current.pathname || new URLSearchParams(next.search).get('file') !== path
}

export const discardPrompt = (path: string) => `${path} has unsaved changes. Discard them?`

interface UnloadEvent {
  preventDefault(): void
  returnValue: unknown
}

/** For `beforeunload`: asks the browser to confirm closing or reloading while there are unsaved changes. */
export function guardUnload(event: UnloadEvent, dirty: boolean): boolean {
  if (!dirty) return false
  event.preventDefault()
  event.returnValue = ''
  return true
}

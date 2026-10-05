import { useEffect, useMemo, useRef, useSyncExternalStore } from 'react'
import { fileWindowPath } from '../../app/paths'
import { windowBus } from '../../pwa/windows'

const noSubscription = () => () => undefined

/** Tells the other windows which file of the session has unsaved edits here, until it is saved or this unmounts. */
export function usePublishDirty(sessionId: string, path: string | null): void {
  useEffect(() => {
    const bus = windowBus()
    if (!bus || path === null) return
    bus.setDirty([{ sessionId, path }])
    return () => bus.setDirty([])
  }, [sessionId, path])
}

/** Files of the session with unsaved edits in another window. */
export function useDirtyElsewhere(sessionId: string): ReadonlySet<string> {
  const bus = windowBus()
  const key = useSyncExternalStore(bus?.subscribe ?? noSubscription, () => bus?.dirtyElsewhere(sessionId) ?? '')
  return useMemo(() => new Set(key ? key.split('\n') : []), [key])
}

/** Follows a note picked in another window, when it is on this session's `path`. */
export function useNoteFocusFrom(sessionId: string, path: string | null, onFocus: (noteId: string) => void): void {
  const latest = useRef(onFocus)
  useEffect(() => {
    latest.current = onFocus
  })
  useEffect(() => {
    const bus = windowBus()
    if (!bus || path === null) return
    return bus.onNoteFocus((event) => {
      if (event.sessionId === sessionId && event.path === path) latest.current(event.noteId)
    })
  }, [sessionId, path])
}

export const shareNoteFocus = (sessionId: string, path: string, noteId: string) => windowBus()?.focusNote({ sessionId, path, noteId })

type Opener = (url: string, target: string) => Window | null

/**
 * Opens a session file in its own window: an app window in the installed app, a tab in the browser. The window is
 * named after the file, so opening the same file again brings that window back instead of a second one.
 */
export function openFileWindow(sessionId: string, path: string, open: Opener = (url, target) => window.open(url, target)): boolean {
  return open(fileWindowPath(sessionId, path), `codeducky-file:${sessionId}:${path}`) !== null
}

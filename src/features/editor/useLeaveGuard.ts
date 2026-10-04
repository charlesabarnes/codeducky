import { useCallback, useEffect } from 'react'
import { useBlocker, type BlockerFunction } from 'react-router'
import { discardPrompt, guardUnload, leavesFile } from '../../editor/leaveGuard'

/** While `path` has unsaved edits, confirms before another file or page replaces it, and before the tab closes. */
export function useLeaveGuard(path: string | null): void {
  const shouldBlock = useCallback<BlockerFunction>(
    ({ currentLocation, nextLocation }) => path !== null && leavesFile(path, currentLocation, nextLocation),
    [path],
  )
  const blocker = useBlocker(shouldBlock)

  useEffect(() => {
    if (blocker.state !== 'blocked') return
    if (path === null || window.confirm(discardPrompt(path))) blocker.proceed()
    else blocker.reset()
  }, [blocker, path])

  useEffect(() => {
    if (path === null) return
    const onBeforeUnload = (event: BeforeUnloadEvent) => guardUnload(event, true)
    window.addEventListener('beforeunload', onBeforeUnload)
    return () => window.removeEventListener('beforeunload', onBeforeUnload)
  }, [path])
}

import { useLiveQuery } from 'dexie-react-hooks'
import { useMemo } from 'react'
import { db } from '../../db/db'
import type { Session } from '../../db/schema'
import { parsePatchSet } from '../../review/patchSet'
import type { DiffSource } from '../session/source'
import { patchSource } from './patchSource'

/** The diff source of a patch session, from the patch file kept on this device: undefined while loading, null if it is gone. */
export function usePatchSource(session: Session): DiffSource | null | undefined {
  const sessionId = session.id!
  const stored = useLiveQuery(async () => (await db.patches.get(sessionId)) ?? null, [sessionId])
  const loaded = stored !== undefined
  const text = stored?.text ?? null
  const head = session.headSha
  return useMemo(() => {
    if (!loaded) return undefined
    return text === null ? null : patchSource(sessionId, parsePatchSet(text), head)
  }, [loaded, text, sessionId, head])
}

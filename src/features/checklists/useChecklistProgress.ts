import { useLiveQuery } from 'dexie-react-hooks'
import { applicableChecklists, checkedItems } from '../../db/checklists'
import { db } from '../../db/db'

export function useChecklistProgress(sessionId: string, repoId: string) {
  return useLiveQuery(async () => {
    const [lists, checked] = await Promise.all([applicableChecklists(db, repoId), checkedItems(db, sessionId)])
    return { lists, checked }
  }, [sessionId, repoId])
}

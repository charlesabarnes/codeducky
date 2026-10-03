import type { SkelbertDb } from './db'
import type { FileView } from './schema'

export async function setViewed(db: SkelbertDb, view: FileView): Promise<void> {
  await db.fileViews.put(view)
}

export function sessionViews(db: SkelbertDb, sessionId: string): Promise<FileView[]> {
  return db.fileViews.where({ sessionId }).toArray()
}

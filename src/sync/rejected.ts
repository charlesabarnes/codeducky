import type { SyncKind } from '../../shared/sync'
import type { SkelbertDb } from '../db/db'
import { META_CURSOR, setMeta } from './meta'
import { remoteTransaction } from './engine'
import { RECORD_SPECS } from './records'
import type { RejectedEntry } from './types'

export interface RejectedItem extends RejectedEntry {
  label: string
}

const KIND_LABEL: Record<SyncKind, string> = {
  repos: 'Repo',
  sessions: 'Session',
  notes: 'Note',
  checklists: 'Checklist',
  checklistState: 'Checklist tick',
  fileViews: 'Viewed file',
}

function describe(kind: SyncKind, row: Record<string, unknown> | undefined): string {
  const label = KIND_LABEL[kind]
  const name = row?.title ?? row?.name ?? row?.path ?? row?.branch
  return typeof name === 'string' && name ? `${label} · ${name}` : label
}

const rowFor = (db: SkelbertDb, entry: RejectedEntry) => {
  const key = RECORD_SPECS[entry.kind].keyOf(entry.id)
  return key === null ? undefined : db.table(entry.kind).get(key)
}

export async function listRejected(db: SkelbertDb): Promise<RejectedItem[]> {
  const entries = await db.rejected.orderBy('at').toArray()
  return Promise.all(entries.map(async (entry) => ({ ...entry, label: describe(entry.kind, await rowFor(db, entry)) })))
}

/** Puts a rejected change back in the outbox with the record as it is now. */
export async function retryRejected(db: SkelbertDb, key: string): Promise<void> {
  await remoteTransaction(db, async () => {
    const entry = await db.rejected.get(key)
    if (!entry) return
    await db.rejected.delete(key)
    if (await db.outbox.get(key)) return
    await db.outbox.put({ key: entry.key, kind: entry.kind, id: entry.id, changedAt: entry.changedAt, deleted: entry.deleted })
  })
}

/** Drops this device's version of a rejected record; the next sync pulls the server's copy, if any, again. */
export async function discardRejected(db: SkelbertDb, key: string): Promise<void> {
  await remoteTransaction(db, async () => {
    const entry = await db.rejected.get(key)
    if (!entry) return
    await db.rejected.delete(key)
    if (await db.outbox.get(key)) return
    const recordKey = RECORD_SPECS[entry.kind].keyOf(entry.id)
    if (recordKey !== null) await db.table(entry.kind).delete(recordKey)
    await setMeta(db, META_CURSOR, 0)
  })
}


import { Dexie } from 'dexie'
import { SYNC_KINDS, wins, type ServerChange, type SyncRequest, type SyncResponse, type WireChange } from '../../shared/sync'
import type { RubberduckDb } from '../db/db'
import { META_CURSOR, META_LAST_SYNCED_AT, getMeta, setMeta } from './meta'
import { markRemote } from './middleware'
import { RECORD_SPECS, fromWire, toWire } from './records'
import { outboxKey, type OutboxEntry } from './types'

export type SyncSend = (request: SyncRequest) => Promise<SyncResponse>

export interface SyncResult {
  pushed: number
  rejected: number
  pulled: number
  cursor: number
  syncedAt: number
}

const BATCH = 200
const MAX_ROUNDS = 1000

const syncTables = (db: RubberduckDb) => [...SYNC_KINDS.map((kind) => db.table(kind)), db.outbox, db.rejected, db.syncMeta]

/**
 * Runs `fn` in a transaction whose writes are pulled changes: no clock stamping, no outbox entries.
 *
 * Dexie keeps native `await`s inside the transaction only while each awaited promise comes from a
 * Dexie operation; awaiting anything else (an async helper that returns before touching the
 * database, `await undefined`) silently drops the transaction. Helpers called from `fn` therefore
 * start with a database read.
 */
export function remoteTransaction<T>(db: RubberduckDb, fn: () => Promise<T>): Promise<T> {
  return db.transaction('rw', syncTables(db), () => {
    markRemote(Dexie.currentTransaction.idbtrans)
    return fn()
  })
}

/**
 * One full sync: pushes the outbox in batches and pulls every change since the stored cursor,
 * looping while the server reports `more` or the outbox still has unsent entries.
 */
export async function runSync(db: RubberduckDb, send: SyncSend): Promise<SyncResult> {
  let cursor = (await getMeta<number>(db, META_CURSOR)) ?? 0
  let pushed = 0
  let rejected = 0
  let pulled = 0
  const sent = new Set<string>()

  for (let round = 0; round < MAX_ROUNDS; round++) {
    const entries = (await db.outbox.orderBy('changedAt').toArray()).filter((e) => !sent.has(e.key)).slice(0, BATCH)
    const changes = await readChanges(db, entries)
    entries.forEach((e) => sent.add(e.key))

    const reply = await send({ cursor, changes })
    const refused = new Map(reply.rejected.map((r) => [`${r.kind}:${r.id}`, r.error]))
    await remoteTransaction(db, async () => {
      await settlePushed(db, entries, refused)
      for (const change of reply.changes) await applyRemote(db, change)
      await setMeta(db, META_CURSOR, reply.newCursor)
    })

    pushed += changes.length
    rejected += refused.size
    pulled += reply.changes.length
    cursor = reply.newCursor

    const unsent = await db.outbox.filter((e) => !sent.has(e.key)).count()
    if (!reply.more && unsent === 0) break
  }

  const syncedAt = Date.now()
  await setMeta(db, META_LAST_SYNCED_AT, syncedAt)
  return { pushed, rejected, pulled, cursor, syncedAt }
}

async function readChanges(db: RubberduckDb, entries: OutboxEntry[]): Promise<WireChange[]> {
  const changes: WireChange[] = []
  for (const entry of entries) {
    const { kind, id } = entry
    const key = RECORD_SPECS[kind].keyOf(id)
    const row = entry.deleted || key === null ? undefined : await db.table(kind).get(key)
    if (row) changes.push(toWire(kind, row))
    else changes.push({ kind, id, changedAt: entry.changedAt, deleted: true })
  }
  return changes
}

/**
 * Settles outbox entries that were not written again while the request was in flight:
 * accepted ones are dropped, refused ones move to `rejected` so they stop blocking the queue.
 */
async function settlePushed(db: RubberduckDb, entries: OutboxEntry[], refused: Map<string, string>): Promise<void> {
  const at = Date.now()
  const current = await db.outbox.bulkGet(entries.map((entry) => entry.key))
  const settled = entries.filter((entry, index) => {
    const now = current[index]
    return now !== undefined && now.changedAt === entry.changedAt && now.deleted === entry.deleted
  })
  await db.outbox.bulkDelete(settled.map((entry) => entry.key))
  await db.rejected.bulkDelete(settled.filter((entry) => !refused.has(entry.key)).map((entry) => entry.key))
  await db.rejected.bulkPut(
    settled.filter((entry) => refused.has(entry.key)).map((entry) => ({ ...entry, error: refused.get(entry.key)!, at })),
  )
}

/** Applies one pulled change if it beats this device's version, including an unsent local delete. */
export async function applyRemote(db: RubberduckDb, change: ServerChange | WireChange): Promise<boolean> {
  const okey = outboxKey(change.kind, change.id)
  const pending = await db.outbox.get(okey)
  const key = RECORD_SPECS[change.kind].keyOf(change.id)
  if (key === null) return false
  const table = db.table(change.kind)
  const local = await table.get(key)

  const mine = local
    ? { changedAt: (local.changedAt as number | undefined) ?? 0, deleted: false }
    : pending?.deleted
      ? { changedAt: pending.changedAt, deleted: true }
      : null
  if (!wins(change, mine)) return false

  if (change.deleted) await table.delete(key)
  else await table.put(fromWire(change))
  if (pending && pending.changedAt <= change.changedAt) await db.outbox.delete(okey)
  const refused = await db.rejected.get(okey)
  if (refused && refused.changedAt <= change.changedAt) await db.rejected.delete(okey)
  return true
}

/** Queues every synced record, so a first sign-in uploads what this device already has. */
export async function enqueueAll(db: RubberduckDb): Promise<number> {
  let count = 0
  await db.transaction('rw', [...SYNC_KINDS.map((kind) => db.table(kind)), db.outbox], async () => {
    for (const kind of SYNC_KINDS) {
      const rows = await db.table(kind).toArray()
      const entries = rows.map((row) => {
        const { id, changedAt } = toWire(kind, row)
        return { key: outboxKey(kind, id), kind, id, changedAt, deleted: false }
      })
      const pending = new Set((await db.outbox.bulkGet(entries.map((e) => e.key))).filter(Boolean).map((e) => e!.key))
      const fresh = entries.filter((e) => !pending.has(e.key))
      await db.outbox.bulkPut(fresh)
      count += fresh.length
    }
  })
  return count
}

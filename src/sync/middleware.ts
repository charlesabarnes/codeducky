import type { DBCore, DBCoreMutateRequest, DBCoreMutateResponse, DBCoreTable, DBCoreTransaction, Middleware } from 'dexie'
import type { SyncKind } from '../../shared/sync'
import { uuidv7 } from './ids'
import { HAS_GENERATED_ID, isLocalOnly, isSyncedTable, RECORD_SPECS } from './records'
import { outboxKey, type OutboxEntry } from './types'

export const OUTBOX = 'outbox'

/** Transactions that apply pulled changes: their writes keep the remote clock and skip the outbox. */
const remoteTransactions = new WeakSet<object>()

export function markRemote(trans: unknown): void {
  if (trans && typeof trans === 'object') remoteTransactions.add(trans)
}

/** A record's own writes stay strictly ordered even if the clock stalls or steps back. */
export const nextStamp = (previous: number | undefined) => Math.max(Date.now(), (previous ?? 0) + 1)

type Row = Record<string, unknown>

function stampValues(kind: SyncKind, req: Extract<DBCoreMutateRequest, { type: 'add' | 'put' }>): void {
  for (const value of req.values as Row[]) {
    if (HAS_GENERATED_ID.has(kind) && (value.id === undefined || value.id === null)) value.id = uuidv7()
    value.changedAt = nextStamp(value.changedAt as number | undefined)
  }
  if (req.type === 'put') {
    const stamp = { changedAt: Date.now() }
    if (req.changeSpec) Object.assign(req.changeSpec, stamp)
    req.updates?.changeSpecs.forEach((spec) => Object.assign(spec, stamp))
  }
}

function syncedTable(kind: SyncKind, table: DBCoreTable, outbox: () => DBCoreTable): DBCoreTable {
  const spec = RECORD_SPECS[kind]
  const enqueue = (trans: DBCoreTransaction, entries: OutboxEntry[]) =>
    entries.length ? outbox().mutate({ trans, type: 'put', values: entries }) : undefined

  const mutate = async (req: DBCoreMutateRequest): Promise<DBCoreMutateResponse> => {
    const trans = req.trans as DBCoreTransaction & { mode?: IDBTransactionMode }
    if (trans.mode === 'versionchange' || remoteTransactions.has(trans)) return table.mutate(req)

    switch (req.type) {
      case 'add':
      case 'put': {
        stampValues(kind, req)
        const res = await table.mutate(req)
        const entries = (req.values as Row[])
          .filter((value, index) => !res.failures[index] && !isLocalOnly(kind, value))
          .map((value) => {
            const id = spec.idOf(value)
            return { key: outboxKey(kind, id), kind, id, changedAt: value.changedAt as number, deleted: false }
          })
        await enqueue(trans, entries)
        return res
      }
      case 'delete': {
        const previous = (await table.getMany({ trans, keys: req.keys })) as (Row | undefined)[]
        const res = await table.mutate(req)
        const entries = req.keys.flatMap((key, index) => {
          const before = previous[index]
          if (!before || res.failures[index] || isLocalOnly(kind, before)) return []
          const id = spec.idOfKey(key)
          const changedAt = nextStamp(before.changedAt as number | undefined)
          return [{ key: outboxKey(kind, id), kind, id, changedAt, deleted: true }]
        })
        await enqueue(trans, entries)
        return res
      }
      case 'deleteRange': {
        const { result: keys } = await table.query({
          trans,
          values: false,
          query: { index: table.schema.primaryKey, range: req.range },
        })
        return mutate({ type: 'delete', trans, keys })
      }
    }
  }

  return { ...table, mutate }
}

/**
 * Records every local write to a synced table in the outbox, in the same transaction, and
 * stamps its last-write-wins clock. Deletes become outbox tombstones. Readwrite transactions
 * that touch a synced table are widened to include the outbox.
 */
export const syncMiddleware: Middleware<DBCore> = {
  stack: 'dbcore',
  name: 'CodeDuckySync',
  create: (down) => ({
    ...down,
    transaction: (stores, mode, options) => {
      const widen = mode === 'readwrite' && stores.some(isSyncedTable) && !stores.includes(OUTBOX)
      return down.transaction(widen ? [...stores, OUTBOX] : stores, mode, options)
    },
    table: (name) => {
      const table = down.table(name)
      return isSyncedTable(name) ? syncedTable(name, table, () => down.table(OUTBOX)) : table
    },
  }),
}

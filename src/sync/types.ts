import type { SyncKind } from '../../shared/sync'

/** A local write not yet accepted by the server; one entry per record, the latest write wins. */
export interface OutboxEntry {
  key: string
  kind: SyncKind
  id: string
  changedAt: number
  deleted: boolean
}

/** An outbox entry the server refused; kept out of the retry loop until retried or discarded. */
export interface RejectedEntry extends OutboxEntry {
  error: string
  at: number
}

export interface MetaEntry {
  key: string
  value: unknown
}

export const outboxKey = (kind: SyncKind, id: string) => `${kind}:${id}`

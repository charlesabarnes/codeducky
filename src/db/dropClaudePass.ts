import type { Transaction } from 'dexie'
import { nextStamp } from '../sync/middleware'
import { outboxKey, type OutboxEntry } from '../sync/types'

type Row = Record<string, unknown>

/**
 * v5: the in-app Claude pass is gone. Settings lose the Anthropic key and model, and repo
 * instructions move from `claudeInstructions` to `instructions`. Upgrade writes bypass the sync
 * middleware, so renamed repos are queued here to reach the server.
 */
export async function dropClaudePass(tx: Transaction): Promise<void> {
  await tx
    .table<Row>('settings')
    .toCollection()
    .modify((settings) => {
      delete settings.anthropicKey
      delete settings.claudeModel
    })

  const queued: OutboxEntry[] = []
  await tx
    .table<Row>('repos')
    .toCollection()
    .modify((repo) => {
      if (!('claudeInstructions' in repo)) return
      const legacy = repo.claudeInstructions
      delete repo.claudeInstructions
      if (typeof legacy !== 'string' || legacy.trim() === '' || typeof repo.instructions === 'string') return
      repo.instructions = legacy.trim()
      repo.changedAt = nextStamp(repo.changedAt as number | undefined)
      const id = repo.id as string
      queued.push({ key: outboxKey('repos', id), kind: 'repos', id, changedAt: repo.changedAt as number, deleted: false })
    })
  if (queued.length) await tx.table<OutboxEntry>('outbox').bulkPut(queued)
}

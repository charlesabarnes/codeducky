import { pairId, type WireChange } from '../shared/sync'

/** Synced records for server tests: one repo, a branch with a session, notes and checklists. */

export const REPO_ID = 'gh:charlesabarnes/invoice-service'
export const REPO = 'charlesabarnes/invoice-service'

export const record = (kind: WireChange['kind'], id: string, data: Record<string, unknown>, changedAt = 100): WireChange => ({
  kind,
  id,
  changedAt,
  deleted: false,
  data,
})

export const anchor = (line: number, text: string) => ({ line, side: 'new', text, before: ['a', 'b'], after: ['c'] })

export const note = (id: string, sessionId: string, extra: Record<string, unknown> = {}) =>
  record('notes', id, {
    sessionId,
    path: 'src/invoice.ts',
    anchor: anchor(12, 'const total = sum(items)'),
    body: `Body of ${id}`,
    severity: 'issue',
    status: 'open',
    source: 'me',
    createdAt: 1,
    updatedAt: 1,
    ...extra,
  })

export const repo = (extra: Record<string, unknown> = {}) =>
  record('repos', REPO_ID, { owner: 'charlesabarnes', name: 'invoice-service', folderName: 'invoice-service', baseBranch: 'main', lastOpenedAt: 5, checklistIds: [], ...extra })

export const session = (id: string, branch: string, extra: Record<string, unknown> = {}) =>
  record('sessions', id, { repoId: REPO_ID, branch, headSha: 'h', baseSha: 'b', baseSource: 'local', startedAt: 2, status: 'active', ...extra })

export const checklist = (id: string, title: string, items: [string, string][], extra: Record<string, unknown> = {}) =>
  record('checklists', id, { scope: 'global', title, items: items.map(([itemId, text]) => ({ id: itemId, text })), ...extra })

export const ticked = (sessionId: string, itemId: string, checked = true) =>
  record('checklistState', pairId(sessionId, itemId), { sessionId, itemId, checked })

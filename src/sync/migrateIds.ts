import type { Transaction } from 'dexie'
import { repoIdFor, uuidv7 } from './ids'

type Row = Record<string, unknown>

const STAGED = [
  ['repos', 'stagingRepos'],
  ['sessions', 'stagingSessions'],
  ['notes', 'stagingNotes'],
  ['checklists', 'stagingChecklists'],
] as const

function withoutHandle(repo: Row): Row {
  const copy = { ...repo }
  delete copy.dirHandle
  return copy
}

/** A reference to a row that no longer exists keeps a recognisable string id. */
const remap = (ids: Map<unknown, string>, old: unknown) => ids.get(old) ?? `legacy-${String(old)}`

/**
 * v3: gives every repo, session, note and checklist a global string id, rewrites the references
 * between them (repoId, sessionId, scope, checklistIds, carriedFrom), moves folder handles into
 * the device-local `repoHandles` table, and stages the rows for v4.
 */
export async function migrateToStringIds(tx: Transaction): Promise<void> {
  const now = Date.now()
  const [repos, sessions, notes, checklists, fileViews, checklistState] = await Promise.all(
    ['repos', 'sessions', 'notes', 'checklists', 'fileViews', 'checklistState'].map((name) =>
      tx.table<Row>(name).toArray(),
    ),
  )

  // The most recently opened checkout keeps the owner/name id if two folders share a remote.
  repos!.sort((a, b) => ((b.lastOpenedAt as number) ?? 0) - ((a.lastOpenedAt as number) ?? 0))
  const repoIds = new Map<unknown, string>()
  for (const repo of repos!) {
    const derived = repoIdFor((repo.owner as string) ?? '', (repo.name as string) ?? '')
    const taken = derived !== null && [...repoIds.values()].includes(derived)
    repoIds.set(repo.id, derived && !taken ? derived : uuidv7(now))
  }
  const sessionIds = new Map(sessions!.map((row) => [row.id, uuidv7(now)]))
  const noteIds = new Map(notes!.map((row) => [row.id, uuidv7(now)]))
  const checklistIds = new Map(checklists!.map((row) => [row.id, uuidv7(now)]))

  const handles = repos!
    .filter((repo) => repo.dirHandle)
    .map((repo) => ({ repoId: repoIds.get(repo.id)!, dirHandle: repo.dirHandle }))

  const stagedRepos = repos!.map((repo) => ({
    ...withoutHandle(repo),
    id: repoIds.get(repo.id)!,
    checklistIds: ((repo.checklistIds as unknown[]) ?? []).flatMap((id) => (checklistIds.has(id) ? [checklistIds.get(id)!] : [])),
    changedAt: now,
  }))
  const stagedSessions = sessions!.map((session) => ({
    ...session,
    id: sessionIds.get(session.id)!,
    repoId: remap(repoIds, session.repoId),
    changedAt: now,
  }))
  const stagedNotes = notes!.map((note) => {
    const staged: Row = { ...note, id: noteIds.get(note.id)!, sessionId: remap(sessionIds, note.sessionId), changedAt: now }
    if (note.carriedFrom !== undefined && note.carriedFrom !== null) staged.carriedFrom = remap(noteIds, note.carriedFrom)
    return staged
  })
  const stagedChecklists = checklists!.map((list) => ({
    ...list,
    id: checklistIds.get(list.id)!,
    scope: list.scope === 'global' ? 'global' : remap(repoIds, list.scope),
    changedAt: now,
  }))

  await Promise.all([
    tx.table('stagingRepos').bulkAdd(stagedRepos),
    tx.table('stagingSessions').bulkAdd(stagedSessions),
    tx.table('stagingNotes').bulkAdd(stagedNotes),
    tx.table('stagingChecklists').bulkAdd(stagedChecklists),
    tx.table('repoHandles').bulkAdd(handles),
  ])

  // fileViews and checklistState keep their compound keys; sessionId is part of the key, so they are rewritten whole.
  const rekey = async (name: string, rows: Row[]) => {
    await tx.table(name).clear()
    await tx.table(name).bulkAdd(
      rows.map((row) => ({ ...row, sessionId: remap(sessionIds, row.sessionId), changedAt: now })),
    )
  }
  await rekey('fileViews', fileViews!)
  await rekey('checklistState', checklistState!)
}

/** v4: copies the staged rows into the recreated tables. */
export async function restoreFromStaging(tx: Transaction): Promise<void> {
  for (const [table, staging] of STAGED) {
    await tx.table(table).bulkAdd(await tx.table(staging).toArray())
  }
}

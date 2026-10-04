import 'fake-indexeddb/auto'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { RubberduckDb } from '../../src/db/db'
import { loadLastLooks, markViewed, recordReviewHead } from '../../src/db/fileViews'
import { addNote } from '../../src/db/notes'
import { MAX_SNAPSHOT_FILE_BYTES, putSnapshot, readSnapshot, snapshotOids } from '../../src/db/reviewSnapshots'
import { startOrResumeSession } from '../../src/db/sessions'
import { sinceSource } from '../../src/features/modes/modeSources'
import type { DiffSource } from '../../src/features/session/source'
import { buildLines, countChanges } from '../../src/diff/hunks'
import { createGitService } from '../../src/git/service'
import type { FileChange, FileSide } from '../../src/git/types'
import { rangeEnds } from '../../src/review/commitRange'
import { ABSENT, classifySince, countSince } from '../../src/review/lastLook'
import { sideLines } from '../../src/review/lines'
import { anchorForView, placeNotes } from '../../src/review/viewNotes'
import { nodeDirectoryHandle } from '../support/nodeHandle'

const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trimEnd()
const text = (side: FileSide | null) => (side?.kind === 'text' ? side.text : '')
const lines = (...items: string[]) => items.map((item) => `${item}\n`).join('')

describe('since last look and commit-by-commit on a real repository', () => {
  let repo = ''
  const service = createGitService()
  const db = new RubberduckDb('since-integration')
  let baseSha = ''

  const write = (path: string, content: string) => writeFileSync(join(repo, path), content)
  const read = (path: string) => readFileSync(join(repo, path), 'utf8')
  const commit = (message: string, ...paths: string[]) => {
    git(repo, 'add', ...(paths.length ? paths : ['-A']))
    git(repo, 'commit', '--quiet', '-m', message)
    return git(repo, 'rev-parse', 'HEAD')
  }
  // The session's own source, as localSource builds it (minus the worker).
  const branchSource = (): DiffSource => ({
    key: `local:${baseSha}`,
    listFiles: async () => ({ files: (await service.detectRenames(await service.changes(baseSha))).changes, renamesLimited: false }),
    analyze: (files) => service.analyze(files),
    contents: (change, maxBytes) => service.contents(change, maxBytes),
    ciHead: async () => (await service.info()).headSha,
    dirtyPaths: async () => new Set(),
  })
  const loadReviewed = async (oid: string) => {
    const bytes = (await service.blobOrNull(oid)) ?? (await readSnapshot(db, oid))
    if (!bytes) throw new Error('not on this device')
    return bytes
  }
  /** What the PWA does when a file is marked viewed (recordViewed), with this test's service and database. */
  const view = async (sessionId: string, change: FileChange) => {
    await markViewed(db, { sessionId, change, viewed: true })
    const snapshot = await service.reviewSnapshot(change.path, change.newOid ?? '', MAX_SNAPSHOT_FILE_BYTES)
    if (snapshot.bytes && change.newOid) await putSnapshot(db, change.newOid, snapshot.bytes)
    await recordReviewHead(db, sessionId, change.path, snapshot.head)
    return snapshot
  }

  beforeAll(async () => {
    repo = mkdtempSync(join(tmpdir(), 'rubberduck-since-'))
    git(repo, 'init', '--quiet', '-b', 'main')
    git(repo, 'config', 'user.email', 'test@example.com')
    git(repo, 'config', 'user.name', 'Test')
    git(repo, 'remote', 'add', 'origin', 'git@github.com:me/shop.git')
    mkdirSync(join(repo, 'src'))
    write('src/cart.ts', lines('export function total(items) {', '  let sum = 0', '  for (const item of items) sum += item.price', '  return sum', '}'))
    write('src/tax.ts', lines('export const RATE = 0.2'))
    write('README.md', lines('# Shop'))
    baseSha = commit('base')
    git(repo, 'update-ref', 'refs/remotes/origin/main', 'HEAD')
    git(repo, 'checkout', '--quiet', '-b', 'feature/quantity')
    await service.open(nodeDirectoryHandle(repo))
  })

  afterAll(async () => {
    await db.delete()
    if (repo) rmSync(repo, { recursive: true, force: true })
  })

  it('shows only what changed after the review, from git objects and from a local snapshot', async () => {
    write('src/cart.ts', read('src/cart.ts').replace('sum += item.price', 'sum += item.price * item.quantity'))
    write('src/tax.ts', lines('export const RATE = 0.2', 'export const REDUCED = 0.05'))
    const reviewedHead = commit('Multiply by quantity')
    // Uncommitted at review time: only a snapshot can bring this version back.
    write('src/discount.ts', lines('export function discount(total) {', '  return total', '}'))

    const sessionId = await startOrResumeSession(db, { repoId: 'r1', branch: 'feature/quantity', headSha: reviewedHead, baseSha })
    const first = await branchSource().listFiles()
    expect(first.files.map((file) => file.path)).toEqual(['src/cart.ts', 'src/discount.ts', 'src/tax.ts'])
    const reviewedDiscount = read('src/discount.ts')
    for (const file of first.files) {
      const snapshot = await view(sessionId, file)
      expect(snapshot.head).toBe(reviewedHead)
      // Committed content is a git object already; only the uncommitted file is snapshotted.
      expect(snapshot.bytes !== null).toBe(file.path === 'src/discount.ts')
    }
    expect(await db.reviewSnapshots.count()).toBe(1)
    const note = await addNote(db, {
      sessionId,
      path: 'src/cart.ts',
      anchor: { line: 3, side: 'new', text: '  for (const item of items) sum += item.price * item.quantity', before: [], after: [] },
      body: 'quantity can be undefined',
      severity: 'issue',
    })

    // More work after the review: a commit, then uncommitted edits.
    write('src/cart.ts', lines('// Cart totals', ...read('src/cart.ts').trimEnd().split('\n')))
    const secondHead = commit('Document cart totals', 'src/cart.ts')
    write('src/discount.ts', reviewedDiscount.replace('  return total', '  return Math.max(0, total - 5)'))
    write('src/shipping.ts', lines('export const FREE_OVER = 50'))

    // Resume: the head moved by one commit since the last review.
    const resumed = await startOrResumeSession(db, { repoId: 'r1', branch: 'feature/quantity', headSha: secondHead, baseSha })
    expect(resumed).toBe(sessionId)
    const data = await loadLastLooks(db, await db.sessions.toArray())
    expect(data.review?.headSha).toBe(reviewedHead)
    expect(await service.headMoveSince(reviewedHead)).toEqual({ head: secondHead, commits: 1, rewritten: false })

    const source = branchSource()
    const { files } = await source.listFiles()
    const oids = [...data.looks.values()].map((look) => look.oid).filter((oid) => oid !== ABSENT)
    const available = new Set([...(await service.hasBlobs(oids)), ...(await snapshotOids(db, oids))])
    const entries = classifySince(files, data.looks, (oid) => available.has(oid))
    expect(Object.fromEntries(entries.map((entry) => [entry.change.path, entry.kind]))).toEqual({
      'src/cart.ts': 'changed',
      'src/discount.ts': 'changed',
      'src/shipping.ts': 'new',
      'src/tax.ts': 'unchanged',
    })
    expect(countSince(entries)).toEqual({ changed: 2, unchanged: 1, fresh: 1, missing: 0 })
    // The reviewed discount.ts was never committed: it comes from the snapshot.
    expect(await service.blobOrNull(entries[1]!.look!.oid)).toBeNull()

    const since = sinceSource(source, entries, loadReviewed, {})
    const changedLines = async (path: string) => {
      const contents = await since.contents(entries.find((entry) => entry.change.path === path)!.change)
      expect(contents.notice).toBeUndefined()
      return buildLines(text(contents.old), text(contents.new))
        .filter((line) => line.kind !== 'context')
        .map((line) => `${line.kind === 'add' ? '+' : '-'}${line.text}`)
    }
    // Only the post-review changes, not the whole branch diff.
    expect(await changedLines('src/cart.ts')).toEqual(['+// Cart totals'])
    expect(await changedLines('src/discount.ts')).toEqual(['-  return total', '+  return Math.max(0, total - 5)'])

    // The note stays put in both views: stored on the final content, unchanged by the interdiff.
    const stored = (await db.notes.get(note))!
    const cartNow = sideLines((await source.contents(files.find((file) => file.path === 'src/cart.ts')!)).new)
    expect(placeNotes([stored], cartNow, { kind: 'interdiff' }).placed[0]!.anchor.line).toBe(3)

    // Without the snapshot (cleaned up, or another device) the file falls back to its full diff.
    await db.reviewSnapshots.clear()
    const missing = classifySince(files, data.looks, (oid) => available.has(oid) && oid !== entries[1]!.look!.oid)
    expect(missing.find((entry) => entry.change.path === 'src/discount.ts')!.kind).toBe('missing')
    const fallback = await sinceSource(source, entries, loadReviewed, {}).contents(entries[1]!.change)
    expect(fallback.notice).toMatch(/Showing the full diff/)
    expect(text(fallback.old)).toBe('')
  })

  it('lists first-parent commits and diffs each one like git show', async () => {
    // A merge of main into the branch: listed and marked, its second parent's history left out.
    git(repo, 'stash', '--include-untracked', '--quiet')
    git(repo, 'checkout', '--quiet', 'main')
    write('README.md', lines('# Shop', '', 'Run `npm test`.'))
    commit('Docs on main')
    git(repo, 'checkout', '--quiet', 'feature/quantity')
    git(repo, 'merge', '--quiet', '--no-edit', '--no-ff', 'main')
    git(repo, 'mv', 'src/tax.ts', 'src/vat.ts')
    commit('Rename tax to vat')
    git(repo, 'stash', 'pop', '--quiet')

    const { commits, truncated } = await service.branchCommits(baseSha)
    expect(truncated).toBe(false)
    expect(commits.map((entry) => entry.sha)).toEqual(git(repo, 'rev-list', '--first-parent', '--reverse', `${baseSha}..HEAD`).split('\n'))
    expect(commits.map((entry) => entry.parents.length)).toEqual([1, 1, 2, 1])
    expect(commits[0]!.message).toBe('Multiply by quantity')
    expect(commits[0]!.author).toBe('Test')

    for (let index = 0; index < commits.length; index++) {
      const { base, head } = rangeEnds(commits, { from: index, to: index })
      const { changes } = await service.commitChanges(base, head)
      // git show --first-parent: the commit against its first parent, renames detected.
      const expected = git(repo, 'diff', '--name-status', '-M', base!, head)
        .split('\n')
        .filter(Boolean)
        .map((line) => {
          const [code, ...paths] = line.split('\t')
          return code!.startsWith('R') ? `R ${paths[0]} -> ${paths[1]}` : `${code} ${paths[0]}`
        })
      const actual = changes.map((change) =>
        change.oldPath ? `R ${change.oldPath} -> ${change.path}` : `${{ added: 'A', modified: 'M', deleted: 'D' }[change.status]} ${change.path}`,
      )
      expect(actual, `commit ${index + 1}`).toEqual(expected)
      for (const change of changes) {
        const contents = await service.blobContents(change)
        const numstat = git(repo, 'diff', '--numstat', '-M', base!, head, '--', ...(change.oldPath ? [change.oldPath, change.path] : [change.path]))
        const [additions, deletions] = numstat.split('\t').map(Number)
        expect(countChanges(text(contents.old), text(contents.new)), `${change.path} in commit ${index + 1}`).toEqual({ additions, deletions })
        if (change.newOid) expect(text(contents.new)).toBe(git(repo, 'show', `${head}:${change.path}`) + '\n')
      }
    }

    // A range: the first two commits together, like git diff first^..second.
    const { base, head } = rangeEnds(commits, { from: 0, to: 1 })
    const range = await service.commitChanges(base, head)
    expect(range.changes.map((change) => change.path)).toEqual(git(repo, 'diff', '--name-only', base!, head).split('\n'))

    // A note made on the first commit: its line still exists at HEAD, so it is anchored on the final content.
    const firstCommit = await service.commitChanges(...Object.values(rangeEnds(commits, { from: 0, to: 0 })) as [string, string])
    const cart = firstCommit.changes.find((change) => change.path === 'src/cart.ts')!
    const commitLines = sideLines((await service.blobContents(cart)).new)!
    const finalLines = sideLines((await service.contents((await service.changes(baseSha)).find((c) => c.path === 'src/cart.ts')!)).new)
    const line = commitLines.find((entry) => entry.text.includes('item.quantity'))!.line
    const placed = anchorForView({ kind: 'commit', sha: commits[0]!.sha }, 'new', line, { old: null, new: commitLines }, finalLines)
    expect(placed).toEqual({ anchor: expect.objectContaining({ line: line + 1, text: commitLines[line - 1]!.text }) })
    // tax.ts was renamed to vat.ts, so there is no final tax.ts: a note on it stays on the commit.
    const tax = firstCommit.changes.find((change) => change.path === 'src/tax.ts')!
    const taxLines = sideLines((await service.blobContents(tax)).new)!
    const onCommit = anchorForView({ kind: 'commit', sha: commits[0]!.sha }, 'new', 2, { old: null, new: taxLines }, null)
    expect(onCommit).toMatchObject({ commit: commits[0]!.sha, anchor: { line: 2, text: 'export const REDUCED = 0.05' } })
  })
})

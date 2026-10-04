import { db } from '../../db/db'
import { readSnapshot } from '../../db/reviewSnapshots'
import { countChanges } from '../../diff/hunks'
import { gitService } from '../../git/client'
import { DEFAULT_MAX_BYTES, toSide } from '../../git/sides'
import type { FileStats } from '../../git/types'
import { cachedBlobLoader } from '../../github/blobCache'
import type { GitHubClient } from '../../github/client'
import { buildChangesBetween, prFileContents, type PrChanges } from '../../github/prDiff'
import type { RepoRef } from '../../github/types'
import type { SinceEntry } from '../../review/lastLook'
import type { DiffSource } from '../session/source'

/** Commits are immutable: CI and dirty paths do not apply to a commit's own diff. */
const NO_DIRTY = async () => new Set<string>()

/**
 * A commit or a range of commits in a local checkout, read from the object store. The session's scan has already
 * opened the repo in the git worker (commits are only listed after it).
 */
export function localCommitSource(from: string | null, to: string): DiffSource {
  const git = gitService()
  return {
    key: `commits:${from ?? 'root'}..${to}`,
    async listFiles() {
      const result = await git.commitChanges(from, to)
      return { files: result.changes, renamesLimited: result.limited }
    },
    analyze: (files) => git.analyzeBlobs(files),
    contents: (change, maxBytes) => git.blobContents(change, maxBytes),
    ciHead: async () => to,
    dirtyPaths: NO_DIRTY,
  }
}

/** A commit or a range of commits of a pull request, from the compare API and blobs. */
export function prCommitSource(gh: GitHubClient, ref: RepoRef, from: string, to: string): DiffSource {
  let built: Promise<PrChanges> | null = null
  const build = () => {
    built ??= gh.compareFiles(ref, from, to).then((files) => buildChangesBetween(gh, ref, from, to, files))
    built.catch(() => (built = null))
    return built
  }
  const load = cachedBlobLoader(db, gh, ref)
  return {
    key: `pr-commits:${ref.owner}/${ref.name}:${from}..${to}`,
    listFiles: async () => ({ files: (await build()).changes, renamesLimited: false }),
    async analyze() {
      const { stats, moved } = await build()
      return { stats, moved }
    },
    contents: async (change, maxBytes) => prFileContents(change, (await build()).metas, load, maxBytes),
    ciHead: async () => to,
    dirtyPaths: NO_DIRTY,
  }
}

/** Reads the content you reviewed, by blob oid. */
export type ReviewedLoader = (oid: string) => Promise<Uint8Array>

/** Local: the object store when the content was committed or staged, else this device's snapshot. */
export function localReviewedLoader(): ReviewedLoader {
  const git = gitService()
  return async (oid) => {
    const bytes = (await git.blobOrNull(oid)) ?? (await readSnapshot(db, oid))
    if (!bytes) throw new Error('The version you reviewed is not on this device.')
    return bytes
  }
}

/** Pull requests: any blob of the repository, from the cache or the GitHub API, so it works on every device. */
export const prReviewedLoader = (gh: GitHubClient, ref: RepoRef): ReviewedLoader => cachedBlobLoader(db, gh, ref)

/**
 * "Since last look": the session's own source, but files that changed since you reviewed them diff from the reviewed
 * content instead of the base. If that content cannot be read, the file's full diff is shown with a notice.
 */
export function sinceSource(
  base: DiffSource,
  entries: readonly SinceEntry[],
  loadReviewed: ReviewedLoader,
  baseStats: Readonly<Record<string, FileStats>>,
): DiffSource {
  const byPath = new Map(entries.map((entry) => [entry.change.path, entry]))
  const files = entries.map((entry) => entry.change)
  const contents: DiffSource['contents'] = async (change, maxBytes = DEFAULT_MAX_BYTES) => {
    const entry = byPath.get(change.path)
    if (!entry || entry.kind !== 'changed') return base.contents(entry?.original ?? change, maxBytes)
    const current = entry.original
    // The current side only: an "added" view of the file skips reading its base.
    const newSide = current.newOid
      ? base.contents({ ...current, status: 'added', oldOid: null, oldPath: undefined }, maxBytes).then((read) => read.new)
      : Promise.resolve(null)
    try {
      const [reviewed, next] = await Promise.all([change.oldOid ? loadReviewed(change.oldOid) : null, newSide])
      return { path: change.path, old: reviewed ? toSide(reviewed, maxBytes) : null, new: next }
    } catch (error) {
      const full = await base.contents(current, maxBytes)
      const reason = error instanceof Error ? error.message : String(error)
      return { ...full, notice: `Could not read the version you reviewed (${reason}) Showing the full diff.` }
    }
  }
  return {
    key: `since:${base.key}:${entries.map((entry) => `${entry.change.path}@${entry.kind}:${entry.change.oldOid}`).join('|')}`,
    listFiles: async () => ({ files, renamesLimited: false }),
    async analyze() {
      const stats: Record<string, FileStats> = {}
      for (const entry of entries) {
        const own = baseStats[entry.change.path]
        if (entry.kind !== 'changed' && own) stats[entry.change.path] = own
      }
      for (const entry of entries) {
        if (entry.kind !== 'changed') continue
        const read = await contents(entry.change).catch(() => null)
        if (!read || read.notice) continue
        const sides = [read.old, read.new]
        if (sides.some((side) => side?.kind === 'binary')) stats[entry.change.path] = { binary: true }
        else if (sides.some((side) => side?.kind === 'too-large')) stats[entry.change.path] = { tooLarge: true }
        else {
          const text = (side: typeof read.old) => (side?.kind === 'text' ? side.text : '')
          stats[entry.change.path] = countChanges(text(read.old), text(read.new))
        }
      }
      return { stats, moved: {} }
    },
    contents,
    ciHead: () => base.ciHead(),
    dirtyPaths: NO_DIRTY,
  }
}

import { db } from '../../db/db'
import { cachedBlobLoader } from '../../github/blobCache'
import type { GitHubClient } from '../../github/client'
import { buildPrChanges, prFileContents, type PrChanges, type PrSnapshot } from '../../github/prDiff'
import type { DiffSource } from '../session/source'

/** A pull request read entirely through the GitHub API: no checkout, blobs fetched on demand and cached. */
export function prSource(gh: GitHubClient, snapshot: PrSnapshot): DiffSource {
  let built: Promise<PrChanges> | null = null
  const build = () => {
    built ??= buildPrChanges(gh, snapshot)
    built.catch(() => (built = null))
    return built
  }
  const load = cachedBlobLoader(db, gh, snapshot.ref)
  return {
    key: `pr:${snapshot.ref.owner}/${snapshot.ref.name}#${snapshot.pull.number}@${snapshot.pull.headSha}:${snapshot.mergeBaseSha}`,
    listFiles: async () => ({ files: (await build()).changes, renamesLimited: false }),
    async analyze() {
      const { stats, moved } = await build()
      return { stats, moved }
    },
    contents: async (change, maxBytes) => prFileContents(change, (await build()).metas, load, maxBytes),
    ciHead: async () => snapshot.pull.headSha,
    // The diff shows the head commit itself, so annotations always match it.
    dirtyPaths: async () => new Set(),
  }
}

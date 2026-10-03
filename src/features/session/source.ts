import type { MovedIndex } from '../../diff/moved'
import { gitService } from '../../git/client'
import type { FileChange, FileContents, FileStats } from '../../git/types'
import type { CiSnapshot } from '../../github/ci'
import { connect } from '../../github/connect'
import { githubBaseChanges } from '../../github/remoteBase'
import type { RepoRef } from '../../github/types'

export interface ListedFiles {
  files: FileChange[]
  /** Rename detection only paired identical files: the change set was too large to compare contents. */
  renamesLimited: boolean
}

export interface Analysis {
  stats: Record<string, FileStats>
  moved: MovedIndex
}

/** Where a session's diff comes from: a local checkout through the git worker, or a pull request through the GitHub API. */
export interface DiffSource {
  /** Changes whenever the source would list different files. */
  key: string
  listFiles(): Promise<ListedFiles>
  analyze(files: FileChange[]): Promise<Analysis>
  contents(change: FileChange, maxBytes?: number): Promise<FileContents>
  /** The commit CI checks are shown for. */
  ciHead(): Promise<string>
  /** Annotated paths whose content in the diff is not the one in the checked commit. */
  dirtyPaths(snapshot: CiSnapshot, files: readonly FileChange[]): Promise<Set<string>>
}

/** A local checkout: the working tree against `baseSha`, with base blobs from GitHub when the base came from there. */
export function localSource(handle: FileSystemDirectoryHandle, baseSha: string, githubRepo: RepoRef | null): DiffSource {
  const git = gitService()
  return {
    key: `local:${baseSha}:${githubRepo ? `${githubRepo.owner}/${githubRepo.name}` : ''}`,
    async listFiles() {
      await git.open(handle)
      const changes = githubRepo ? await scanGitHubBase(githubRepo, baseSha) : await git.changes(baseSha)
      const renamed = await git.detectRenames(changes)
      return { files: renamed.changes, renamesLimited: renamed.limited }
    },
    analyze: (files) => git.analyze(files),
    contents: (change, maxBytes) => git.contents(change, maxBytes),
    ciHead: async () => (await git.info()).headSha,
    async dirtyPaths(snapshot, files) {
      const byPath = new Map(files.map((file) => [file.path, file]))
      const paths = [...new Set(snapshot.annotations.map((annotation) => annotation.path))].filter((path) => byPath.has(path))
      if (paths.length === 0) return new Set()
      const oids = await git.oidsAt(snapshot.sha, paths)
      return new Set(paths.filter((path) => oids[path] !== byPath.get(path)!.newOid))
    },
  }
}

async function scanGitHubBase(ref: RepoRef, baseSha: string): Promise<FileChange[]> {
  const conn = await connect(ref)
  if (!conn) throw new Error('This session diffs against a GitHub base, but no GitHub token is set in Settings.')
  return githubBaseChanges(gitService(), conn.gh, conn.ref, baseSha)
}

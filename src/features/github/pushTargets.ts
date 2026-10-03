import { db } from '../../db/db'
import type { Note, Repo, Session } from '../../db/schema'
import { gitService } from '../../git/client'
import type { FileChange } from '../../git/types'
import { connect } from '../../github/connect'
import { preparePush, pushPendingReview, type PushLookup, type PushPreview, type PushResult, type PushSelection } from '../../github/pushReview'

/** Where notes go: the open PR for a local branch, or the pull request a PR session reviews. */
export interface PushTarget {
  /** Throws with a readable message when pushing is not possible (no token, no remote). */
  prepare(notes: Note[]): Promise<PushLookup>
  push(preview: PushPreview, selection: PushSelection): Promise<PushResult>
  /** Shown above the push button. */
  notice: string
}

/** The open pull request whose head is the session's branch, matched through the GitHub API. */
export function localPushTarget(session: Session, repo: Repo, files: FileChange[] | null): PushTarget {
  const renames = new Map((files ?? []).flatMap((file) => (file.oldPath ? [[file.path, file.oldPath] as const] : [])))
  return {
    notice: 'The review stays pending, visible only to you, until you submit it on GitHub.',
    async prepare(notes) {
      const conn = await connect(repo)
      if (!conn) {
        throw new Error(
          repo.owner ? 'Set a GitHub personal access token in Settings to push notes.' : 'This repository has no GitHub remote named origin.',
        )
      }
      const { headSha } = await gitService().info()
      return preparePush(conn.gh, conn.ref, session.branch, headSha, notes, renames)
    },
    async push(preview, selection) {
      const conn = await connect(repo)
      if (!conn) throw new Error('Set a GitHub personal access token in Settings to push notes.')
      return pushPendingReview(db, conn.gh, conn.ref, preview.pr, selection)
    },
  }
}

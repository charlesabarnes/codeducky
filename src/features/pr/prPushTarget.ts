import { db } from '../../db/db'
import type { GitHubClient } from '../../github/client'
import type { PrSnapshot } from '../../github/prDiff'
import { preparePrPush, pushToPendingReview } from '../../github/prReview'
import { pushPendingReview } from '../../github/pushReview'
import { fetchThreads } from '../../github/threads'
import type { PushTarget } from '../github/pushTargets'

/**
 * Pushes a PR session's notes as your pending review. GitHub allows one pending review per person,
 * so notes join the existing one when there is one (looked up fresh, in case it was made on GitHub).
 */
export function prPushTarget(gh: GitHubClient, snapshot: PrSnapshot, onPushed: () => void): PushTarget {
  const { ref, pull, files } = snapshot
  return {
    notice: 'The review stays pending, visible only to you, until you submit it here or on GitHub.',
    prepare: async (notes) => preparePrPush(pull, files, notes),
    async push(preview, selection) {
      const { pendingReview } = await fetchThreads(gh, ref, pull.number)
      const result = pendingReview
        ? await pushToPendingReview(db, gh, ref, pull.number, pendingReview, selection)
        : await pushPendingReview(db, gh, ref, preview.pr, selection)
      onPushed()
      return result
    },
  }
}

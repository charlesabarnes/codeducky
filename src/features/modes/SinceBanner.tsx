import { withShortcut } from '../../keys/help'
import { shortSha } from '../../review/commitRange'
import type { SinceCounts } from '../../review/lastLook'
import type { HeadChange } from './useLastLook'
import '../github/github.css'

interface SinceBannerProps {
  change: HeadChange
  counts: SinceCounts
  /** Already showing what changed since the last look. */
  active: boolean
  onShow: () => void
  onDismiss: () => void
}

const plural = (count: number, one: string, many = `${one}s`) => `${count} ${count === 1 ? one : many}`

/** On resume, when the head moved since your last review: how much changed, and a one-click switch to see only that. */
export function SinceBanner({ change, counts, active, onShow, onDismiss }: SinceBannerProps) {
  const changed = counts.changed + counts.missing
  const commits = change.rewritten
    ? `history rewritten since ${shortSha(change.from)}`
    : change.commits === null
      ? null
      : plural(change.commits, 'commit')
  return (
    <div className="base-banner info since-banner" role="status">
      <p>
        <strong>
          {plural(changed, 'file')} changed since you last reviewed{commits ? ` (${commits})` : ''}.
        </strong>
        {counts.fresh > 0 && <> {plural(counts.fresh, 'file')} you have not viewed yet.</>}{' '}
        <span className="muted">
          Last reviewed at {shortSha(change.from)}, now at {shortSha(change.to)}.
        </span>
      </p>
      <div className="row">
        {!active && (
          <button type="button" onClick={onShow} title={withShortcut('Show only what changed since your last look', 'mode.since')}>
            Show changes since last look
          </button>
        )}
        <button type="button" className="secondary" onClick={onDismiss}>
          Dismiss
        </button>
      </div>
    </div>
  )
}

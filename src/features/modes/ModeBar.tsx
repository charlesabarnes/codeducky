import { useEffect, useRef, useState } from 'react'
import { isMergeCommit, type BranchCommit } from '../../git/types'
import { withShortcut } from '../../keys/help'
import { describeRange, isSingle, shortSha, summaryOf, type CommitRange } from '../../review/commitRange'
import type { SinceCounts } from '../../review/lastLook'
import type { CommitsState } from './useBranchCommits'
import type { ReviewMode } from './useReviewMode'
import './modes.css'

interface ModeBarProps {
  mode: ReviewMode
  onModeChange: (mode: ReviewMode) => void
  counts: SinceCounts | null
  showUnchanged: boolean
  onShowUnchangedChange: (show: boolean) => void
  commits: CommitsState
  range: CommitRange | null
  onPickCommit: (index: number, extend: boolean) => void
  /** Pull requests list their commits from GitHub; local branches from merge base to HEAD. */
  isPr: boolean
}

const dateFormat = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' })
const formatDate = (ms: number) => (ms ? dateFormat.format(ms) : '')

/** All changes, since last look, or a commit picker; with what the chosen view means right under it. */
export function ModeBar(props: ModeBarProps) {
  const { mode, onModeChange, counts, commits, range } = props
  const changedCount = counts ? counts.changed + counts.missing + counts.fresh : null
  return (
    <div className="mode-bar" data-mode={mode.kind}>
      <div className="row mode-row">
        <div className="segmented" role="group" aria-label="What to review">
          <button type="button" aria-pressed={mode.kind === 'all'} onClick={() => onModeChange({ kind: 'all' })} title={withShortcut('All changes on the branch', 'mode.all')}>
            All changes
          </button>
          <button
            type="button"
            aria-pressed={mode.kind === 'since'}
            aria-keyshortcuts="Shift+L"
            onClick={() => onModeChange(mode.kind === 'since' ? { kind: 'all' } : { kind: 'since' })}
            title={withShortcut('Only what changed since you last viewed each file', 'mode.since')}
          >
            Since last look{changedCount !== null && changedCount > 0 && <span className="mode-count">{changedCount}</span>}
          </button>
          <CommitPicker {...props} />
        </div>
        {mode.kind === 'since' && counts && <SinceSummary {...props} counts={counts} />}
      </div>
      {mode.kind === 'commits' && commits.status === 'ready' && range && <CommitHeader commits={commits.commits} range={range} isPr={props.isPr} />}
    </div>
  )
}

function SinceSummary({ counts, showUnchanged, onShowUnchangedChange }: ModeBarProps & { counts: SinceCounts }) {
  const parts = [
    counts.changed && `${counts.changed} changed since your last look`,
    counts.missing && `${counts.missing} changed (reviewed version not on this device)`,
    counts.fresh && `${counts.fresh} not viewed yet`,
  ].filter(Boolean)
  return (
    <p className="since-summary muted">
      {parts.length ? parts.join(', ') : 'Nothing changed since your last look.'}
      {counts.unchanged > 0 && (
        <>
          {' · '}
          <button type="button" className="link" aria-pressed={showUnchanged} onClick={() => onShowUnchangedChange(!showUnchanged)}>
            {showUnchanged ? `Hide ${counts.unchanged} unchanged` : `${counts.unchanged} unchanged hidden`}
          </button>
        </>
      )}
    </p>
  )
}

function CommitHeader({ commits, range, isPr }: { commits: readonly BranchCommit[]; range: CommitRange; isPr: boolean }) {
  const first = commits[range.from]!
  const last = commits[range.to]!
  const [summary, ...body] = last.message.split('\n')
  const scope = isSingle(range)
    ? `Commit ${range.from + 1} of ${commits.length}${isMergeCommit(last) ? ', a merge: diffed against its first parent' : ', against its parent'}`
    : `Commits ${range.from + 1}–${range.to + 1} of ${commits.length}, from ${shortSha(first.sha)}'s parent to ${shortSha(last.sha)}`
  return (
    <div className="commit-header">
      <div className="row">
        <span className="mono commit-sha" title={last.sha}>
          {isSingle(range) ? shortSha(last.sha) : `${shortSha(first.sha)}..${shortSha(last.sha)}`}
        </span>
        <strong className="commit-summary">{isSingle(range) ? summary : describeRange(commits, range)}</strong>
      </div>
      {isSingle(range) && body.join('\n').trim() && <pre className="commit-body">{body.join('\n').trim()}</pre>}
      <p className="muted commit-meta">
        {isSingle(range) ? (
          <>
            {last.author} · <time dateTime={new Date(last.date).toISOString()}>{formatDate(last.date)}</time> ·{' '}
          </>
        ) : null}
        {scope}. Viewed is per file for the whole {isPr ? 'pull request' : 'branch'}, not per commit. Notes on lines still in the
        final file are kept there; others stay on this commit.
      </p>
    </div>
  )
}

function CommitPicker({ mode, onModeChange, commits, range, onPickCommit }: ModeBarProps) {
  const [open, setOpen] = useState(false)
  const root = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const close = (event: Event) => {
      if (event instanceof KeyboardEvent ? event.key === 'Escape' : !root.current?.contains(event.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', close)
    document.addEventListener('keydown', close)
    return () => {
      document.removeEventListener('mousedown', close)
      document.removeEventListener('keydown', close)
    }
  }, [open])

  const list = commits.status === 'ready' ? commits.commits : []
  const label =
    mode.kind === 'commits' && range
      ? isSingle(range)
        ? `${shortSha(list[range.from]!.sha)} ${summaryOf(list[range.from]!)}`
        : describeRange(list, range)
      : commits.status === 'ready'
        ? `Commits (${list.length})`
        : 'Commits'
  return (
    <div className="commit-picker" ref={root}>
      <button
        type="button"
        aria-pressed={mode.kind === 'commits'}
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        title={withShortcut('Review one commit, or shift-click for a range', 'commit.next')}
      >
        <span className="commit-picker-label">{label}</span> ▾
      </button>
      {open && (
        <div className="commit-popover" role="listbox" aria-label="Commits" aria-multiselectable="true">
          <button
            type="button"
            role="option"
            aria-selected={mode.kind !== 'commits'}
            className="commit-option all"
            onClick={() => {
              onModeChange({ kind: 'all' })
              setOpen(false)
            }}
          >
            All changes
          </button>
          {commits.status === 'loading' && <p className="muted commit-note">Loading commits…</p>}
          {commits.status === 'error' && <p className="error commit-note">{commits.message}</p>}
          {commits.status === 'ready' && list.length === 0 && <p className="muted commit-note">No commits on this branch yet.</p>}
          {list.map((commit, index) => {
            const selected = range !== null && index >= range.from && index <= range.to
            return (
              <button
                key={commit.sha}
                type="button"
                role="option"
                aria-selected={selected}
                className="commit-option"
                title={`${commit.message}\n\nShift-click to pick a range.`}
                onClick={(event) => {
                  onPickCommit(index, event.shiftKey)
                  if (!event.shiftKey) setOpen(false)
                }}
              >
                <span className="mono commit-sha">{shortSha(commit.sha)}</span>
                <span className="commit-summary">{summaryOf(commit)}</span>
                {isMergeCommit(commit) && (
                  <span className="badge muted" title="A merge commit: diffed against its first parent">
                    merge
                  </span>
                )}
                <span className="muted commit-by">
                  {commit.author} · {formatDate(commit.date)}
                </span>
              </button>
            )
          })}
          {commits.status === 'ready' && commits.truncated && <p className="muted commit-note">Only the most recent commits are listed.</p>}
          {list.length > 1 && <p className="muted commit-note">Shift-click a second commit to review a range. {'{'} and {'}'} step through them.</p>}
        </div>
      )}
    </div>
  )
}

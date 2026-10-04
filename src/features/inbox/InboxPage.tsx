import { useLiveQuery } from 'dexie-react-hooks'
import { ArrowRight, Inbox as InboxIcon, RefreshCw } from 'lucide-react'
import { useRef, useState, type FormEvent } from 'react'
import { Link, useNavigate } from 'react-router'
import { parsePrReference, prPath } from '../../../shared/links'
import { db } from '../../db/db'
import type { InboxSection } from '../../db/schema'
import { SECTION_TITLES, SECTIONS, TOKEN_SCOPE_HINT, type Inbox, type InboxCi, type InboxRow } from '../../github/inbox'
import { useKeys, useShortcuts } from '../../keys/context'
import { withShortcut } from '../../keys/help'
import { PrLinks } from '../pr/PrLinks'
import { shortAge, timeAgo } from '../pr/time'
import { StatusBar } from '../../app/chrome'
import { useInbox } from './useInbox'
import './inbox.css'

const CI_ICON: Record<InboxCi, string> = { pass: '✓', fail: '✕', pending: '●', none: '○' }
const CI_LABEL: Record<InboxCi, string> = { pass: 'CI passing', fail: 'CI failing', pending: 'CI running', none: 'No CI checks' }
const INBOX_HINTS = [
  { keys: 'j/k', label: 'move' },
  { keys: 'o', label: 'open a pr' },
]
const REVIEW_LABEL: Record<string, string> = {
  APPROVED: 'you approved',
  CHANGES_REQUESTED: 'you requested changes',
  COMMENTED: 'you commented',
  DISMISSED: 'your review was dismissed',
}

export function InboxPage() {
  const { state, refresh } = useInbox()
  const inbox = state.status === 'ready' ? state.inbox : state.status === 'error' ? state.inbox : null
  const list = useRef<HTMLDivElement>(null)
  const openInput = useRef<HTMLInputElement>(null)
  const { announce } = useKeys()

  const moveFocus = (delta: 1 | -1) => {
    const links = [...(list.current?.querySelectorAll<HTMLAnchorElement>('a.inbox-open') ?? [])]
    if (links.length === 0) return announce('No pull requests', { visible: true })
    const index = links.indexOf(document.activeElement as HTMLAnchorElement)
    const next = links[index < 0 ? (delta > 0 ? 0 : links.length - 1) : Math.min(links.length - 1, Math.max(0, index + delta))]!
    next.focus()
    next.scrollIntoView({ block: 'nearest' })
  }
  useShortcuts('session', {
    'inbox.next': () => moveFocus(1),
    'inbox.prev': () => moveFocus(-1),
    'inbox.open': () => {
      openInput.current?.focus()
      openInput.current?.select()
    },
  })

  return (
    <section className="page inbox-page stack">
      <StatusBar mode="inbox" hints={INBOX_HINTS}>
        {inbox && <span className="strong">{SECTIONS.reduce((sum, section) => sum + inbox.sections[section].length, 0)} pull requests</span>}
      </StatusBar>
      <div className="row inbox-head">
        <h1>
          <InboxIcon size={16} aria-hidden />
          inbox
        </h1>
        <span className="spacer" />
        {state.status === 'ready' && (
          <span className="muted" aria-live="polite">
            {state.refreshing ? 'Refreshing…' : `Updated ${timeAgo(new Date(state.inbox.fetchedAt).toISOString())}`}
          </span>
        )}
        <button type="button" className="secondary" onClick={() => void refresh()} disabled={state.status === 'ready' && state.refreshing}>
          <RefreshCw size={13} aria-hidden />
          refresh
        </button>
      </div>
      <OpenPrForm inputRef={openInput} />
      {state.status === 'loading' && <p className="muted">Loading pull requests from GitHub…</p>}
      {state.status === 'no-token' && (
        <div className="card stack">
          <p>
            The inbox lists pull requests through the GitHub search API, with your personal access token. <Link to="/settings">Add one in Settings</Link>.
          </p>
          <p className="muted">{TOKEN_SCOPE_HINT}</p>
        </div>
      )}
      {state.status === 'error' && (
        <div className="card stack inbox-error" role="alert">
          <p className="error">{state.message}</p>
          {state.forbidden && <p className="muted">{TOKEN_SCOPE_HINT}</p>}
          {inbox && <p className="muted">Showing the inbox from {timeAgo(new Date(inbox.fetchedAt).toISOString())}.</p>}
        </div>
      )}
      {inbox && <InboxSections inbox={inbox} listRef={list} />}
    </section>
  )
}

function InboxSections({ inbox, listRef }: { inbox: Inbox; listRef: React.RefObject<HTMLDivElement | null> }) {
  const empty = SECTIONS.every((section) => inbox.sections[section].length === 0)
  return (
    <div ref={listRef} className="stack inbox-sections">
      {empty && (
        <div className="card stack">
          <p>
            No pull requests found for <strong>{inbox.viewer}</strong>.
          </p>
          <p className="muted">{TOKEN_SCOPE_HINT}</p>
        </div>
      )}
      {SECTIONS.map((section) => (
        <Section key={section} section={section} rows={inbox.sections[section]} total={inbox.totals[section]} />
      ))}
    </div>
  )
}

function Section({ section, rows, total }: { section: InboxSection; rows: InboxRow[]; total: number }) {
  return (
    <section className="inbox-section" aria-labelledby={`inbox-${section}`}>
      <h2 id={`inbox-${section}`}>
        {SECTION_TITLES[section].toLowerCase()} <span className="muted">{total > rows.length ? `${rows.length} of ${total}` : rows.length}</span>
      </h2>
      {rows.length === 0 ? (
        <p className="muted">Nothing here.</p>
      ) : (
        <ul className="inbox-list">
          {rows.map((row) => (
            <Row key={row.url} row={row} />
          ))}
        </ul>
      )}
    </section>
  )
}

function Row({ row }: { row: InboxRow }) {
  const pull = { owner: row.owner, name: row.name, number: row.number }
  return (
    <li className={`inbox-row${row.draft ? ' draft' : ''}`}>
      <span className={`ci-dot ci-${row.ci}`} title={CI_LABEL[row.ci]} aria-label={CI_LABEL[row.ci]}>
        {CI_ICON[row.ci]}
      </span>
      <div className="inbox-main">
        <Link className="inbox-open" to={prPath(pull)}>
          <span className="inbox-repo muted">
            {row.owner}/{row.name}
          </span>{' '}
          <span className="inbox-title">{row.title}</span> <span className="muted">#{row.number}</span>
        </Link>
        <div className="inbox-meta muted">
          <span>{row.author}</span>
          <span title={new Date(row.createdAt).toLocaleString()}>opened {shortAge(row.createdAt)} ago</span>
          <span title={new Date(row.updatedAt).toLocaleString()}>updated {shortAge(row.updatedAt)} ago</span>
          <span className="counts">
            <span className="add">+{row.additions}</span> <span className="del">−{row.deletions}</span> · {row.changedFiles}{' '}
            {row.changedFiles === 1 ? 'file' : 'files'}
          </span>
          {row.draft && <span className="badge">draft</span>}
          {row.state !== 'OPEN' && <span className="badge">{row.state.toLowerCase()}</span>}
          {row.viaTeam && <span className="badge">team request</span>}
          {row.pendingReview && <span className="badge pending-badge">your review is pending</span>}
          {row.myReview && REVIEW_LABEL[row.myReview] && <span className={`badge review-${row.myReview}`}>{REVIEW_LABEL[row.myReview]}</span>}
        </div>
      </div>
      <PrLinks pull={pull} compact />
    </li>
  )
}

function OpenPrForm({ inputRef }: { inputRef: React.RefObject<HTMLInputElement | null> }) {
  const navigate = useNavigate()
  const [value, setValue] = useState('')
  const [error, setError] = useState<string | null>(null)
  // "#123" means the repo opened most recently.
  const context = useLiveQuery(async () => {
    const repos = await db.repos.orderBy('lastOpenedAt').reverse().toArray()
    const repo = repos.find((candidate) => candidate.owner && candidate.name)
    return repo ? { owner: repo.owner, name: repo.name } : null
  }, [])

  const submit = (event: FormEvent) => {
    event.preventDefault()
    const ref = parsePrReference(value, context ?? null)
    if (!ref) {
      setError(
        /^#?\d+$/.test(value.trim()) && !context
          ? 'There is no current repo for #123; use owner/repo#123 or a URL.'
          : 'Paste a GitHub pull request URL, owner/repo#123 or #123.',
      )
      return
    }
    setError(null)
    navigate(prPath(ref))
  }

  return (
    <form className="open-pr row" onSubmit={submit}>
      <label className="sr-only" htmlFor="open-pr">
        Open a pull request
      </label>
      <input
        id="open-pr"
        ref={inputRef}
        type="text"
        value={value}
        onChange={(event) => setValue(event.target.value)}
        placeholder={`Open PR: URL, owner/repo#123${context ? ` or #123 for ${context.owner}/${context.name}` : ''}`}
        title={withShortcut('Open a pull request', 'inbox.open')}
        aria-keyshortcuts="o"
        spellCheck={false}
        autoComplete="off"
      />
      <button type="submit" className="secondary" disabled={!value.trim()}>
        <ArrowRight size={13} aria-hidden />
        open
      </button>
      {error && <span className="error">{error}</span>}
    </form>
  )
}

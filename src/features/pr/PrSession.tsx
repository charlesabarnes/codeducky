import { useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router'
import { db } from '../../db/db'
import { openPrSession } from '../../db/prSessions'
import type { Repo, Session } from '../../db/schema'
import { SessionView, type PrView } from '../session/SessionView'
import { prSource } from './prSource'
import { usePrConversation } from './usePrConversation'
import { usePrSnapshot, type SnapshotState } from './usePrSnapshot'
import { usePrThreads } from './usePrThreads'
import type { GitHubClient } from '../../github/client'
import type { PrSnapshot } from '../../github/prDiff'
import { githubPrUrl, type PullRef } from '../../../shared/links'

/** A pull request session: loads the PR from GitHub, keeps the session on its current head, and shows it. */
export function PrSession({ session, repo }: { session: Session; repo: Repo }) {
  const pr = session.pr!
  const ref = useMemo(() => ({ owner: pr.owner, name: pr.name }), [pr.owner, pr.name])
  const [refreshKey, setRefreshKey] = useState(0)
  const state = usePrSnapshot(ref, pr.number, refreshKey)

  if (state.status !== 'ready') return <SnapshotStatus state={state} pull={{ ...ref, number: pr.number }} />
  return (
    <ReadyPrSession
      session={session}
      repo={repo}
      gh={state.gh}
      snapshot={state.snapshot}
      refreshKey={refreshKey}
      onRefresh={() => setRefreshKey((n) => n + 1)}
    />
  )
}

interface ReadyProps {
  session: Session
  repo: Repo
  gh: GitHubClient
  snapshot: PrSnapshot
  refreshKey: number
  onRefresh: () => void
}

function ReadyPrSession({ session, repo, gh, snapshot, refreshKey, onRefresh }: ReadyProps) {
  const { ref, pull } = snapshot
  const stale = session.headSha !== pull.headSha || session.baseSha !== snapshot.mergeBaseSha
  useEffect(() => {
    // New commits on the PR: move the session to them; notes re-anchor on the next scan.
    if (stale) void openPrSession(db, snapshot)
  }, [stale, snapshot])

  const source = useMemo(() => prSource(gh, snapshot), [gh, snapshot])
  const key = `${pull.headSha}:${refreshKey}`
  const threads = usePrThreads(ref, pull.number, key)
  const conversation = usePrConversation(gh, ref, pull.number, key)
  const view: PrView = { gh, snapshot, threads, conversation, refresh: onRefresh, refreshing: threads.loading && refreshKey > 0 }
  return <SessionView key={source.key} session={session} repo={repo} source={source} dirHandle={null} pr={view} />
}

/** Loading, missing token and error states for a pull request, shared with the deep link page. */
export function SnapshotStatus({ state, pull }: { state: SnapshotState; pull: PullRef }) {
  const label = `${pull.owner}/${pull.name}#${pull.number}`
  if (state.status === 'loading' || state.status === 'ready') return <p className="page muted">Loading {label} from GitHub…</p>
  if (state.status === 'no-token') {
    return (
      <section className="page narrow stack">
        <h1>Add a GitHub token to open {label}</h1>
        <p>
          Skelbert reads pull requests through the GitHub API with your personal access token. It stays in this browser and is never
          synced.
        </p>
        <p>
          <Link to="/settings">Add a token in Settings</Link>, then come back to this link.
        </p>
      </section>
    )
  }
  return (
    <section className="page narrow stack">
      <h1>Could not open {label}</h1>
      <p className="error">{state.message}</p>
      {state.notFound && (
        <p className="muted">
          GitHub answers 404 both for pull requests that do not exist and for repositories the token cannot see. A fine-grained token must
          include this repository (for an organization, the organization must be its resource owner).
        </p>
      )}
      <p>
        <a href={githubPrUrl(pull)} target="_blank" rel="noreferrer">
          Open on GitHub
        </a>{' '}
        · <Link to="/inbox">Inbox</Link>
      </p>
    </section>
  )
}

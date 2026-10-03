import { useEffect, useState } from 'react'
import { useLocation, useNavigate } from 'react-router'
import { matchPrPath } from '../../../shared/links'
import { db } from '../../db/db'
import { openPrSession } from '../../db/prSessions'
import { githubClient } from '../../github/connect'
import { errorMessage, isGitHubError } from '../../github/errors'
import { SnapshotStatus } from './PrSession'
import { fetchSnapshot, type SnapshotState } from './usePrSnapshot'

/**
 * Deep links: /pr/owner/name/123, and github.com's own /owner/name/pull/123(/files…), so swapping
 * the host in a PR URL opens it here. Resumes the PR's session, or starts one.
 */
export function PrOpenPage() {
  const { pathname } = useLocation()
  const navigate = useNavigate()
  const pull = matchPrPath(pathname)
  const [state, setState] = useState<SnapshotState>({ status: 'loading' })
  const owner = pull?.owner
  const name = pull?.name
  const number = pull?.number ?? 0

  useEffect(() => {
    if (!owner || !name) return
    let cancelled = false
    const run = async () => {
      const gh = await githubClient()
      if (!gh) return !cancelled && setState({ status: 'no-token' })
      const snapshot = await fetchSnapshot(gh, { owner, name }, number)
      const sessionId = await openPrSession(db, snapshot)
      if (!cancelled) navigate(`/sessions/${encodeURIComponent(sessionId)}`, { replace: true })
    }
    run().catch(
      (error: unknown) =>
        !cancelled && setState({ status: 'error', message: errorMessage(error), notFound: isGitHubError(error, 'not-found') }),
    )
    return () => {
      cancelled = true
    }
  }, [owner, name, number, navigate])

  if (!pull) return <p className="page error">Not a pull request link: {pathname}</p>
  return <SnapshotStatus state={state} pull={pull} />
}

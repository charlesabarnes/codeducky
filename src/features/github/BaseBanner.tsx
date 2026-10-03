import { useState, type ReactNode } from 'react'
import type { Repo, Session } from '../../db/schema'
import { errorMessage } from '../../github/errors'
import { switchToGitHubBase, switchToLocalBase } from './baseActions'
import type { FreshnessState } from './useBaseFreshness'
import './github.css'

const short = (sha: string) => sha.slice(0, 7)

interface BaseBannerProps {
  state: FreshnessState
  session: Session
  repo: Repo
}

export function BaseBanner({ state, session, repo }: BaseBannerProps) {
  const [busy, setBusy] = useState(false)
  const [actionError, setActionError] = useState<string | null>(null)
  const base = `origin/${repo.baseBranch}`
  const usingGitHub = session.baseSource === 'github'
  const pushedSha = usingGitHub ? session.githubBase?.pushedSha : undefined

  const act = async (action: () => Promise<void>) => {
    setBusy(true)
    setActionError(null)
    try {
      await action()
    } catch (error) {
      setActionError(errorMessage(error))
    } finally {
      setBusy(false)
    }
  }
  const applyGitHubBase = (remoteTip: string) => act(() => switchToGitHubBase(session, repo, remoteTip))
  const applyLocalBase = () => act(() => switchToLocalBase(session, repo))
  const localButton = (
    <button type="button" className="secondary" disabled={busy} onClick={applyLocalBase}>
      Use local base
    </button>
  )

  let tone: 'info' | 'warn' = 'warn'
  let message: ReactNode = null
  let actions: ReactNode = null

  if (state.status === 'error') {
    message = <>Could not check {base} on GitHub. {state.message}</>
    if (usingGitHub) actions = localButton
  } else if (state.status === 'done') {
    const { freshness, localTip } = state
    if (freshness.kind === 'no-remote-branch') {
      message = <>GitHub has no branch named {repo.baseBranch}, so the base cannot be checked.</>
      if (usingGitHub) actions = localButton
    } else if (usingGitHub) {
      const moved = session.githubBase?.tipSha !== freshness.remoteTip
      tone = moved ? 'warn' : 'info'
      message = moved ? (
        <>
          {base} has moved on GitHub again (now {short(freshness.remoteTip)}). The diff still uses the merge base from{' '}
          {short(session.githubBase?.tipSha ?? '')}.
        </>
      ) : (
        <>
          Diffing against {base} from GitHub ({short(freshness.remoteTip)}), merge base {short(session.baseSha)}.
          {pushedSha && <> HEAD is not on GitHub, so this used your last pushed commit {short(pushedSha)}.</>}
          {freshness.remoteTip !== localTip && <> Your local {base} is at {short(localTip)}.</>}
        </>
      )
      actions = (
        <>
          {moved && (
            <button type="button" disabled={busy} onClick={() => applyGitHubBase(freshness.remoteTip)}>
              Update GitHub base
            </button>
          )}
          {localButton}
        </>
      )
    } else if (freshness.kind === 'stale') {
      const { pushed } = state
      const canUseGitHub = freshness.headPushed || pushed !== null
      message = (
        <>
          Your local {base} ({short(freshness.localTip)}) differs from GitHub ({short(freshness.remoteTip)}), so this diff
          may include changes that are already on {repo.baseBranch} or miss some.{' '}
          {freshness.headPushed
            ? 'Your HEAD is on GitHub, so the merge base and base files can come from there.'
            : pushed
              ? `Your HEAD is not on GitHub yet, so the GitHub base would use ${pushed.fallback ? 'the commit your branch forked from' : 'your last pushed commit'} ${short(pushed.sha)}. Unpushed commits stay in the diff.`
              : 'Your HEAD is not on GitHub yet. Run git fetch and resume the session from the repo page, or push your branch and rescan.'}
        </>
      )
      if (canUseGitHub) {
        actions = (
          <button type="button" disabled={busy} onClick={() => applyGitHubBase(freshness.remoteTip)}>
            Use GitHub base
          </button>
        )
      }
    }
  }

  if (session.baseNotice && !usingGitHub) {
    message = (
      <>
        {session.baseNotice}
        {message && <> {message}</>}
      </>
    )
  }

  if (!message) return null
  return (
    <div className={`base-banner ${tone}`} role="status">
      <p>{message}</p>
      {actions && <div className="row">{actions}</div>}
      {actionError && <p className="error">{actionError}</p>}
    </div>
  )
}

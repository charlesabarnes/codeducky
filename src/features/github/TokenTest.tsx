import { CircleAlert, CircleCheck, PlugZap } from 'lucide-react'
import { useState } from 'react'
import { createGitHubClient } from '../../github/client'
import { errorMessage } from '../../github/errors'
import type { Viewer } from '../../github/types'
import { useSyncState } from '../../sync/client'
import './github.css'

type State = { status: 'idle' } | { status: 'testing' } | { status: 'ok'; viewer: Viewer } | { status: 'error'; message: string }

export function TokenTest({ token }: { token: string }) {
  const [state, setState] = useState<State>({ status: 'idle' })
  const [testedToken, setTestedToken] = useState(token)
  const current = testedToken === token ? state : { status: 'idle' as const }
  const { user } = useSyncState()
  const mismatch = current.status === 'ok' && user?.role === 'user' && current.viewer.login.toLowerCase() !== user.login.toLowerCase()

  const test = async () => {
    setTestedToken(token)
    setState({ status: 'testing' })
    try {
      setState({ status: 'ok', viewer: await createGitHubClient({ token: token.trim() }).viewer() })
    } catch (error) {
      setState({ status: 'error', message: errorMessage(error) })
    }
  }

  return (
    <div className="token-test">
      <div className="row">
        <button type="button" className="secondary" disabled={!token.trim() || current.status === 'testing'} onClick={test}>
          <PlugZap size={13} aria-hidden />
          {current.status === 'testing' ? 'testing…' : 'test token'}
        </button>
        {current.status === 'ok' && (
          <>
            <span className="ok">
              <CircleCheck size={13} aria-hidden />
              <span>
                Signed in as <strong>{current.viewer.login}</strong>
                {current.viewer.name ? ` (${current.viewer.name})` : ''}
              </span>
            </span>
            <span className="muted">
              · {current.viewer.tokenExpiresAt ? `Token expires ${current.viewer.tokenExpiresAt}.` : 'GitHub reports no expiry for this token.'}
            </span>
          </>
        )}
      </div>
      {current.status === 'ok' && current.viewer.scopes && <small className="muted">Scopes: {current.viewer.scopes.join(', ') || 'none'}.</small>}
      {mismatch && (
        <small className="warn-text">
          <CircleAlert size={12} aria-hidden /> This token belongs to @{current.viewer.login}, but you are signed in to Code Ducky as @
          {user.login}.
        </small>
      )}
      {current.status === 'error' && <small className="error">{current.message}</small>}
    </div>
  )
}

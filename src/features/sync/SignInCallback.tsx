import { LoaderCircle } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router'
import { DEFAULT_RETURN_TO } from '../../sync/controller'
import { syncController, useSyncState } from '../../sync/client'
import { parseSignInFragment } from './signInErrors'

/** Where the server's GitHub callback lands: swaps the hand-off code in the fragment for a session. */
export function SignInCallback() {
  const navigate = useNavigate()
  const handled = useRef(false)
  const [waitingFor, setWaitingFor] = useState<string | null>(null)
  const { switchRequest } = useSyncState()

  useEffect(() => {
    if (handled.current) return
    handled.current = true
    const fragment = parseSignInFragment(window.location.hash)
    window.history.replaceState(window.history.state, '', window.location.pathname)
    const fail = (signInError: string) => void navigate(DEFAULT_RETURN_TO, { replace: true, state: { signInError } })
    if (!fragment) return fail('missing')
    if ('error' in fragment) return fail(fragment.error)
    const returnTo = syncController.pendingReturnTo()
    void syncController.completeSignIn(fragment.handoff).then((result) => {
      if (result === 'ok') void navigate(returnTo, { replace: true })
      else if (result === 'needsSwitch') setWaitingFor(returnTo)
      else fail(result)
    })
  }, [navigate])

  useEffect(() => {
    if (waitingFor && !switchRequest) void navigate(waitingFor, { replace: true })
  }, [waitingFor, switchRequest, navigate])

  return (
    <section className="page narrow signin-callback">
      <p className="muted">
        <LoaderCircle size={13} aria-hidden className="spin" />
        {waitingFor ? 'waiting for you to confirm the account switch…' : 'finishing sign-in…'}
      </p>
    </section>
  )
}

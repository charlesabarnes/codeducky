import { KeyRound, LogIn } from 'lucide-react'
import { useState, type FormEvent } from 'react'
import { useLocation } from 'react-router'
import { syncController } from '../../sync/client'
import { GithubIcon } from '../../ui/GithubIcon'
import { adminSignInErrorMessage, signInErrorMessage } from './signInErrors'

function defaultDeviceName(): string {
  const platform = (navigator as Navigator & { userAgentData?: { platform?: string } }).userAgentData?.platform
  return `Code Ducky on ${platform || 'this browser'}`
}

export function SignInForm({ expired }: { expired: boolean }) {
  const callbackError = (useLocation().state as { signInError?: string } | null)?.signInError
  const [name, setName] = useState(defaultDeviceName)
  const [busy, setBusy] = useState(false)
  const deviceName = () => name.trim() || defaultDeviceName()

  const signIn = async (event: FormEvent) => {
    event.preventDefault()
    setBusy(true)
    await syncController.beginGitHubSignIn(deviceName())
  }

  return (
    <div className="stack signin">
      {expired && <p className="error">This device's sign-in was revoked or expired. Sign in again with GitHub.</p>}
      {callbackError && <p className="error">{signInErrorMessage(callbackError)}</p>}
      <form className="stack" onSubmit={signIn}>
        <label className="field">
          <span>device name</span>
          <input value={name} onChange={(e) => setName(e.target.value)} maxLength={100} />
          <small>Shown in the token list, so you can revoke this device later.</small>
        </label>
        <div className="row">
          <button type="submit" disabled={busy}>
            <GithubIcon size={13} aria-hidden />
            {busy ? 'opening github…' : 'sign in with github'}
          </button>
          <small className="muted">Code Ducky reads only your public GitHub profile.</small>
        </div>
      </form>
      <AdminSignIn deviceName={deviceName} />
    </div>
  )
}

function AdminSignIn({ deviceName }: { deviceName: () => string }) {
  const [passphrase, setPassphrase] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    setBusy(true)
    setError(null)
    const result = await syncController.adminSignIn(passphrase, deviceName())
    setBusy(false)
    if (result === 'ok' || result === 'needsSwitch') setPassphrase('')
    else setError(adminSignInErrorMessage(result))
  }

  return (
    <details className="admin-signin">
      <summary>
        <KeyRound size={13} aria-hidden />
        admin sign-in
      </summary>
      <form className="stack" onSubmit={submit}>
        <label className="field">
          <span>admin passphrase</span>
          <input
            type="password"
            value={passphrase}
            autoComplete="current-password"
            onChange={(e) => setPassphrase(e.target.value)}
            required
          />
        </label>
        <div className="row">
          <button type="submit" className="secondary" disabled={busy || !passphrase}>
            <LogIn size={13} aria-hidden />
            {busy ? 'signing in…' : 'sign in as admin'}
          </button>
          {error && <span className="error">{error}</span>}
        </div>
      </form>
    </details>
  )
}

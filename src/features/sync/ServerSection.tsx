import { useLiveQuery } from 'dexie-react-hooks'
import { useEffect, useState, type FormEvent } from 'react'
import { db } from '../../db/db'
import { syncController, useSyncState } from '../../sync/client'
import type { SignInResult, TokenSummary } from '../../sync/controller'
import { listRejected } from '../../sync/rejected'
import { syncSummary } from '../../sync/summary'
import { ChannelSettings } from '../claude/ChannelSettings'
import { ConnectClaudeCode } from './ConnectClaudeCode'
import { PrePushGate } from './PrePushGate'
import './sync.css'

const SIGN_IN_ERRORS: Record<Exclude<SignInResult, 'ok'>, string> = {
  invalid: 'Wrong passphrase.',
  throttled: 'Too many attempts. Wait a few minutes and try again.',
  offline: 'Could not reach the server.',
  error: 'The server could not sign you in.',
}

function defaultDeviceName(): string {
  const platform = (navigator as Navigator & { userAgentData?: { platform?: string } }).userAgentData?.platform
  return `Skelbert on ${platform || 'this browser'}`
}

const formatTime = (ms: number | null) => (ms ? new Date(ms).toLocaleString() : 'never')

export function ServerSection() {
  const state = useSyncState()
  const signedIn = state.auth === 'signedIn'
  const [tokensVersion, setTokensVersion] = useState(0)
  return (
    <>
      <section className="sync-section stack" id="sync">
        <div>
          <h2>Sync server</h2>
          <p className="muted">
            Repos, sessions, notes, checklists and viewed files sync between your devices through the Skelbert server. The
            GitHub token and these settings never leave this browser.
          </p>
        </div>
        {signedIn ? <SignedIn /> : <SignInForm expired={state.auth === 'expired'} />}
        {state.rejected > 0 && <RejectedList />}
        {signedIn && <Tokens version={tokensVersion} />}
      </section>
      <ConnectClaudeCode signedIn={signedIn} onMinted={() => setTokensVersion((v) => v + 1)} />
      <PrePushGate signedIn={signedIn} onMinted={() => setTokensVersion((v) => v + 1)} />
      <ChannelSettings signedIn={signedIn} onMinted={() => setTokensVersion((v) => v + 1)} />
    </>
  )
}

function SignInForm({ expired }: { expired: boolean }) {
  const [passphrase, setPassphrase] = useState('')
  const [name, setName] = useState(defaultDeviceName)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    setBusy(true)
    setError(null)
    const result = await syncController.signIn(passphrase, name.trim() || defaultDeviceName())
    setBusy(false)
    if (result === 'ok') setPassphrase('')
    else setError(SIGN_IN_ERRORS[result])
  }

  return (
    <form className="stack" onSubmit={submit}>
      {expired && <p className="error">This device's sign-in was revoked or expired. Sign in again to resume syncing.</p>}
      <label className="field">
        <span>Passphrase</span>
        <input
          type="password"
          value={passphrase}
          autoComplete="current-password"
          onChange={(e) => setPassphrase(e.target.value)}
          required
        />
      </label>
      <label className="field">
        <span>Device name</span>
        <input value={name} onChange={(e) => setName(e.target.value)} maxLength={100} />
        <small className="muted">Shown in the token list, so you can revoke this device later.</small>
      </label>
      <div className="row">
        <button type="submit" disabled={busy || !passphrase}>
          {busy ? 'Signing in…' : 'Sign in'}
        </button>
        {error && <span className="error">{error}</span>}
      </div>
    </form>
  )
}

function SignedIn() {
  const state = useSyncState()
  const summary = syncSummary(state)
  const signOut = () => {
    const unsent = state.pending > 0 ? `\n\n${state.pending} change(s) have not uploaded yet. They stay on this device and upload when you sign in again.` : ''
    if (window.confirm(`Sign out of the sync server?${unsent}`)) void syncController.signOut()
  }
  return (
    <div className="stack">
      <p>
        Signed in as <strong>{state.deviceName}</strong>. <span className={summary.tone === 'error' ? 'error' : 'muted'}>{summary.label}</span>
        {summary.detail && <span className="muted"> · {summary.detail}</span>}
      </p>
      <div className="row">
        <button type="button" className="secondary" onClick={() => void syncController.sync()} disabled={state.status === 'syncing'}>
          Sync now
        </button>
        <button type="button" className="secondary" onClick={signOut}>
          Sign out
        </button>
      </div>
    </div>
  )
}

function RejectedList() {
  const items = useLiveQuery(() => listRejected(db), []) ?? []
  return (
    <div className="stack">
      <h3>Changes the server refused</h3>
      <p className="muted">These stay on this device. Retry after fixing the cause, or discard this device's version.</p>
      <ul className="stack">
        {items.map((item) => (
          <li key={item.key} className="row">
            <span>
              {item.label} <span className="error">{item.error}</span>
            </span>
            <span className="spacer" />
            <button type="button" className="link" onClick={() => void syncController.retryRejected(item.key)}>
              Retry
            </button>
            <button
              type="button"
              className="link danger"
              onClick={() => window.confirm('Discard this device\'s version?') && void syncController.discardRejected(item.key)}
            >
              Discard
            </button>
          </li>
        ))}
      </ul>
    </div>
  )
}

const KIND_LABELS: Record<TokenSummary['kind'], string> = { session: 'device', api: 'API', oauth: 'OAuth' }

function Tokens({ version: outside }: { version: number }) {
  const [tokens, setTokens] = useState<TokenSummary[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [name, setName] = useState('Claude Code')
  const [minted, setMinted] = useState<{ name: string; token: string } | null>(null)
  const [copied, setCopied] = useState(false)

  const [version, setVersion] = useState(0)
  const load = () => setVersion((v) => v + 1)

  useEffect(() => {
    let cancelled = false
    syncController.listTokens().then(
      (list) => !cancelled && setTokens(list),
      (err: unknown) => !cancelled && setError(err instanceof Error ? err.message : String(err)),
    )
    return () => {
      cancelled = true
    }
  }, [version, outside])

  const mint = async (event: FormEvent) => {
    event.preventDefault()
    try {
      const { token, info } = await syncController.mintToken(name.trim())
      setMinted({ name: info.name, token })
      setCopied(false)
      load()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  const revoke = async (token: TokenSummary) => {
    if (token.current) {
      if (window.confirm('This is the token this device uses. Revoking it signs this device out. Continue?')) await syncController.signOut()
      return
    }
    if (!window.confirm(`Revoke "${token.name}"? Anything using it stops working.`)) return
    try {
      await syncController.revokeToken(token.id)
      load()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  const copy = async () => {
    if (!minted) return
    await navigator.clipboard.writeText(minted.token)
    setCopied(true)
  }

  return (
    <div className="stack">
      <h3>Access tokens</h3>
      <p className="muted">
        Each signed-in device has one. Create a named token for tools such as Claude Code; it can read and write your
        review data but cannot manage tokens. OAuth entries are MCP clients you approved, such as claude.ai connectors.
      </p>
      {error && <p className="error">{error}</p>}
      {tokens && (
        <table className="token-table">
          <thead>
            <tr>
              <th>Name</th>
              <th>Type</th>
              <th>Created</th>
              <th>Last used</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {tokens.map((token) => (
              <tr key={token.id}>
                <td>
                  {token.name}
                  {token.current && <span className="muted"> (this device)</span>}
                </td>
                <td>{KIND_LABELS[token.kind]}</td>
                <td>{formatTime(token.createdAt)}</td>
                <td>{formatTime(token.lastUsedAt)}</td>
                <td>
                  <button type="button" className="link danger" onClick={() => void revoke(token)}>
                    Revoke
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <form className="row" onSubmit={mint}>
        <input value={name} onChange={(e) => setName(e.target.value)} maxLength={100} aria-label="Token name" />
        <button type="submit" className="secondary" disabled={!name.trim()}>
          Create token
        </button>
      </form>
      {minted && (
        <div className="card stack">
          <p>
            Token for <strong>{minted.name}</strong>. Copy it now; it is not shown again.
          </p>
          <code className="mono minted-token">{minted.token}</code>
          <div className="row">
            <button type="button" className="secondary" onClick={() => void copy()}>
              {copied ? 'Copied' : 'Copy'}
            </button>
            <button type="button" className="link" onClick={() => setMinted(null)}>
              Done
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

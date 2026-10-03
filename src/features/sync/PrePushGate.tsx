import { useState } from 'react'
import { syncController } from '../../sync/client'
import {
  claudeHookSettings,
  installClaudeHookCommand,
  installPrePushCommand,
  keychainCommand,
} from '../../sync/gate'
import { CopyField } from './CopyField'

interface PrePushGateProps {
  signedIn: boolean
  onMinted: () => void
}

/** Copyable setup for the pre-push gate. Nothing installs itself. */
export function PrePushGate({ signedIn, onMinted }: PrePushGateProps) {
  const origin = window.location.origin
  const [token, setToken] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const mint = async () => {
    setBusy(true)
    setError(null)
    try {
      setToken((await syncController.mintToken('Pre-push gate')).token)
      onMinted()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="sync-section stack" id="pre-push-gate">
      <div>
        <h2>Pre-push gate</h2>
        <p className="muted">
          Blocks <code className="mono">git push</code> while the branch's session has open blocker or issue notes, or unticked
          items on a checklist marked required. It fails open: with no token, no network or no answer within 2 seconds it
          warns and lets the push through. <code className="mono">git push --no-verify</code> skips it.
        </p>
      </div>

      <h3>1. Store a token in the Keychain</h3>
      {token ? (
        <div className="stack">
          <CopyField label="Token (shown only this once)" value={token} />
          <p className="muted">It appears as “Pre-push gate” under Access tokens, where you can revoke it.</p>
        </div>
      ) : (
        <div className="row">
          <button type="button" className="secondary" disabled={!signedIn || busy} onClick={() => void mint()}>
            {busy ? 'Creating…' : 'Create a token'}
          </button>
          {!signedIn && <span className="muted">Sign in above to create a token.</span>}
          {error && <span className="error">{error}</span>}
        </div>
      )}
      <CopyField label="Then run this and paste the token when asked" value={keychainCommand()} />
      <p className="muted">
        Elsewhere than macOS, export <code className="mono">SKELBERT_TOKEN</code> instead. The scripts use this server unless
        <code className="mono"> git config skelbert.url</code> says otherwise.
      </p>

      <h3>2. Install the git hook in a repo</h3>
      <CopyField label="Run in the repo's root" value={installPrePushCommand(origin)} />

      <h3>3. Gate pushes from Claude Code (optional)</h3>
      <CopyField label="Download the hook script" value={installClaudeHookCommand(origin)} />
      <CopyField label="Merge into ~/.claude/settings.json" value={claudeHookSettings()} block />
      <p className="muted">
        The hook runs on every Bash command but only acts on <code className="mono">git push</code>; when the gate fails it
        denies the command and gives Claude the reasons.
      </p>
    </section>
  )
}

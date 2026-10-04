import { KeyRound, ShieldCheck } from 'lucide-react'
import { useState } from 'react'
import { Panel } from '../../ui/Panel'
import { Step } from '../../ui/Step'
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
    <Panel icon={ShieldCheck} title="pre-push gate" id="pre-push-gate">
      <p>
        Blocks <code>git push</code> while the branch's session has open blocker or issue notes, or unticked items on a checklist
        marked required. It fails open: with no token, no network or no answer within 2 seconds it warns and lets the push
        through. <code>git push --no-verify</code> skips it.
      </p>
      <ol className="steps">
        <Step number={1} title="Store a token in the Keychain">
          {token ? (
            <div className="stack">
              <CopyField label="Token (shown only this once)" value={token} />
              <p>It appears as “Pre-push gate” under Access tokens, where you can revoke it.</p>
            </div>
          ) : (
            <div className="row">
              <button type="button" className="secondary" disabled={!signedIn || busy} onClick={() => void mint()}>
                <KeyRound size={13} aria-hidden />
                {busy ? 'creating…' : 'create a token'}
              </button>
              {!signedIn && <span className="muted">Sign in above to create a token.</span>}
              {error && <span className="error">{error}</span>}
            </div>
          )}
          <CopyField label="Then run this and paste the token when asked" value={keychainCommand()} />
          <p>
            Elsewhere than macOS, export <code>CODEDUCKY_TOKEN</code> instead. The scripts use this server unless{' '}
            <code>git config codeducky.url</code> says otherwise.
          </p>
        </Step>
        <Step number={2} title="Install the git hook in a repo">
          <CopyField label="Run in the repo's root" value={installPrePushCommand(origin)} />
        </Step>
        <Step number={3} title="Gate pushes from Claude Code" optional>
          <CopyField label="Download the hook script" value={installClaudeHookCommand(origin)} />
          <CopyField label="Merge into ~/.claude/settings.json" value={claudeHookSettings()} block />
          <p>
            The hook runs on every Bash command but only acts on <code>git push</code>; when the gate fails it denies the command and
            gives Claude the reasons.
          </p>
        </Step>
      </ol>
    </Panel>
  )
}

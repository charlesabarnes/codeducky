import { KeyRound, RadioTower } from 'lucide-react'
import { useState } from 'react'
import { Panel } from '../../ui/Panel'
import { Step } from '../../ui/Step'
import { useChannel } from '../../channel/client'
import { marketplaceAddCommand, pluginInstallCommand, serverUrlCommand, startCommand, STATUS_TOOL_ID } from '../../channel/setup'
import { keychainCommand } from '../../sync/gate'
import { syncController } from '../../sync/client'
import { CopyField } from '../sync/CopyField'
import { timeAgo } from '../pr/time'
import './claude.css'

interface ChannelSettingsProps {
  signedIn: boolean
  onMinted: () => void
}

/** Setup for the "Send to Claude" channel plugin, and the Claude Code sessions connected right now. */
export function ChannelSettings({ signedIn, onMinted }: ChannelSettingsProps) {
  const origin = window.location.origin
  const [token, setToken] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const mint = async () => {
    setBusy(true)
    setError(null)
    try {
      setToken((await syncController.mintToken('Claude channel')).token)
      onMinted()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Panel
      icon={RadioTower}
      id="claude-channel"
      title={
        <>
          claude code channel <span className="badge">research preview</span>
        </>
      }
    >
      <p>
        “Send to Claude” in a session pushes a review, a fix of your accepted notes or your own message into a Claude Code session
        that is already running in that repo. Claude reports back here as it works, and its permission prompts can be approved from
        the session page. The plugin connects out to this server; nothing listens on your machine.
      </p>
      <div className="channel-preview-note">
        <p>
          <strong>Channels are a Claude Code research preview.</strong> The flag and protocol may change.
        </p>
        <ul>
          <li>Claude Code signed in with a claude.ai account or a Console API key (not Bedrock, Vertex or Foundry).</li>
          <li>Team and Enterprise organizations must turn channels on in their admin settings.</li>
          <li>
            This plugin is not on Anthropic's channel allowlist, so it starts with <code>--dangerously-load-development-channels</code>{' '}
            and Claude Code asks you to confirm each time.
          </li>
          <li>
            <a href="https://bun.sh" target="_blank" rel="noreferrer">
              Bun
            </a>{' '}
            on your PATH; the plugin runs on it, like the official channel plugins.
          </li>
        </ul>
      </div>

      <ol className="steps">
        <Step number={1} title="Add the marketplace and install the plugin">
          <CopyField label="Add the marketplace (this repo; private, so git needs access to it)" value={marketplaceAddCommand()} />
          <CopyField label="Install the plugin" value={pluginInstallCommand()} />
        </Step>
        <Step number={2} title="Give it a token and this server's URL">
          <p>
            It reads <code>RUBBERDUCK_TOKEN</code>, else the Keychain item “rubberduck” the pre-push gate uses; and <code>RUBBERDUCK_URL</code>,
            else <code>git config rubberduck.url</code>. If the gate is set up already, skip this step.
          </p>
          {token ? (
            <CopyField label="Token (shown only this once; listed as “Claude channel” under Access tokens)" value={token} />
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
          <CopyField label="Store it in the Keychain (paste the token when asked)" value={keychainCommand()} />
          <CopyField label="Point it at this server" value={serverUrlCommand(origin)} />
        </Step>
        <Step number={3} title="Connect the Rubberduck MCP server">
          <p>
            Tasks use its tools (get_review_context, add_note, resolve_note). See <a href="#connect-claude-code">Connect Claude Code</a>{' '}
            above.
          </p>
        </Step>
        <Step number={4} title="Start Claude Code in the repo with the channel">
          <CopyField label="Run in the repo's checkout, then choose “I am using this for local development”" value={startCommand()} />
          <p>
            <code>--allowedTools {STATUS_TOOL_ID}</code> lets Claude report status here without asking each time; drop it to approve
            those calls yourself. <code>--channels plugin:rubberduck@rubberduck</code> alone does not load it while it is off the allowlist.
          </p>
        </Step>
      </ol>

      <ConnectedSessions signedIn={signedIn} />
    </Panel>
  )
}

function ConnectedSessions({ signedIn }: { signedIn: boolean }) {
  const { status, state } = useChannel()
  return (
    <div className="sub-section">
      <h3>connected sessions</h3>
      {!signedIn ? (
        <p className="muted">Sign in to see connected sessions.</p>
      ) : state.sessions.length === 0 ? (
        <p className="muted">{status === 'live' ? 'None right now.' : 'Connecting…'}</p>
      ) : (
        <table className="data-table token-table">
          <thead>
            <tr>
              <th>session</th>
              <th>repo</th>
              <th>branch</th>
              <th>token</th>
              <th>status</th>
            </tr>
          </thead>
          <tbody>
            {state.sessions.map((session) => (
              <tr key={session.id}>
                <td title={session.cwd}>
                  <span className={`claude-dot ${session.connected ? 'on' : ''}`} aria-hidden="true" /> {session.label}
                </td>
                <td>{session.repo ?? '—'}</td>
                <td>{session.branch ?? '—'}</td>
                <td>{session.tokenName}</td>
                <td>{session.connected ? `connected ${timeAgo(new Date(session.connectedAt).toISOString())}` : 'reconnecting…'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  )
}

import { Bot, KeyRound } from 'lucide-react'
import { useState } from 'react'
import { Panel } from '../../ui/Panel'
import { CopyField } from './CopyField'
import { syncController } from '../../sync/client'
import { claudeAddCommand, mcpUrl } from '../../sync/mcp'

interface ConnectClaudeCodeProps {
  signedIn: boolean
  /** Called after a token is minted, so the token list can refresh. */
  onMinted: () => void
}

export function ConnectClaudeCode({ signedIn, onMinted }: ConnectClaudeCodeProps) {
  const url = mcpUrl(window.location.origin)
  const [token, setToken] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const mint = async () => {
    setBusy(true)
    setError(null)
    try {
      setToken((await syncController.mintToken('Claude Code')).token)
      onMinted()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Panel icon={Bot} title="connect claude code" id="connect-claude-code">
      <p>
        Skelbert is also an MCP server. Claude Code can list your open notes for the branch it is on, resolve them with a reply,
        add notes as suggestions and tick checklist items. Changes reach this app on the next sync.
      </p>
      <CopyField label="MCP URL" value={url} />
      <CopyField label="Add with OAuth (approve in the browser with your passphrase)" value={claudeAddCommand(url)} />
      {token ? (
        <div className="stack">
          <CopyField label="Or add with a token" value={claudeAddCommand(url, token)} />
          <p className="muted">
            The token is shown only this once. It appears as “Claude Code” under Access tokens, where you can revoke it.
          </p>
        </div>
      ) : (
        <div className="row">
          <button type="button" className="secondary" disabled={!signedIn || busy} onClick={() => void mint()}>
            <KeyRound size={13} aria-hidden />
            {busy ? 'creating…' : 'create a token and show the command'}
          </button>
          {!signedIn && <span className="muted">Sign in above to create a token.</span>}
          {error && <span className="error">{error}</span>}
        </div>
      )}
      <div className="sub-section">
        <h3>slash commands</h3>
        <p>
          Once connected, Claude Code offers two prompts from this server. Run them in the repo's checkout; repo and branch default
          to the current checkout, or pass them as <code>owner/name branch</code>.
        </p>
        <dl className="command-list">
          <dt>/mcp__skelbert__review</dt>
          <dd>
            reviews the branch against its merge base, following this repo's review instructions (on the repo page), and adds
            findings here as suggestions to accept or dismiss.
          </dd>
          <dt>/mcp__skelbert__fix</dt>
          <dd>
            fixes open and accepted notes, runs the relevant tests and resolves each note with a reply. It asks before large
            refactors and never pushes.
          </dd>
        </dl>
      </div>
      <p>
        claude.ai custom connectors use OAuth with the same URL: add a custom connector with <code>{url}</code> and approve it with
        your passphrase. Connected clients are listed under Access tokens as OAuth.
      </p>
    </Panel>
  )
}

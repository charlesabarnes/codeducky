import { useState } from 'react'
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
    <section className="sync-section stack" id="connect-claude-code">
      <div>
        <h2>Connect Claude Code</h2>
        <p className="muted">
          Skelbert is also an MCP server. Claude Code can list your open notes for the branch it is on, resolve them with a
          reply, add notes as suggestions and tick checklist items. Changes reach this app on the next sync.
        </p>
      </div>
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
            {busy ? 'Creating…' : 'Create a token and show the command'}
          </button>
          {!signedIn && <span className="muted">Sign in above to create a token.</span>}
          {error && <span className="error">{error}</span>}
        </div>
      )}
      <div className="stack" style={{ gap: '0.25rem' }}>
        <h3>Slash commands</h3>
        <p className="muted">
          Once connected, Claude Code offers two prompts from this server. Run them in the repo's checkout; repo and branch
          default to the current checkout, or pass them as <code className="mono">owner/name branch</code>.
        </p>
        <ul className="muted">
          <li>
            <code className="mono">/mcp__skelbert__review</code> reviews the branch against its merge base, following this
            repo's review instructions (on the repo page), and adds findings here as suggestions to accept or dismiss.
          </li>
          <li>
            <code className="mono">/mcp__skelbert__fix</code> fixes open and accepted notes, runs the relevant tests and resolves
            each note with a reply. It asks before large refactors and never pushes.
          </li>
        </ul>
      </div>
      <p className="muted">
        claude.ai custom connectors use OAuth with the same URL: add a custom connector with <code className="mono">{url}</code>{' '}
        and approve it with your passphrase. Connected clients are listed under Access tokens as OAuth.
      </p>
    </section>
  )
}

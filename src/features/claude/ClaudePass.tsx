import { useLiveQuery } from 'dexie-react-hooks'
import { useState } from 'react'
import { Link } from 'react-router'
import type { PassProgress } from '../../claude/pass'
import { formatCost } from '../../claude/pricing'
import { db } from '../../db/db'
import type { Repo } from '../../db/schema'
import { loadSettings } from '../../db/settings'
import { saveRepoInstructions } from '../../db/suggestions'
import type { FileChange } from '../../git/types'
import { useClaudePass } from './useClaudePass'

type Scope = 'all' | 'unviewed'

interface ClaudePassProps {
  sessionId: string
  repo: Repo
  files: FileChange[] | null
  viewed: ReadonlySet<string>
}

const number = (value: number) => value.toLocaleString()

export function ClaudePass({ sessionId, repo, files, viewed }: ClaudePassProps) {
  const settings = useLiveQuery(() => loadSettings(db), [])
  const [open, setOpen] = useState(false)
  const [scope, setScope] = useState<Scope>('unviewed')
  const pass = useClaudePass()

  const all = files ?? []
  const unviewed = all.filter((file) => !viewed.has(file.path))
  const targets = scope === 'all' ? all : unviewed
  const apiKey = settings?.anthropicKey ?? ''
  const model = settings?.claudeModel ?? ''
  const failed = pass.progress?.files.filter((file) => file.state === 'failed' || file.state === 'cancelled') ?? []

  const start = (selection: FileChange[], carryUsage = false) =>
    pass.run({ sessionId, apiKey, model, instructions: repo.claudeInstructions, files: selection, carryUsage })
  const retry = () => {
    const paths = new Set(failed.map((file) => file.path))
    start(all.filter((file) => paths.has(file.path)), true)
  }

  return (
    <div className="claude-pass stack">
      <div className="row">
        <button type="button" className="secondary" aria-expanded={open} onClick={() => setOpen(!open)}>
          Claude pass
        </button>
        {pass.running && <span className="muted">Running…</span>}
      </div>
      {open && (
        <div className="claude-panel stack">
          {!apiKey ? (
            <p className="muted">
              Add an Anthropic API key in <Link to="/settings">Settings</Link> to run a Claude pass.
            </p>
          ) : (
            <>
              <fieldset className="claude-scope" disabled={pass.running}>
                <label>
                  <input type="radio" checked={scope === 'unviewed'} onChange={() => setScope('unviewed')} /> Unviewed files (
                  {unviewed.length})
                </label>
                <label>
                  <input type="radio" checked={scope === 'all'} onChange={() => setScope('all')} /> All files ({all.length})
                </label>
              </fieldset>
              <Instructions repo={repo} />
              <div className="row">
                {pass.running ? (
                  <button type="button" className="secondary" onClick={pass.cancel}>
                    Cancel
                  </button>
                ) : (
                  <button type="button" disabled={targets.length === 0} onClick={() => start(targets)}>
                    Review {targets.length} {targets.length === 1 ? 'file' : 'files'}
                  </button>
                )}
                {!pass.running && failed.length > 0 && (
                  <button type="button" className="secondary" onClick={retry}>
                    Retry {failed.length}
                  </button>
                )}
              </div>
              <small className="muted mono">{model}</small>
            </>
          )}
          {pass.error && <p className="error">{pass.error}</p>}
          {pass.progress && <PassSummary progress={pass.progress} />}
        </div>
      )}
    </div>
  )
}

function Instructions({ repo }: { repo: Repo }) {
  const saved = repo.claudeInstructions ?? ''
  return (
    <details className="claude-instructions">
      <summary>Repo instructions{saved ? ' (set)' : ''}</summary>
      <textarea
        key={saved}
        rows={3}
        defaultValue={saved}
        placeholder="Added to the prompt for this repo, e.g. never flag onboarding code."
        aria-label="Repo instructions for Claude"
        onBlur={(event) => event.target.value.trim() !== saved && saveRepoInstructions(db, repo.id!, event.target.value)}
      />
    </details>
  )
}

function PassSummary({ progress }: { progress: PassProgress }) {
  const { files, usage } = progress
  const finished = files.filter((file) => file.state !== 'queued' && file.state !== 'running').length
  const running = files.filter((file) => file.state === 'running')
  const total = (key: 'added' | 'duplicates' | 'unanchored' | 'invalid') => files.reduce((sum, file) => sum + file[key], 0)
  const skipped = files.filter((file) => file.state === 'skipped').length
  const problems = files.filter((file) => file.state === 'failed')
  const label = { running: 'Reviewing', done: 'Done', cancelled: 'Cancelled', failed: 'Stopped' }[progress.status]

  return (
    <div className="claude-progress stack" aria-live="polite">
      <div className="viewed-progress">
        <progress max={files.length} value={finished} />
        <span className="muted">
          {label} {finished}/{files.length}
        </span>
      </div>
      {running.length > 0 && (
        <ul className="claude-running muted mono">
          {running.map((file) => (
            <li key={file.path} title={file.path}>
              {file.path}
              {file.chunks > 1 ? ` (${file.chunksDone}/${file.chunks})` : ''}
            </li>
          ))}
        </ul>
      )}
      {progress.error && <p className="error">{progress.error}</p>}
      {problems.length > 0 && (
        <ul className="claude-failures">
          {problems.map((file) => (
            <li key={file.path}>
              <span className="mono">{file.path}</span>: <span className="error">{file.message}</span>
            </li>
          ))}
        </ul>
      )}
      <p className="muted">
        {total('added')} suggestions added
        {total('duplicates') > 0 && ` · ${total('duplicates')} already noted`}
        {total('unanchored') > 0 && ` · ${total('unanchored')} could not be placed`}
        {total('invalid') > 0 && ` · ${total('invalid')} malformed`}
        {skipped > 0 && ` · ${skipped} files skipped`}
      </p>
      <p className="muted claude-usage">
        {number(usage.requests)} requests · {number(usage.inputTokens)} in · {number(usage.outputTokens)} out
        {usage.cacheReadTokens > 0 && ` · ${number(usage.cacheReadTokens)} cache read`}
        {usage.cacheWriteTokens > 0 && ` · ${number(usage.cacheWriteTokens)} cache write`} · ≈ {formatCost(usage.cost)}
        {usage.unpricedModels.length > 0 && ` (no price for ${usage.unpricedModels.join(', ')})`}
      </p>
    </div>
  )
}

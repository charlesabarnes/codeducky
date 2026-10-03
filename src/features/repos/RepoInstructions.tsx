import { useState } from 'react'
import { MAX_INSTRUCTIONS, repoInstructions } from '../../../shared/instructions'
import { db } from '../../db/db'
import { saveRepoInstructions } from '../../db/repos'
import type { Repo } from '../../db/schema'

/** Free-text review instructions for this repo; they sync and reach Claude through the MCP review prompt. */
export function RepoInstructions({ repo }: { repo: Repo & { id: string } }) {
  const saved = repoInstructions(repo)
  const [draft, setDraft] = useState<string | null>(null)
  const value = draft ?? saved
  const dirty = draft !== null && draft.trim() !== saved

  const save = async () => {
    await saveRepoInstructions(db, repo.id, value)
    setDraft(null)
  }

  return (
    <section className="repo-instructions stack" style={{ gap: '0.4rem' }}>
      <h2>Review instructions</h2>
      <p className="muted">
        Claude reads these through <code className="mono">/mcp__skelbert__review</code> and{' '}
        <code className="mono">get_review_context</code>, e.g. what to skip or conventions this repo follows.
      </p>
      <textarea
        rows={5}
        value={value}
        maxLength={MAX_INSTRUCTIONS}
        aria-label="Review instructions for this repo"
        placeholder="e.g. Never flag generated files under src/gen. Prefer early returns."
        onChange={(event) => setDraft(event.target.value)}
      />
      <div className="row">
        <button type="button" disabled={!dirty} onClick={() => void save()}>
          Save instructions
        </button>
        {dirty && (
          <button type="button" className="secondary" onClick={() => setDraft(null)}>
            Discard
          </button>
        )}
      </div>
    </section>
  )
}

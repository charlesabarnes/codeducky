import { Save, Sparkles } from 'lucide-react'
import { useState } from 'react'
import { MAX_INSTRUCTIONS, repoInstructions } from '../../../shared/instructions'
import { db } from '../../db/db'
import { saveRepoInstructions } from '../../db/repos'
import type { Repo } from '../../db/schema'
import { Panel } from '../../ui/Panel'

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
    <Panel icon={Sparkles} title="review instructions" className="repo-instructions">
      <p>
        Claude reads these through <code>/mcp__codeducky__review</code> and <code>get_review_context</code>, e.g. what to skip or
        conventions this repo follows.
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
          <Save size={13} aria-hidden />
          save instructions
        </button>
        {dirty && (
          <button type="button" className="secondary" onClick={() => setDraft(null)}>
            discard
          </button>
        )}
      </div>
    </Panel>
  )
}

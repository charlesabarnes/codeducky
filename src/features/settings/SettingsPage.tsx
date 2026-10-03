import { useEffect, useState, type FormEvent } from 'react'
import { db } from '../../db/db'
import { DEFAULT_CLAUDE_MODEL, loadSettings, saveSettings, type SettingsInput } from '../../db/settings'
import { TokenTest } from '../github/TokenTest'

type SaveState = 'idle' | 'saving' | 'saved' | 'error'

export function SettingsPage() {
  const [form, setForm] = useState<SettingsInput | null>(null)
  const [saveState, setSaveState] = useState<SaveState>('idle')

  useEffect(() => {
    loadSettings(db).then(({ githubPat, anthropicKey, claudeModel }) =>
      setForm({ githubPat, anthropicKey, claudeModel }),
    )
  }, [])

  if (!form) return <p className="muted">Loading settings…</p>

  const update = (field: keyof SettingsInput) => (value: string) => {
    setForm({ ...form, [field]: value })
    setSaveState('idle')
  }

  const onSubmit = async (event: FormEvent) => {
    event.preventDefault()
    setSaveState('saving')
    try {
      await saveSettings(db, form)
      setSaveState('saved')
    } catch {
      setSaveState('error')
    }
  }

  return (
    <section className="page narrow">
      <h1>Settings</h1>
      <p className="muted">Stored only in this browser (IndexedDB). Nothing is sent anywhere until you use a feature that needs it.</p>
      <form className="stack" onSubmit={onSubmit}>
        <SecretField
          label="GitHub personal access token"
          hint="Fine-grained, with read access to contents and read/write to pull requests."
          value={form.githubPat}
          onChange={update('githubPat')}
        />
        <TokenTest token={form.githubPat} />
        <SecretField
          label="Anthropic API key"
          hint="Used for the optional Claude review pass."
          value={form.anthropicKey}
          onChange={update('anthropicKey')}
        />
        <label className="field">
          <span>Claude model</span>
          <input
            name="claudeModel"
            value={form.claudeModel}
            placeholder={DEFAULT_CLAUDE_MODEL}
            onChange={(e) => update('claudeModel')(e.target.value)}
            spellCheck={false}
          />
        </label>
        <div className="row">
          <button type="submit" disabled={saveState === 'saving'}>
            Save
          </button>
          {saveState === 'saved' && <span className="ok">Saved</span>}
          {saveState === 'error' && <span className="error">Could not save settings</span>}
        </div>
      </form>
    </section>
  )
}

interface SecretFieldProps {
  label: string
  hint: string
  value: string
  onChange: (value: string) => void
}

function SecretField({ label, hint, value, onChange }: SecretFieldProps) {
  const [revealed, setRevealed] = useState(false)
  return (
    <label className="field">
      <span>{label}</span>
      <div className="row">
        <input
          type={revealed ? 'text' : 'password'}
          value={value}
          autoComplete="off"
          spellCheck={false}
          onChange={(e) => onChange(e.target.value)}
        />
        <button type="button" className="secondary" onClick={() => setRevealed(!revealed)}>
          {revealed ? 'Hide' : 'Show'}
        </button>
      </div>
      <small className="muted">{hint}</small>
    </label>
  )
}

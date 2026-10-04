import { Eye, EyeOff, Save, Settings2 } from 'lucide-react'
import { useEffect, useState, type FormEvent } from 'react'
import { StatusBar } from '../../app/chrome'
import { db } from '../../db/db'
import { loadSettings, saveSettings, type LoadedSettings } from '../../db/settings'
import { useSyncState } from '../../sync/client'
import { GithubIcon } from '../../ui/GithubIcon'
import { PageHeader } from '../../ui/PageHeader'
import { Panel } from '../../ui/Panel'
import { TokenTest } from '../github/TokenTest'
import { AppPanels } from '../pwa/AppPanels'
import { ServerSection } from '../sync/ServerSection'
import { AppearancePanel } from './AppearancePanel'

type SaveState = 'idle' | 'saving' | 'saved' | 'error'

export function SettingsPage() {
  const [form, setForm] = useState<LoadedSettings | null>(null)
  const [saveState, setSaveState] = useState<SaveState>('idle')
  const sync = useSyncState()

  useEffect(() => {
    loadSettings(db).then(setForm)
  }, [])

  if (!form) return <p className="page muted">Loading settings…</p>

  const onSubmit = async (event: FormEvent) => {
    event.preventDefault()
    setSaveState('saving')
    try {
      await saveSettings(db, { githubPat: form.githubPat })
      setSaveState('saved')
    } catch {
      setSaveState('error')
    }
  }

  return (
    <section className="page narrow stack settings-page">
      <StatusBar mode="settings">
        <span className="strong">{sync.auth === 'signedIn' ? `signed in as ${sync.deviceName}` : 'local only'}</span>
      </StatusBar>
      <PageHeader icon={Settings2} title="settings">
        <p>Stored only in this browser (IndexedDB). Nothing is sent anywhere until you use a feature that needs it.</p>
      </PageHeader>
      <Panel icon={GithubIcon} title="github">
        <form className="stack" onSubmit={onSubmit}>
          <SecretField
            label="GitHub personal access token"
            hint="Fine-grained, with Contents: read and Pull requests: read and write (plus Commit statuses and Checks: read for CI). For organization repos the organization must be the token's resource owner, or the inbox and pull requests stay empty. Classic tokens need the repo scope."
            value={form.githubPat}
            onChange={(githubPat) => {
              setForm({ ...form, githubPat })
              setSaveState('idle')
            }}
          />
          <TokenTest token={form.githubPat} />
          <div className="row">
            <button type="submit" disabled={saveState === 'saving'}>
              <Save size={13} aria-hidden />
              save
            </button>
            {saveState === 'saved' && <span className="ok">saved</span>}
            {saveState === 'error' && <span className="error">could not save settings</span>}
          </div>
        </form>
      </Panel>
      <AppearancePanel appearance={form} onChange={(next) => setForm({ ...form, ...next })} />
      <AppPanels />
      <ServerSection />
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
    <label className="field secret-field">
      <span>{label}</span>
      <span className="row">
        <input
          type={revealed ? 'text' : 'password'}
          value={value}
          autoComplete="off"
          spellCheck={false}
          onChange={(e) => onChange(e.target.value)}
        />
        <button type="button" className="secondary" onClick={() => setRevealed(!revealed)}>
          {revealed ? <EyeOff size={13} aria-hidden /> : <Eye size={13} aria-hidden />}
          {revealed ? 'hide' : 'show'}
        </button>
      </span>
      <small>{hint}</small>
    </label>
  )
}

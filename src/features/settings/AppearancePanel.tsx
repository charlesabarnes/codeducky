import { Monitor, Moon, Palette as PaletteIcon, Sun } from 'lucide-react'
import { applyAppearance } from '../../app/appearance'
import { db } from '../../db/db'
import type { CodeFont, Density, Palette } from '../../db/schema'
import { saveSettings, type Appearance } from '../../db/settings'
import { Panel } from '../../ui/Panel'
import './settings.css'

const THEMES = [
  { value: 'dark', label: 'dark', icon: Moon },
  { value: 'light', label: 'light', icon: Sun },
  { value: 'system', label: 'system', icon: Monitor },
] as const

const PALETTE_LABELS: Record<Palette, string> = {
  terminal: 'warm ink, red-orange accent',
  fjord: 'cool arctic blues',
  solar: 'solarized teal and cream',
  dusk: 'violet night, pink accent',
  contrast: 'high contrast',
}

const DENSITY_LABELS: Record<Density, string> = { compact: 'compact', default: 'default', comfortable: 'comfortable' }
const CODE_FONT_LABELS: Record<CodeFont, string> = { plex: 'IBM Plex Mono', jetbrains: 'JetBrains Mono', system: 'system mono' }

interface AppearancePanelProps {
  appearance: Appearance
  onChange: (next: Partial<Appearance>) => void
}

export function AppearancePanel({ appearance, onChange }: AppearancePanelProps) {
  const change = (next: Partial<Appearance>) => {
    onChange(next)
    applyAppearance(next)
    saveSettings(db, next).catch((error: unknown) => console.error('Could not save the appearance', error))
  }

  return (
    <Panel icon={PaletteIcon} title="appearance">
      <div className="appearance-grid">
        <span className="muted">theme</span>
        <div className="stack">
          <div className="segmented inverted" role="group" aria-label="Theme">
            {THEMES.map(({ value, label, icon: Icon }) => (
              <button key={value} type="button" aria-pressed={appearance.theme === value} onClick={() => change({ theme: value })}>
                <Icon size={12} aria-hidden />
                {label}
              </button>
            ))}
          </div>
          <p className="muted">System follows your operating system's light or dark setting.</p>
        </div>

        <span className="muted">palette</span>
        <div className="palette-list" role="radiogroup" aria-label="Palette">
          {(Object.keys(PALETTE_LABELS) as Palette[]).map((palette) => (
            <label key={palette} className="palette-option">
              <input type="radio" name="palette" checked={appearance.palette === palette} onChange={() => change({ palette })} />
              <span className="palette-name">{palette}</span>
              <Swatch palette={palette} theme="dark" />
              <Swatch palette={palette} theme="light" />
              <span className="muted">{PALETTE_LABELS[palette]}</span>
            </label>
          ))}
        </div>

        <span className="muted">density</span>
        <Segmented label="Density" labels={DENSITY_LABELS} value={appearance.density} onChange={(density) => change({ density })} />

        <span className="muted">code font</span>
        <div className="stack">
          <Segmented label="Code font" labels={CODE_FONT_LABELS} value={appearance.codeFont} onChange={(codeFont) => change({ codeFont })} />
          <code className="code-sample">{'const total = items.reduce((sum, item) => sum + item.cents, 0) // {}[]0O1lI'}</code>
        </div>
      </div>
    </Panel>
  )
}

interface SegmentedProps<T extends string> {
  label: string
  labels: Record<T, string>
  value: T
  onChange: (value: T) => void
}

function Segmented<T extends string>({ label, labels, value, onChange }: SegmentedProps<T>) {
  return (
    <div className="segmented inverted" role="group" aria-label={label}>
      {(Object.keys(labels) as T[]).map((option) => (
        <button key={option} type="button" aria-pressed={value === option} onClick={() => onChange(option)}>
          {labels[option]}
        </button>
      ))}
    </div>
  )
}

/** The palette's own colours: background, text, accent, added, removed and a keyword. */
function Swatch({ palette, theme }: { palette: Palette; theme: 'dark' | 'light' }) {
  return (
    <span className="swatch" data-palette={palette} data-theme={theme} title={`${palette}, ${theme}`} aria-hidden>
      {['fg', 'accent', 'add', 'del', 'key'].map((part) => (
        <span key={part} className={`swatch-${part}`} />
      ))}
    </span>
  )
}

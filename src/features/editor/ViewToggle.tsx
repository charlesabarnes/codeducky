import { FileDiff, SquarePen } from 'lucide-react'
import { withShortcut } from '../../keys/help'

interface ViewToggleProps {
  editing: boolean
  onChange: (editing: boolean) => void
  dirty?: boolean
  /** Why the file cannot be edited, when it cannot. */
  disabledReason?: string | null
}

/** The file toolbar's "diff | edit" switch. */
export function ViewToggle({ editing, onChange, dirty = false, disabledReason = null }: ViewToggleProps) {
  return (
    <div className="layout-toggle" title={disabledReason ?? withShortcut('Switch between the diff and the editor', 'file.edit')}>
      <div className="segmented inverted" role="group" aria-label="Diff or editor">
        <button type="button" aria-pressed={!editing} aria-keyshortcuts="Shift+E" onClick={() => onChange(false)}>
          <FileDiff size={12} aria-hidden />
          diff
        </button>
        <button type="button" aria-pressed={editing} aria-keyshortcuts="Shift+E" disabled={disabledReason !== null} onClick={() => onChange(true)}>
          <SquarePen size={12} aria-hidden />
          edit
          {dirty && <span className="dirty-mark" aria-label="unsaved changes" />}
        </button>
      </div>
      <span className="key">&nbsp;E</span>
    </div>
  )
}

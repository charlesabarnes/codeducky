import { Keyboard } from 'lucide-react'
import { Fragment, useEffect, useRef } from 'react'
import { helpGroups } from './help'
import type { KeyBinding } from './keymap'
import { formatSequence, isMac } from './tokens'

interface HelpOverlayProps {
  active: ReadonlySet<string>
  enabled: boolean
  onEnabledChange: (enabled: boolean) => void
  onClose: () => void
}

export function HelpOverlay({ active, enabled, onEnabledChange, onClose }: HelpOverlayProps) {
  const dialog = useRef<HTMLDialogElement>(null)
  const groups = helpGroups(active)
  const mod = isMac() ? '⌘' : 'Ctrl'

  useEffect(() => {
    const element = dialog.current
    if (!element || element.open) return
    element.showModal()
    element.focus()
  }, [])

  return (
    <dialog
      ref={dialog}
      tabIndex={-1}
      className="modal help-overlay"
      aria-labelledby="help-title"
      onClose={onClose}
      onClick={(event) => event.target === dialog.current && dialog.current?.close()}
      onKeyDown={(event) => {
        if (event.key === '?') {
          event.preventDefault()
          dialog.current?.close()
        }
      }}
    >
      <header className="modal-bar">
        <Keyboard size={14} aria-hidden />
        <h2 id="help-title">keyboard shortcuts</h2>
        <span className="spacer" />
        <button type="button" className="link" onClick={() => dialog.current?.close()}>
          <span className="key">?</span> or <span className="key">esc</span> close
        </button>
      </header>
      {!enabled && <p className="notice">Single-key shortcuts are off. Only Esc and {mod}+Enter work.</p>}
      <div className="help-groups">
        {groups.map(({ group, bindings }) => (
          <section key={group}>
            <h3>{group}</h3>
            <dl>
              {bindings.map((binding) => (
                <div className="help-row" key={binding.id}>
                  <dt>
                    <Keys binding={binding} />
                  </dt>
                  <dd>{binding.label}</dd>
                </div>
              ))}
            </dl>
          </section>
        ))}
      </div>
      {!active.has('line.next') && <p className="muted help-note">Open a review session for diff and note shortcuts.</p>}
      <footer className="modal-foot">
        <label>
          <input type="checkbox" checked={enabled} onChange={(event) => onEnabledChange(event.target.checked)} />
          single-key shortcuts
        </label>
        <small>Shortcuts never use Ctrl, ⌘ or Alt, except {mod}+Enter, and pause while you type.</small>
      </footer>
    </dialog>
  )
}

function Keys({ binding }: { binding: KeyBinding }) {
  return binding.keys.map((keys, option) => (
    <Fragment key={keys}>
      {option > 0 && <span className="muted"> or </span>}
      {formatSequence(keys).map((chord, step) => (
        <Fragment key={step}>
          {step > 0 && <span className="muted"> then </span>}
          {chord.map((cap, index) => (
            <Fragment key={index}>
              {index > 0 && <span className="muted">+</span>}
              <kbd>{cap}</kbd>
            </Fragment>
          ))}
        </Fragment>
      ))}
    </Fragment>
  ))
}

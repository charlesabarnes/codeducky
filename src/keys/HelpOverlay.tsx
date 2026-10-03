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
    if (element && !element.open) element.showModal()
  }, [])

  return (
    <dialog
      ref={dialog}
      className="help-overlay"
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
      <header className="row">
        <h2 id="help-title">Keyboard shortcuts</h2>
        <span className="spacer" />
        <button type="button" className="secondary" onClick={() => dialog.current?.close()}>
          Close
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
      {!active.has('line.next') && <p className="muted">Open a review session for diff and note shortcuts.</p>}
      <footer className="row">
        <label className="row" style={{ gap: '0.35rem' }}>
          <input type="checkbox" checked={enabled} onChange={(event) => onEnabledChange(event.target.checked)} />
          Single-key shortcuts
        </label>
        <span className="muted">Shortcuts never use Ctrl, ⌘ or Alt, except {mod}+Enter, and pause while you type.</span>
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
              {index > 0 && '+'}
              <kbd>{cap}</kbd>
            </Fragment>
          ))}
        </Fragment>
      ))}
    </Fragment>
  ))
}

import { useContext, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { ChromeContext } from './chromeContext'

/** The page's place, after the header nav: e.g. repo / branch ← base. */
export function Crumbs({ children }: { children: ReactNode }) {
  const { crumbs } = useContext(ChromeContext)
  if (!crumbs) return null
  return createPortal(
    <>
      <span className="crumb-divider" aria-hidden="true">
        │
      </span>
      <div className="crumb-path">{children}</div>
    </>,
    crumbs,
  )
}

export interface StatusHint {
  keys: string
  label: string
}

interface StatusBarProps {
  mode: string
  children?: ReactNode
  hints?: readonly StatusHint[]
}

/** The status line: a mode tag, a few facts about the page, and its most useful keys. */
export function StatusBar({ mode, children, hints }: StatusBarProps) {
  const { status } = useContext(ChromeContext)
  if (!status) return null
  return createPortal(
    <>
      <span className="status-mode">{mode}</span>
      {children}
      {hints && hints.length > 0 && (
        <span className="status-hints">
          {hints.map((hint) => (
            <span key={hint.keys} className="hint">
              <b>{hint.keys}</b> {hint.label}
            </span>
          ))}
        </span>
      )}
    </>,
    status,
  )
}

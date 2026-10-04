import type { ReactNode } from 'react'

interface StepProps {
  number: number
  title: ReactNode
  optional?: boolean
  children: ReactNode
}

/** One numbered setup step, inside an `ol.steps`. */
export function Step({ number, title, optional, children }: StepProps) {
  return (
    <li className="step-item">
      <span className="step-number" aria-hidden="true">
        {number}
      </span>
      <div className="step">
        <span className="step-title">
          {title}
          {optional && <span className="muted step-optional"> (optional)</span>}
        </span>
        {children}
      </div>
    </li>
  )
}

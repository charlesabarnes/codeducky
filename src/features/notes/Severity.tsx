import { Lightbulb, Minus, OctagonAlert, TriangleAlert, type LucideIcon } from 'lucide-react'
import type { NoteSeverity } from '../../db/schema'

export const SEVERITY_ICONS: Record<NoteSeverity, LucideIcon> = {
  nit: Minus,
  suggestion: Lightbulb,
  issue: TriangleAlert,
  blocker: OctagonAlert,
}

export function SeverityLabel({ severity }: { severity: NoteSeverity }) {
  const Icon = SEVERITY_ICONS[severity]
  return (
    <span className={`severity severity-${severity}`}>
      <Icon size={12} aria-hidden />
      {severity}
    </span>
  )
}

import type { LucideIcon } from 'lucide-react'
import type { ReactNode } from 'react'

interface PanelProps {
  icon: LucideIcon
  title: ReactNode
  id?: string
  className?: string
  children: ReactNode
}

/** A bordered section with its title set into the top border. */
export function Panel({ icon: Icon, title, id, className, children }: PanelProps) {
  return (
    <section className={className ? `panel ${className}` : 'panel'} id={id}>
      <h2 className="panel-title">
        <Icon size={13} aria-hidden />
        {title}
      </h2>
      {children}
    </section>
  )
}

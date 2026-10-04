import { ArrowLeft, type LucideIcon } from 'lucide-react'
import type { ReactNode } from 'react'
import { Link } from 'react-router'

interface PageHeaderProps {
  icon: LucideIcon
  title: ReactNode
  back?: { to: string; label: string }
  children?: ReactNode
}

export function PageHeader({ icon: Icon, title, back, children }: PageHeaderProps) {
  return (
    <div className="page-header">
      {back && (
        <Link to={back.to} className="back-link">
          <ArrowLeft size={13} aria-hidden />
          {back.label}
        </Link>
      )}
      <h1>
        <Icon size={16} aria-hidden />
        {title}
      </h1>
      {children}
    </div>
  )
}

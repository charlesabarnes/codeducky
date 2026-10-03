import { Link } from 'react-router'
import { useSyncState } from '../../sync/client'
import { syncSummary } from '../../sync/summary'
import './sync.css'

export function SyncIndicator() {
  const summary = syncSummary(useSyncState())
  return (
    <Link to="/settings#sync" className={`sync-indicator ${summary.tone}`} title={summary.detail || summary.label}>
      <span className="sync-dot" aria-hidden />
      {summary.label}
    </Link>
  )
}

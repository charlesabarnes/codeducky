import { Link } from 'react-router'
import { useSyncState } from '../../sync/client'
import { syncSummary } from '../../sync/summary'
import { SYNC_ICONS } from './syncIcons'
import './sync.css'

export function SyncIndicator() {
  const summary = syncSummary(useSyncState())
  const Icon = SYNC_ICONS[summary.tone]
  return (
    <Link to="/settings#sync" className={`sync-indicator header-item ${summary.tone}`} title={summary.detail || summary.label}>
      <Icon size={14} className="sync-icon" aria-hidden />
      {summary.label.toLowerCase()}
    </Link>
  )
}

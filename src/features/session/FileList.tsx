import type { ChangeStatus, FileChange, FileStats } from '../../git/types'

const BADGES: Record<ChangeStatus, string> = { added: 'A', modified: 'M', deleted: 'D' }

interface FileListProps {
  files: FileChange[]
  stats: Record<string, FileStats>
  selected: string | null
  onSelect: (path: string) => void
}

export function FileList({ files, stats, selected, onSelect }: FileListProps) {
  if (files.length === 0) return <p className="muted" style={{ padding: '1rem' }}>No changes against the base.</p>
  return (
    <ul className="file-list">
      {files.map((file) => (
        <li key={file.path}>
          <button
            type="button"
            aria-current={file.path === selected}
            onClick={() => onSelect(file.path)}
            title={file.path}
          >
            <span className={`status-badge status-${file.status}`} title={file.status}>
              {BADGES[file.status]}
            </span>
            <span className="file-path">
              <bdi>{file.path}</bdi>
            </span>
            <Counts stats={stats[file.path]} />
          </button>
        </li>
      ))}
    </ul>
  )
}

function Counts({ stats }: { stats: FileStats | undefined }) {
  if (!stats) return null
  if ('binary' in stats) return <span className="counts muted">bin</span>
  if ('tooLarge' in stats) return <span className="counts muted">large</span>
  return (
    <span className="counts">
      <span className="add">+{stats.additions}</span>
      <span className="del">−{stats.deletions}</span>
    </span>
  )
}

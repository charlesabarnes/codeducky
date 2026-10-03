import type { ChangeStatus, FileChange, FileStats } from '../../git/types'

const BADGES: Record<ChangeStatus, string> = { added: 'A', modified: 'M', deleted: 'D' }

export interface FileNoteCount {
  open: number
  lost: number
}

interface FileListProps {
  files: FileChange[]
  stats: Record<string, FileStats>
  selected: string | null
  noteCounts: ReadonlyMap<string, FileNoteCount>
  viewed: ReadonlySet<string>
  onSelect: (path: string) => void
  onToggleViewed: (file: FileChange) => void
}

export function FileList({ files, stats, selected, noteCounts, viewed, onSelect, onToggleViewed }: FileListProps) {
  if (files.length === 0) return <p className="muted" style={{ padding: '1rem' }}>No changes against the base.</p>
  return (
    <ul className="file-list">
      {files.map((file) => (
        <li key={file.path} className={viewed.has(file.path) ? 'viewed' : undefined}>
          <input
            type="checkbox"
            checked={viewed.has(file.path)}
            onChange={() => onToggleViewed(file)}
            aria-label={`Mark ${file.path} as viewed`}
            title="Viewed"
          />
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
            <NoteCount count={noteCounts.get(file.path)} />
            <Counts stats={stats[file.path]} />
          </button>
        </li>
      ))}
    </ul>
  )
}

function NoteCount({ count }: { count: FileNoteCount | undefined }) {
  if (!count || count.open === 0) return null
  const title = `${count.open} open ${count.open === 1 ? 'note' : 'notes'}${count.lost ? `, ${count.lost} possibly resolved` : ''}`
  return (
    <span className={`note-count${count.lost ? ' lost' : ''}`} title={title}>
      {count.open}
    </span>
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

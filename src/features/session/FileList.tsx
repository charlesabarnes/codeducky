import type { Ref } from 'react'
import type { ChangeStatus, FileChange, FileStats } from '../../git/types'

const BADGES: Record<ChangeStatus, string> = { added: 'A', modified: 'M', deleted: 'D' }

export interface FileNoteCount {
  open: number
  lost: number
}

interface FileListProps {
  /** The files that match the filter. */
  files: FileChange[]
  total: number
  filter: string
  onFilterChange: (filter: string) => void
  filterRef: Ref<HTMLInputElement>
  stats: Record<string, FileStats>
  selected: string | null
  noteCounts: ReadonlyMap<string, FileNoteCount>
  viewed: ReadonlySet<string>
  onSelect: (path: string) => void
  onToggleViewed: (file: FileChange) => void
}

export function FileList(props: FileListProps) {
  const { files, total, filter, onFilterChange, filterRef, onSelect } = props
  if (total === 0) return <p className="muted" style={{ padding: '1rem' }}>No changes against the base.</p>
  return (
    <>
      <div className="file-filter">
        <input
          ref={filterRef}
          type="text"
          value={filter}
          placeholder="Filter files"
          aria-label="Filter files"
          aria-keyshortcuts="/"
          title="Filter files (/). Enter opens the first match, Esc leaves the field."
          spellCheck={false}
          autoComplete="off"
          onChange={(event) => onFilterChange(event.target.value)}
          onKeyDown={(event) => {
            if (event.key !== 'Enter' || !files[0]) return
            onSelect(files[0].path)
            event.currentTarget.blur()
          }}
        />
        {filter && (
          <span className="muted" aria-live="polite">
            {files.length}/{total}
          </span>
        )}
      </div>
      {files.length === 0 ? (
        <p className="muted" style={{ padding: '0 1rem' }}>No files match.</p>
      ) : (
        <FileRows {...props} />
      )}
    </>
  )
}

function FileRows({ files, stats, selected, noteCounts, viewed, onSelect, onToggleViewed }: FileListProps) {
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

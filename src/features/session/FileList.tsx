import { MessageSquare, Search } from 'lucide-react'
import type { Ref } from 'react'
import { changeKind, type ChangeKind, type FileChange, type FileStats } from '../../git/types'
import type { FileOrder, Risk } from '../../review/order'
import type { FileBadge } from '../modes/useReviewMode'
import { pathParts } from './renames'
import './session.css'

const BADGES: Record<ChangeKind, string> = { added: 'A', modified: 'M', deleted: 'D', renamed: 'R' }
const ORDER_LABELS: Record<FileOrder, { label: string; title: string }> = {
  folders: { label: 'folders', title: 'Folder order, with tests next to their source' },
  risk: { label: 'risk', title: 'Riskiest first: size, new files, sensitive paths, deleted tests and open notes' },
}

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
  order: FileOrder
  onOrderChange: (order: FileOrder) => void
  /** Scores behind the risk order, when it is on. */
  risks: ReadonlyMap<string, Risk> | null
  /** Per-file badges, e.g. what changed since the last look. */
  badges?: ReadonlyMap<string, FileBadge> | null
  /** Files that can be marked viewed (in commit mode, only those in the branch's diff). */
  canView?: (path: string) => boolean
}

export function FileList(props: FileListProps) {
  const { files, total, filter, onFilterChange, filterRef, onSelect, order, onOrderChange } = props
  if (total === 0) return <p className="muted panel-message">No changes against the base.</p>
  return (
    <>
      <div className="file-filter">
        <Search size={13} aria-hidden />
        <input
          ref={filterRef}
          type="text"
          value={filter}
          placeholder="filter files  ( / )"
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
        <div className="segmented order-toggle" role="group" aria-label="File order">
          {(['folders', 'risk'] as const).map((option) => (
            <button
              key={option}
              type="button"
              aria-pressed={order === option}
              title={ORDER_LABELS[option].title}
              onClick={() => onOrderChange(option)}
            >
              {ORDER_LABELS[option].label}
            </button>
          ))}
        </div>
      </div>
      {files.length === 0 ? (
        <p className="muted panel-message">No files match.</p>
      ) : (
        <FileRows {...props} />
      )}
    </>
  )
}

function rowTitle(file: FileChange, risk: Risk | undefined): string {
  const lines = [file.path]
  if (file.oldPath) lines.push(`Renamed from ${file.oldPath}${file.similarity === undefined ? '' : ` (${file.similarity}% similar)`}`)
  if (risk?.reasons.length) lines.push(`Risk: ${risk.reasons.join(', ')}`)
  return lines.join('\n')
}

function FileRows({ files, stats, selected, noteCounts, viewed, onSelect, onToggleViewed, risks, badges, canView }: FileListProps) {
  return (
    <ul className="file-list">
      {files.map((file) => {
        const kind = changeKind(file)
        const badge = badges?.get(file.path)
        const className = [viewed.has(file.path) && 'viewed', file.path === selected && 'current'].filter(Boolean).join(' ')
        return (
          <li key={file.path} className={className || undefined}>
            <input
              type="checkbox"
              checked={viewed.has(file.path)}
              onChange={() => onToggleViewed(file)}
              disabled={canView ? !canView(file.path) : false}
              aria-label={`Mark ${file.path} as viewed`}
              title={canView && !canView(file.path) ? 'Not in the branch’s final diff' : 'Viewed'}
            />
            <button
              type="button"
              aria-current={file.path === selected}
              onClick={() => onSelect(file.path)}
              title={rowTitle(file, risks?.get(file.path))}
            >
              <span className={`status-badge status-${kind}`} title={kind}>
                {BADGES[kind]}
              </span>
              <span className="file-path">
                <SplitPath path={file.path} oldPath={file.oldPath} />
              </span>
              <span className="file-extras">
                {file.similarity !== undefined && file.similarity < 100 && <span className="similarity">{file.similarity}%</span>}
                {badge && (
                  <span className={`file-badge since-${badge.kind}`} title={badge.title}>
                    {badge.label}
                  </span>
                )}
                <NoteCount count={noteCounts.get(file.path)} />
              </span>
              <Counts stats={stats[file.path]} />
            </button>
          </li>
        )
      })}
    </ul>
  )
}

/** A path with its folders dimmed; a rename shows git's short form. */
export function SplitPath({ path, oldPath }: { path: string; oldPath?: string }) {
  const { dir, name } = pathParts(path, oldPath)
  return (
    <>
      <span className="file-dir">
        <bdi>{dir}</bdi>
      </span>
      <span className="file-name">{name}</span>
    </>
  )
}

function NoteCount({ count }: { count: FileNoteCount | undefined }) {
  if (!count || count.open === 0) return null
  const title = `${count.open} open ${count.open === 1 ? 'note' : 'notes'}${count.lost ? `, ${count.lost} possibly resolved` : ''}`
  return (
    <span className={`note-count${count.lost ? ' lost' : ''}`} title={title}>
      <MessageSquare size={11} aria-hidden />
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

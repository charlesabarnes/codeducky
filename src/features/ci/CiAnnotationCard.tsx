import type { UnplacedAnnotation } from '../../github/ci'
import type { AnnotationLevel, CheckAnnotation, CheckRun } from '../../github/types'
import './ci.css'

const LEVEL_LABEL: Record<AnnotationLevel, string> = { failure: 'Failure', warning: 'Warning', notice: 'Notice' }
const LEVEL_ICON: Record<AnnotationLevel, string> = { failure: '✕', warning: '!', notice: 'i' }

const lineSpan = ({ startLine, endLine }: CheckAnnotation) => (endLine > startLine ? `lines ${startLine}–${endLine}` : `line ${startLine}`)

export function CiAnnotationCard({ annotation, run, showWhere }: { annotation: CheckAnnotation; run?: CheckRun; showWhere?: boolean }) {
  const link = run?.htmlUrl ?? run?.detailsUrl
  return (
    <div className={`ci-annotation level-${annotation.level}`}>
      <div className="ci-annotation-head">
        <span className="ci-level" aria-hidden="true">
          {LEVEL_ICON[annotation.level]}
        </span>
        <strong>{LEVEL_LABEL[annotation.level]}</strong>
        {annotation.title && <span className="ci-title">{annotation.title}</span>}
        {showWhere && (
          <span className="muted mono">
            {annotation.path}:{annotation.startLine}
          </span>
        )}
        <span className="spacer" />
        {run &&
          (link ? (
            <a href={link} target="_blank" rel="noreferrer" className="muted">
              {run.name}
            </a>
          ) : (
            <span className="muted">{run.name}</span>
          ))}
      </div>
      <div className="ci-message">{annotation.message}</div>
      {annotation.rawDetails && (
        <details className="ci-details">
          <summary>Details</summary>
          <pre>{annotation.rawDetails}</pre>
        </details>
      )}
    </div>
  )
}

interface UnplacedProps {
  items: readonly UnplacedAnnotation[]
  runs: ReadonlyMap<number, CheckRun>
}

/** Annotations for this file that cannot sit on a line of the diff. */
export function UnplacedAnnotations({ items, runs }: UnplacedProps) {
  if (items.length === 0) return null
  return (
    <section className="ci-unplaced" aria-label="CI annotations not on the diff">
      <h3>
        CI annotations not on the diff <span className="muted">({items.length})</span>
      </h3>
      {items.map(({ annotation, reason }, index) => (
        <div key={index} className="stack" style={{ gap: '0.15rem' }}>
          <span className="muted">
            {lineSpan(annotation)} · {reason}
          </span>
          <CiAnnotationCard annotation={annotation} run={runs.get(annotation.checkRunId)} />
        </div>
      ))}
    </section>
  )
}

import { runState } from '../../github/ci'
import type { CheckRun } from '../../github/types'
import { CiAnnotationCard } from './CiAnnotationCard'
import type { CiView } from './useCiStatus'
import './ci.css'

const RUN_ICON = { pass: '✓', fail: '✕', pending: '●', skipped: '–' } as const
const RUN_LABEL = { pass: 'passed', fail: 'failed', pending: 'running', skipped: 'skipped' } as const
const CHIP_ICON = { pass: '✓', fail: '✕', pending: '●', none: '○', error: '○' } as const

function chipText(view: CiView): { state: keyof typeof CHIP_ICON; text: string } | null {
  const { status, summary } = view
  switch (status.kind) {
    case 'off':
    case 'loading':
      return null
    case 'not-pushed':
      return { state: 'none', text: 'No checks: HEAD is not on GitHub' }
    case 'error':
      return { state: 'error', text: 'Checks unavailable' }
    case 'ready':
      if (!summary || summary.state === 'none') return { state: 'none', text: 'No checks' }
      if (summary.state === 'fail') return { state: 'fail', text: `${summary.failed} failing` }
      if (summary.state === 'pending') return { state: 'pending', text: `${summary.pending} running` }
      return { state: 'pass', text: `${summary.passed} passed` }
  }
}

function RunRow({ run }: { run: CheckRun }) {
  const state = runState(run)
  const link = run.htmlUrl ?? run.detailsUrl
  const label = run.status === 'completed' ? (run.conclusion ?? 'done').replace('_', ' ') : RUN_LABEL[state]
  return (
    <li className={`ci-run run-${state}`}>
      <span className="ci-run-icon" aria-hidden="true">
        {RUN_ICON[state]}
      </span>
      {link ? (
        <a href={link} target="_blank" rel="noreferrer">
          {run.name}
        </a>
      ) : (
        <span>{run.name}</span>
      )}
      <span className="muted">{label}</span>
      {run.annotationsCount > 0 && <span className="muted">· {run.annotationsCount} annotations</span>}
    </li>
  )
}

/** The CI status chip in the session header; opens a list of check runs. */
export function CiChip({ view }: { view: CiView }) {
  const chip = chipText(view)
  if (!chip) return null
  const { status } = view
  const runs = status.kind === 'ready' ? status.snapshot.runs : []
  const elsewhere = view.annotations.elsewhere
  return (
    <details className="ci-chip-wrap">
      <summary className={`ci-chip state-${chip.state}`} title="CI checks for HEAD">
        <span aria-hidden="true">{CHIP_ICON[chip.state]}</span> CI {chip.text}
      </summary>
      <div className="ci-popover">
        {status.kind === 'error' && <p className="error">{status.message}</p>}
        {status.kind === 'not-pushed' && (
          <p className="muted">
            GitHub has no commit <span className="mono">{status.sha.slice(0, 7)}</span>. Push the branch to see its checks.
          </p>
        )}
        {status.kind === 'ready' && (
          <>
            <p className="muted">
              Checks for <span className="mono">{status.snapshot.sha.slice(0, 7)}</span>
              {view.summary?.state === 'pending' && ', refreshing while they run'}
            </p>
            {runs.length === 0 ? <p className="muted">No check runs reported for this commit.</p> : <ul className="ci-runs">{runs.map((run) => <RunRow key={run.id} run={run} />)}</ul>}
            {elsewhere.length > 0 && (
              <div className="stack" style={{ gap: '0.35rem' }}>
                <h3>Annotations outside the changed files ({elsewhere.length})</h3>
                {elsewhere.map((annotation, index) => (
                  <CiAnnotationCard key={index} annotation={annotation} run={view.runs.get(annotation.checkRunId)} showWhere />
                ))}
              </div>
            )}
          </>
        )}
      </div>
    </details>
  )
}

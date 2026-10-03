import { useMemo } from 'react'
import type { LineAnnotations } from '../../diff/DiffTable'
import { lineKey } from '../../diff/hunks'
import { placeAnnotations, type PlacedAnnotations } from '../../github/ci'
import { CiAnnotationCard } from './CiAnnotationCard'
import type { CiView } from './useCiStatus'

const NONE: PlacedAnnotations = { byLine: new Map(), unplaced: [] }

/**
 * Layers the file's CI annotations onto its note annotations: annotated lines stay visible
 * (pinned) and each shows its annotations above any notes.
 */
export function useCiAnnotations(
  ci: CiView,
  path: string,
  newLineCount: number | null,
  notes: LineAnnotations,
): { annotations: LineAnnotations; placed: PlacedAnnotations } {
  const list = ci.annotations.byPath.get(path)
  const dirty = ci.dirty.has(path)
  const placed = useMemo(
    () => (list ? placeAnnotations(list, { newLineCount, matchesCheckedCommit: !dirty }) : NONE),
    [list, newLineCount, dirty],
  )
  const pinned = useMemo(() => {
    if (placed.byLine.size === 0) return notes.pinned
    return new Set([...notes.pinned, ...[...placed.byLine.keys()].map((line) => lineKey('new', line))])
  }, [notes.pinned, placed])

  if (placed.byLine.size === 0) return { annotations: notes, placed }
  return {
    placed,
    annotations: {
      ...notes,
      pinned,
      render: (side, line) => {
        const noteRows = notes.render(side, line)
        const here = side === 'new' ? placed.byLine.get(line) : undefined
        if (!here) return noteRows
        return (
          <div key={`ci-${line}`}>
            <div className="line-ci">
              {here.map((annotation, index) => (
                <CiAnnotationCard key={index} annotation={annotation} run={ci.runs.get(annotation.checkRunId)} />
              ))}
            </div>
            {noteRows}
          </div>
        )
      },
    },
  }
}

import { useMemo } from 'react'
import type { LineAnnotations } from '../../diff/DiffTable'
import { lineKey } from '../../diff/hunks'
import { placeThreads, type ReviewThread } from '../../github/threads'
import { ThreadCard, type ThreadActions } from './ThreadCard'

/** Layers a file's review threads onto its other line annotations: threaded lines stay visible and show threads first. */
export function useThreadAnnotations(threads: readonly ReviewThread[] | null, actions: ThreadActions | null, base: LineAnnotations) {
  const placed = useMemo(() => placeThreads(threads ?? []), [threads])
  const pinned = useMemo(
    () => (placed.byLine.size === 0 ? base.pinned : new Set([...base.pinned, ...placed.byLine.keys()])),
    [base.pinned, placed],
  )
  if (!actions || placed.byLine.size === 0) return { annotations: base, listed: placed.listed }
  return {
    listed: placed.listed,
    annotations: {
      ...base,
      pinned,
      render: (side, line) => {
        const rest = base.render(side, line)
        const here = placed.byLine.get(lineKey(side, line))
        if (!here) return rest
        return (
          <div key={`threads-${side}-${line}`}>
            <div className={`line-threads side-${side}`}>
              {here.map((thread) => (
                <ThreadCard key={thread.id} thread={thread} actions={actions} />
              ))}
            </div>
            {rest}
          </div>
        )
      },
    } satisfies LineAnnotations,
  }
}

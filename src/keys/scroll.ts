export type ScrollMode = 'nearest' | 'center' | 'none'

export interface Span {
  top: number
  bottom: number
}

/**
 * How far to scroll so the target sits comfortably in view. "nearest" keeps a margin like
 * vim's scrolloff and moves only as much as needed, so holding j scrolls line by line.
 * "center" is for jumps: anything outside the comfortable zone lands a third of the way down.
 */
export function scrollDelta(target: Span, view: Span, mode: ScrollMode): number {
  if (mode === 'none') return 0
  const height = view.bottom - view.top
  const margin = Math.min(height * 0.2, 160)
  const zoneTop = view.top + margin
  const zoneBottom = view.bottom - margin
  const inside = target.top >= zoneTop && target.bottom <= zoneBottom
  if (inside) return 0
  if (mode === 'center') return target.top - (view.top + height / 3)
  if (target.bottom - target.top > zoneBottom - zoneTop || target.top < zoneTop) return target.top - zoneTop
  return target.bottom - zoneBottom
}

function scrollParent(element: HTMLElement): HTMLElement {
  for (let node = element.parentElement; node; node = node.parentElement) {
    const { overflowY } = getComputedStyle(node)
    if (/(auto|scroll)/.test(overflowY) && node.scrollHeight > node.clientHeight) return node
  }
  return (document.scrollingElement as HTMLElement | null) ?? document.documentElement
}

/** Scrolls the nearest scrolling ancestor instantly, leaving room for a [data-sticky-header]. */
export function revealElement(element: HTMLElement, mode: ScrollMode): void {
  if (mode === 'none') return
  const parent = scrollParent(element)
  const isRoot = parent === document.scrollingElement || parent === document.documentElement
  const box = isRoot ? { top: 0, bottom: window.innerHeight } : parent.getBoundingClientRect()
  const sticky = parent.querySelector<HTMLElement>('[data-sticky-header]')
  const view = { top: box.top + (sticky?.offsetHeight ?? 0), bottom: box.bottom }
  const rect = element.getBoundingClientRect()
  const delta = scrollDelta({ top: rect.top, bottom: rect.bottom }, view, mode)
  if (delta !== 0) parent.scrollTop += delta
}

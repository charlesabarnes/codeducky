import { createContext, useContext } from 'react'
import type { Cursor } from './diffNav'
import type { ScrollMode } from './scroll'

/** Where a freshly shown diff should put its cursor: after n/p crossed files, a note jump or a moved-block link. */
export interface NavRequest {
  at: number
  target: 'first-change' | 'last-change' | Cursor
  /** How to bring a line target into view; note jumps scroll to the note themselves. */
  scroll?: ScrollMode
}

export interface DiffNavApi {
  request: NavRequest | null
  /** n/p ran past the first or last change: move to another file. Returns false if there is none. */
  onBoundary: (direction: 1 | -1) => boolean
}

const NONE: DiffNavApi = { request: null, onBoundary: () => false }

export const DiffNavContext = createContext<DiffNavApi>(NONE)

export const useDiffNavContext = () => useContext(DiffNavContext)

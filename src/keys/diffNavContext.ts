import { createContext, useContext } from 'react'
import type { Cursor } from './diffNav'

/** Where a freshly shown diff should put its cursor: after n/p crossed files, or a note jump. */
export interface NavRequest {
  at: number
  target: 'first-change' | 'last-change' | Cursor
}

export interface DiffNavApi {
  request: NavRequest | null
  /** n/p ran past the first or last change: move to another file. Returns false if there is none. */
  onBoundary: (direction: 1 | -1) => boolean
}

const NONE: DiffNavApi = { request: null, onBoundary: () => false }

export const DiffNavContext = createContext<DiffNavApi>(NONE)

export const useDiffNavContext = () => useContext(DiffNavContext)

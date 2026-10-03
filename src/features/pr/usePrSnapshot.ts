import { useEffect, useState } from 'react'
import type { GitHubClient } from '../../github/client'
import { githubClient } from '../../github/connect'
import { errorMessage, isGitHubError } from '../../github/errors'
import { loadPrSnapshot, type PrSnapshot } from '../../github/prDiff'
import type { RepoRef } from '../../github/types'

export type SnapshotState =
  | { status: 'loading' }
  | { status: 'no-token' }
  | { status: 'error'; message: string; notFound: boolean }
  | { status: 'ready'; gh: GitHubClient; snapshot: PrSnapshot }

const FRESH_MS = 30_000
const recent = new Map<string, { at: number; snapshot: Promise<PrSnapshot> }>()

/** Loads a pull request, reusing one fetched in the last few seconds (the deep link page and the session share it). */
export function fetchSnapshot(gh: GitHubClient, ref: RepoRef, number: number, force = false): Promise<PrSnapshot> {
  const key = `${ref.owner}/${ref.name}#${number}`.toLowerCase()
  const cached = recent.get(key)
  if (!force && cached && Date.now() - cached.at < FRESH_MS) return cached.snapshot
  const snapshot = loadPrSnapshot(gh, ref, number)
  recent.set(key, { at: Date.now(), snapshot })
  snapshot.catch(() => recent.delete(key))
  return snapshot
}

export function usePrSnapshot(ref: RepoRef | null, number: number, refreshKey: number): SnapshotState {
  const [state, setState] = useState<SnapshotState>({ status: 'loading' })
  const owner = ref?.owner
  const name = ref?.name
  useEffect(() => {
    if (!owner || !name) return
    let cancelled = false
    const run = async () => {
      const gh = await githubClient()
      if (!gh) return !cancelled && setState({ status: 'no-token' })
      const snapshot = await fetchSnapshot(gh, { owner, name }, number, refreshKey > 0)
      if (!cancelled) setState({ status: 'ready', gh, snapshot })
    }
    run().catch(
      (error: unknown) =>
        !cancelled && setState({ status: 'error', message: errorMessage(error), notFound: isGitHubError(error, 'not-found') }),
    )
    return () => {
      cancelled = true
    }
  }, [owner, name, number, refreshKey])
  return state
}

import { useCallback, useEffect, useState } from 'react'
import { githubClient } from '../../github/connect'
import { errorMessage } from '../../github/errors'
import { fetchThreads, replyToThread, setThreadResolved, type PullThreads, type ReviewThread } from '../../github/threads'
import type { RepoRef } from '../../github/types'

export interface PrThreadsApi {
  data: PullThreads | null
  error: string | null
  loading: boolean
  reload: () => void
  reply: (thread: ReviewThread, body: string) => Promise<void>
  setResolved: (thread: ReviewThread, resolved: boolean) => Promise<void>
}

/** The pull request's review threads and your pending review, with reply and resolve that update in place. */
export function usePrThreads(ref: RepoRef, number: number, refreshKey: string): PrThreadsApi {
  const [data, setData] = useState<PullThreads | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [generation, setGeneration] = useState(0)
  const { owner, name } = ref
  const requestKey = `${owner}/${name}#${number}:${refreshKey}:${generation}`
  const [loadedKey, setLoadedKey] = useState<string | null>(null)
  const loading = loadedKey !== requestKey

  useEffect(() => {
    let cancelled = false
    githubClient()
      .then(async (gh) => {
        if (!gh) throw new Error('Set a GitHub token in Settings to load review threads.')
        const result = await fetchThreads(gh, { owner, name }, number)
        if (!cancelled) {
          setData(result)
          setError(null)
        }
      })
      .catch((err: unknown) => !cancelled && setError(errorMessage(err)))
      .finally(() => !cancelled && setLoadedKey(requestKey))
    return () => {
      cancelled = true
    }
  }, [owner, name, number, requestKey])

  const update = (id: string, change: (thread: ReviewThread) => ReviewThread) =>
    setData((current) => current && { ...current, threads: current.threads.map((thread) => (thread.id === id ? change(thread) : thread)) })

  const reply = async (thread: ReviewThread, body: string) => {
    const gh = await githubClient()
    if (!gh) throw new Error('Set a GitHub token in Settings first.')
    const comment = await replyToThread(gh, thread.id, body)
    update(thread.id, (current) => ({ ...current, comments: [...current.comments, comment] }))
  }

  const setResolved = async (thread: ReviewThread, resolved: boolean) => {
    const gh = await githubClient()
    if (!gh) throw new Error('Set a GitHub token in Settings first.')
    update(thread.id, (current) => ({ ...current, isResolved: resolved }))
    try {
      const now = await setThreadResolved(gh, thread.id, resolved)
      update(thread.id, (current) => ({
        ...current,
        isResolved: now,
        resolvedBy: now ? (data?.viewer ?? current.resolvedBy) : null,
        canResolve: !now,
        canUnresolve: now,
      }))
    } catch (err) {
      update(thread.id, (current) => ({ ...current, isResolved: !resolved }))
      throw err
    }
  }

  const reload = useCallback(() => setGeneration((n) => n + 1), [])
  return { data, error, loading, reload, reply, setResolved }
}

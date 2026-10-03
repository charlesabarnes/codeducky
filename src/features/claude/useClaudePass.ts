import { useCallback, useEffect, useRef, useState } from 'react'
import type { PassProgress } from '../../claude/pass'
import type { FileChange } from '../../git/types'

interface RunOptions {
  sessionId: string
  apiKey: string
  model: string
  instructions?: string
  files: FileChange[]
  carryUsage?: boolean
}

export function useClaudePass() {
  const [progress, setProgress] = useState<PassProgress | null>(null)
  const [error, setError] = useState<string | null>(null)
  const controller = useRef<AbortController | null>(null)
  const latest = useRef<PassProgress | null>(null)

  useEffect(() => () => controller.current?.abort(), [])

  const run = useCallback(async ({ carryUsage, ...options }: RunOptions) => {
    controller.current?.abort()
    const current = new AbortController()
    controller.current = current
    setError(null)
    const usage = carryUsage ? latest.current?.usage : undefined
    try {
      const { startClaudePass } = await import('../../claude/run')
      await startClaudePass({
        ...options,
        usage,
        signal: current.signal,
        onProgress: (next) => {
          if (controller.current !== current) return
          latest.current = next
          setProgress(next)
        },
      })
    } catch (err) {
      if (controller.current === current) setError(err instanceof Error ? err.message : String(err))
    }
  }, [])

  const cancel = useCallback(() => controller.current?.abort(), [])

  return { progress, error, running: progress?.status === 'running', run, cancel }
}

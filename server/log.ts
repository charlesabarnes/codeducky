import type { ErrorHandler, MiddlewareHandler } from 'hono'

export type LogEntry = Record<string, string | number>
export type LogSink = (entry: LogEntry) => void

export const stdoutSink: LogSink = (entry) => console.log(JSON.stringify(entry))
export const silentSink: LogSink = () => undefined

/** One line per request: method, path, status and duration. Bodies and headers (tokens) are never read. */
export function requestLog(sink: LogSink, clock = () => performance.now()): MiddlewareHandler {
  return async (c, next) => {
    const start = clock()
    await next()
    sink({
      level: c.res.status >= 500 ? 'error' : 'info',
      method: c.req.method,
      path: c.req.path,
      status: c.res.status,
      ms: Math.round((clock() - start) * 10) / 10,
    })
  }
}

export function logErrors(sink: LogSink): ErrorHandler {
  return (err, c) => {
    sink({ level: 'error', method: c.req.method, path: c.req.path, error: err.message, stack: err.stack ?? '' })
    return c.json({ error: 'internal' }, 500)
  }
}

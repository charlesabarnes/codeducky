import type { MiddlewareHandler } from 'hono'
import { extname, resolve, sep } from 'node:path'

const IMMUTABLE = 'public, max-age=31536000, immutable'
const NO_CACHE = 'no-cache'

/** Vite fingerprints everything under /assets; the service worker, manifest and index.html must revalidate. */
export const cacheControl = (pathname: string) => (pathname.startsWith('/assets/') ? IMMUTABLE : NO_CACHE)

const SERVER_PREFIXES = ['/api', '/mcp', '/oauth', '/.well-known', '/gate']
const isServerPath = (path: string) => SERVER_PREFIXES.some((prefix) => path === prefix || path.startsWith(`${prefix}/`))

/** Serves the built PWA: files by path, extension-less paths fall back to index.html, missing files are 404. */
export function serveWeb(webDist: string): MiddlewareHandler {
  const root = resolve(webDist)
  return async (c, next) => {
    const method = c.req.method
    if ((method !== 'GET' && method !== 'HEAD') || isServerPath(c.req.path)) return next()

    let pathname: string
    try {
      pathname = decodeURIComponent(c.req.path)
    } catch {
      return c.text('Bad Request', 400)
    }
    const isFile = extname(pathname) !== ''
    const target = isFile ? resolve(root, `.${pathname}`) : resolve(root, 'index.html')
    if (!target.startsWith(root + sep)) return c.text('Not Found', 404)

    const file = Bun.file(target)
    if (!(await file.exists())) return c.text('Not Found', 404)
    const headers: Record<string, string> = {
      'Content-Type': file.type,
      'Content-Length': String(file.size),
      'Cache-Control': isFile ? cacheControl(pathname) : NO_CACHE,
      'X-Content-Type-Options': 'nosniff',
    }
    if (pathname === '/sw.js') headers['Service-Worker-Allowed'] = '/'
    return new Response(method === 'HEAD' ? null : file, { headers })
  }
}

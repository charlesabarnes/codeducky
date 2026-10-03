import type { Database } from 'bun:sqlite'
import { Hono } from 'hono'
import { requireToken, type AuthEnv } from '../auth/middleware'
import type { TokenStore } from '../auth/tokens'
import { loadData } from '../mcp/records'
import { publicOrigin } from '../origin'
import { evaluateGate, gateText } from './gate'
import { isGateScript, renderScript } from './scripts'

interface GateOptions {
  db: Database
  tokens: TokenStore
  publicUrl?: string
}

/** `GET /api/gate`: whether a push of repo@branch may go ahead. Settings tokens and OAuth tokens only. */
export function gateApi({ db, tokens, publicUrl }: GateOptions) {
  const api = new Hono<AuthEnv>()
  api.get('/', requireToken(tokens, ['api', 'oauth']), (c) => {
    const repo = c.req.query('repo')?.trim()
    const branch = c.req.query('branch')?.trim()
    if (!repo || !branch) return c.json({ error: 'repo (owner/name) and branch are required' }, 400)
    const result = evaluateGate(loadData(db), repo, branch, publicOrigin(c, publicUrl))
    c.header('Cache-Control', 'no-store')
    if (c.req.query('format') === 'text') return c.text(gateText(result))
    return c.json(result)
  })
  return api
}

/** `GET /gate/<script>`: the hook scripts, with this server baked in as the default URL. No secrets inside. */
export function gateScripts(publicUrl?: string) {
  const routes = new Hono()
  routes.get('/gate/:script', (c) => {
    const name = c.req.param('script')
    if (!isGateScript(name)) return c.text('Not Found', 404)
    c.header('Content-Type', 'text/x-shellscript; charset=utf-8')
    c.header('Cache-Control', 'no-cache')
    c.header('X-Content-Type-Options', 'nosniff')
    return c.body(renderScript(name, publicOrigin(c, publicUrl)))
  })
  return routes
}

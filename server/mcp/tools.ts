import type { Database } from 'bun:sqlite'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import { z } from 'zod'
import { uuidv7 } from '../../shared/ids'
import { pairId } from '../../shared/sync'
import {
  currentSession,
  InvalidRecordError,
  loadData,
  repoLabel,
  repoMatches,
  saveRecord,
  type DataSnapshot,
  type NoteRecord,
  type RepoRecord,
  type SessionRecord,
} from './records'
import { reviewContext } from '../review/context'
import { registerPrompts } from './prompts'
import { checklistView, compareNotes, iso, noteView } from './views'

export const SERVER_INSTRUCTIONS = `Skelbert holds the owner's self-review of their git branches: review sessions per repo and branch, line notes, and checklists.
To work on the checkout you are in, use repo "owner/name" (from the git remote) and the current branch; get_review_context returns the repo's review instructions, checklists, changed files, open notes and recurring past findings in one call.
Tools that take a session also accept repo + branch instead. Notes you add arrive as suggestions the owner accepts or dismisses; resolve_note closes a note with your reply.
The review prompt reviews a branch and adds notes; the fix prompt fixes open notes and resolves them.`

const SEVERITIES = ['nit', 'suggestion', 'issue', 'blocker'] as const
const STATUSES = ['open', 'resolved', 'suggested', 'dismissed'] as const
const SOURCES = ['me', 'claude', 'mcp'] as const
const MAX_CONTEXT = 10

const json = (value: unknown): CallToolResult => ({ content: [{ type: 'text', text: JSON.stringify(value, null, 2) }] })
const fail = (message: string): CallToolResult => ({ isError: true, content: [{ type: 'text', text: message }] })

class ToolError extends Error {}

/** Runs a handler, turning expected failures into tool errors the model can read and act on. */
function guarded<A>(handler: (args: A) => CallToolResult) {
  return (args: A): CallToolResult => {
    try {
      return handler(args)
    } catch (error) {
      if (error instanceof ToolError || error instanceof InvalidRecordError) return fail(error.message)
      throw error
    }
  }
}

const sessionTarget = {
  session: z.string().optional().describe('Session id. Alternatively give repo and branch.'),
  repo: z.string().optional().describe('Repository as "owner/name" (case-insensitive), or a repo id.'),
  branch: z.string().optional().describe('Branch name; with repo, selects that branch\'s current session.'),
}

function findRepos(data: DataSnapshot, query: string): RepoRecord[] {
  const found = data.repos.filter((repo) => repoMatches(repo, query))
  if (found.length === 0) {
    const known = data.repos.map(repoLabel).sort().join(', ') || 'none'
    throw new ToolError(`No repo matches "${query}". Known repos: ${known}.`)
  }
  return found
}

function resolveSession(data: DataSnapshot, target: { session?: string; repo?: string; branch?: string }): SessionRecord {
  if (target.session) {
    const session = data.sessions.find((s) => s.id === target.session)
    if (!session) throw new ToolError(`No session with id ${target.session}. Use list_sessions to find one.`)
    return session
  }
  if (!target.repo || !target.branch) throw new ToolError('Give a session id, or both repo and branch.')
  const repoIds = new Set(findRepos(data, target.repo).map((repo) => repo.id))
  const session = currentSession(data.sessions.filter((s) => repoIds.has(s.repoId) && s.branch === target.branch))
  if (!session) {
    const branches = [...new Set(data.sessions.filter((s) => repoIds.has(s.repoId)).map((s) => s.branch))].sort()
    throw new ToolError(
      `No Skelbert session for ${target.repo}@${target.branch}; the owner has to open it in Skelbert first.` +
        (branches.length ? ` Branches with sessions: ${branches.join(', ')}.` : ''),
    )
  }
  return session
}

function noteCounts(notes: NoteRecord[]) {
  const counts = { open: 0, suggested: 0, resolved: 0, dismissed: 0 }
  for (const note of notes) counts[note.status]++
  return counts
}

const pathMatches = (notePath: string, filter: string) => {
  const prefix = filter.replace(/\/+$/, '')
  return notePath === prefix || notePath.startsWith(`${prefix}/`)
}

export interface ToolContext {
  db: Database
  /** Who is calling, recorded on resolutions as `mcp:<actor>`: the token or OAuth client name. */
  actor: string
  now?: () => number
}

export function createMcpServer({ db, actor, now = Date.now }: ToolContext): McpServer {
  const server = new McpServer({ name: 'skelbert', version: '1.0.0' }, { instructions: SERVER_INSTRUCTIONS })
  const read = { readOnlyHint: true, openWorldHint: false }
  registerPrompts(server, () => loadData(db))

  server.registerTool(
    'get_review_context',
    {
      title: 'Get review context',
      description:
        'Everything to read before reviewing or fixing a branch: the repo\'s review instructions (follow them), the checklists that ' +
        'apply, the changed files Skelbert last scanned (path, status, +/-), open notes and pending suggestions on the branch, and ' +
        'recurring findings from past resolved notes in this repo.',
      inputSchema: sessionTarget,
      annotations: read,
    },
    guarded((target) => {
      const data = loadData(db)
      return json(reviewContext(data, resolveSession(data, target)))
    }),
  )

  server.registerTool(
    'list_repos',
    {
      title: 'List repos',
      description: 'Lists the repositories reviewed in Skelbert, with their branches that have sessions and open note counts.',
      inputSchema: {},
      annotations: read,
    },
    guarded(() => {
      const data = loadData(db)
      const notes = data.notes()
      const repos = [...data.repos].sort((a, b) => b.lastOpenedAt - a.lastOpenedAt)
      return json({
        repos: repos.map((repo) => {
          const sessions = data.sessions.filter((s) => s.repoId === repo.id)
          const branches = [...new Set(sessions.map((s) => s.branch))].map((branch) => {
            const current = currentSession(sessions.filter((s) => s.branch === branch))!
            return { branch, session: current.id, openNotes: notes.filter((n) => n.sessionId === current.id && n.status === 'open').length }
          })
          return { id: repo.id, repo: repoLabel(repo), baseBranch: repo.baseBranch, lastOpened: iso(repo.lastOpenedAt), branches }
        }),
      })
    }),
  )

  server.registerTool(
    'list_sessions',
    {
      title: 'List review sessions',
      description:
        'Lists review sessions, newest first. Filter by repo ("owner/name") and branch to find the session for a checkout; ' +
        'the one with current: true is what Skelbert shows for that branch.',
      inputSchema: {
        repo: z.string().optional().describe('Repository as "owner/name", or a repo id.'),
        branch: z.string().optional().describe('Exact branch name.'),
        status: z.enum(['active', 'archived', 'all']).default('all').describe('Session status filter.'),
      },
      annotations: read,
    },
    guarded(({ repo, branch, status }) => {
      const data = loadData(db)
      const repoIds = repo ? new Set(findRepos(data, repo).map((r) => r.id)) : null
      const notes = data.notes()
      const matching = data.sessions.filter(
        (s) => (!repoIds || repoIds.has(s.repoId)) && (!branch || s.branch === branch) && (status === 'all' || s.status === status),
      )
      const currentIds = new Set<string>()
      for (const s of matching) {
        const current = currentSession(data.sessions.filter((other) => other.repoId === s.repoId && other.branch === s.branch))
        if (current) currentIds.add(current.id)
      }
      return json({
        sessions: matching
          .sort((a, b) => b.startedAt - a.startedAt)
          .map((s) => {
            const repoRecord = data.repoById.get(s.repoId)
            return {
              id: s.id,
              repo: repoRecord ? repoLabel(repoRecord) : s.repoId,
              branch: s.branch,
              status: s.status,
              current: currentIds.has(s.id),
              started: iso(s.startedAt),
              headSha: s.headSha,
              baseSha: s.baseSha,
              notes: noteCounts(notes.filter((n) => n.sessionId === s.id)),
            }
          }),
      })
    }),
  )

  server.registerTool(
    'list_notes',
    {
      title: 'List review notes',
      description:
        'Lists review notes with their anchor (the line text plus context lines). By default only open notes in the current ' +
        'session of each matching repo and branch. Filter by repo, branch, session, path, severity, status and source.',
      inputSchema: {
        ...sessionTarget,
        path: z.string().optional().describe('A file path, or a directory prefix such as "src/api".'),
        severity: z.enum(SEVERITIES).optional(),
        status: z.enum([...STATUSES, 'all']).default('open').describe('Note status; "all" for every status.'),
        source: z.enum(SOURCES).optional().describe('Who wrote it: me (the owner), mcp (an MCP client), or claude (old notes from a since-removed in-app pass).'),
        allSessions: z.boolean().default(false).describe('Include archived and superseded sessions of the branch too.'),
        limit: z.number().int().min(1).max(500).default(100),
      },
      annotations: read,
    },
    guarded(({ session, repo, branch, path, severity, status, source, allSessions, limit }) => {
      const data = loadData(db)
      let sessions: SessionRecord[]
      if (session) sessions = [resolveSession(data, { session })]
      else {
        const repoIds = repo ? new Set(findRepos(data, repo).map((r) => r.id)) : null
        const matching = data.sessions.filter((s) => (!repoIds || repoIds.has(s.repoId)) && (!branch || s.branch === branch))
        if (allSessions) sessions = matching
        else {
          const groups = new Map<string, SessionRecord[]>()
          for (const s of matching) groups.set(`${s.repoId}\n${s.branch}`, [...(groups.get(`${s.repoId}\n${s.branch}`) ?? []), s])
          sessions = [...groups.values()].map((group) => currentSession(group)!)
        }
      }
      const sessionIds = new Set(sessions.map((s) => s.id))
      const notes = data
        .notes()
        .filter(
          (n) =>
            sessionIds.has(n.sessionId) &&
            (status === 'all' || n.status === status) &&
            (!severity || n.severity === severity) &&
            (!source || n.source === source) &&
            (!path || pathMatches(n.path, path)),
        )
        .sort(compareNotes)
      return json({
        filter: { status, ...(severity ? { severity } : {}), ...(source ? { source } : {}), ...(path ? { path } : {}) },
        sessions: sessions.map((s) => s.id),
        total: notes.length,
        ...(notes.length > limit ? { truncated: true } : {}),
        notes: notes.slice(0, limit).map((n) => noteView(n, data)),
      })
    }),
  )

  server.registerTool(
    'get_note',
    {
      title: 'Get a note',
      description: 'Returns one note by id, with its anchor, context and any resolution.',
      inputSchema: { id: z.string().describe('Note id.') },
      annotations: read,
    },
    guarded(({ id }) => {
      const data = loadData(db)
      const note = data.notes().find((n) => n.id === id)
      if (!note) throw new ToolError(`No note with id ${id}.`)
      return json({ ...noteView(note, data), created: iso(note.createdAt), updated: iso(note.updatedAt) })
    }),
  )

  server.registerTool(
    'resolve_note',
    {
      title: 'Resolve a note',
      description:
        'Marks a note resolved with a reply explaining what was done (e.g. the fix and where). The reply is shown on the note in Skelbert.',
      inputSchema: {
        id: z.string().describe('Note id.'),
        reply: z.string().min(1).max(20_000).describe('Markdown reply, e.g. "Fixed in a1b2c3: added a null check."'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    guarded(({ id, reply }) => {
      const data = loadData(db)
      const note = data.notes().find((n) => n.id === id)
      if (!note) throw new ToolError(`No note with id ${id}.`)
      const at = now()
      const updated: NoteRecord = {
        ...note,
        status: 'resolved',
        updatedAt: at,
        resolution: { by: `mcp:${actor}`, text: reply.trim(), at },
      }
      saveRecord(db, 'notes', id, updated, at)
      return json({ resolved: noteView(updated, data) })
    }),
  )

  server.registerTool(
    'add_note',
    {
      title: 'Add a note',
      description:
        'Adds a review note on a line. It arrives in Skelbert as a suggestion the owner accepts or dismisses. ' +
        'Pass lineText (and a few lines of before/after context) so the note stays anchored when the file changes.',
      inputSchema: {
        ...sessionTarget,
        path: z.string().min(1).max(1000).describe('File path relative to the repo root.'),
        line: z.number().int().min(1).describe('1-based line number.'),
        side: z.enum(['new', 'old']).default('new').describe('"new" for the working tree, "old" for the base version.'),
        severity: z.enum(SEVERITIES).default('suggestion'),
        title: z.string().max(200).optional().describe('Short summary shown in the note list.'),
        body: z.string().min(1).max(20_000).describe('Markdown note text.'),
        lineText: z.string().max(2000).optional().describe('Exact text of the line.'),
        before: z.array(z.string().max(2000)).max(MAX_CONTEXT).optional().describe('Lines just above, in file order.'),
        after: z.array(z.string().max(2000)).max(MAX_CONTEXT).optional().describe('Lines just below, in file order.'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    guarded(({ session, repo, branch, path, line, side, severity, title, body, lineText, before, after }) => {
      const data = loadData(db)
      const target = resolveSession(data, { session, repo, branch })
      const at = now()
      const note: NoteRecord = {
        id: uuidv7(at),
        sessionId: target.id,
        path: path.replace(/^\.?\//, ''),
        // With no line text this is a line-only anchor; the PWA fills in text and context from the file.
        anchor: lineText === undefined ? { line, side, text: '', before: [], after: [] } : { line, side, text: lineText, before: before ?? [], after: after ?? [] },
        body: body.trim(),
        severity,
        status: 'suggested',
        source: 'mcp',
        ...(title?.trim() ? { title: title.trim() } : {}),
        createdAt: at,
        updatedAt: at,
      }
      saveRecord(db, 'notes', note.id, note, at)
      return json({ added: noteView(note, data) })
    }),
  )

  server.registerTool(
    'get_checklist',
    {
      title: 'Get the session checklist',
      description: 'Returns the checklists that apply to a session (global and repo-specific) with each item\'s checked state.',
      inputSchema: sessionTarget,
      annotations: read,
    },
    guarded((target) => {
      const data = loadData(db)
      return json(checklistView(data, resolveSession(data, target)))
    }),
  )

  server.registerTool(
    'check_item',
    {
      title: 'Tick a checklist item',
      description: 'Ticks (or with checked: false, unticks) a checklist item for a session. Item ids come from get_checklist.',
      inputSchema: {
        ...sessionTarget,
        itemId: z.string().describe('Checklist item id.'),
        checked: z.boolean().default(true),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    guarded(({ itemId, checked, ...target }) => {
      const data = loadData(db)
      const session = resolveSession(data, target)
      const view = checklistView(data, session)
      const list = view.checklists.find((l) => l.items.some((item) => item.id === itemId))
      if (!list) throw new ToolError(`No item ${itemId} in this session's checklists. Use get_checklist for item ids.`)
      const at = now()
      saveRecord(db, 'checklistState', pairId(session.id, itemId), { sessionId: session.id, itemId, checked }, at)
      const item = list.items.find((i) => i.id === itemId)!
      const done = list.items.filter((i) => (i.id === itemId ? checked : i.checked)).length
      return json({ item: { ...item, checked }, checklist: list.title, done: `${done}/${list.items.length}` })
    }),
  )

  return server
}

import type { InboxItem, InboxSection } from '../db/schema'
import type { GitHubClient } from './client'

export type InboxCi = 'pass' | 'fail' | 'pending' | 'none'

export interface InboxRow {
  owner: string
  name: string
  number: number
  title: string
  url: string
  author: string
  createdAt: string
  updatedAt: string
  draft: boolean
  state: 'OPEN' | 'CLOSED' | 'MERGED'
  additions: number
  deletions: number
  changedFiles: number
  ci: InboxCi
  /** You have a review on it that is not submitted yet. */
  pendingReview: boolean
  /** Your latest submitted review, e.g. APPROVED. */
  myReview: string | null
  /** Requested from a team you are on rather than from you by name. */
  viaTeam: boolean
}

export interface Inbox {
  viewer: string
  sections: Record<InboxSection, InboxRow[]>
  /** Total matches per section, which can exceed the rows fetched. */
  totals: Record<InboxSection, number>
  fetchedAt: number
}

export const SECTION_TITLES: Record<InboxSection, string> = {
  requested: 'Review requested',
  mine: 'Your open PRs',
  reviewed: 'Recently reviewed by you',
}

export const SECTIONS: readonly InboxSection[] = ['requested', 'mine', 'reviewed']

const PAGE = 50
const REVIEWED_PAGE = 20
export const REVIEWED_DAYS = 30

const FIELDS = `
  ... on PullRequest {
    number title url isDraft state createdAt updatedAt additions deletions changedFiles
    author { login }
    repository { name owner { login } }
    viewerLatestReview { state }
    pending: reviews(states: PENDING, first: 1) { totalCount }
    commits(last: 1) { nodes { commit { statusCheckRollup { state } } } }
  }`

export const INBOX_QUERY = `
query Inbox($requested: String!, $direct: String!, $mine: String!, $reviewed: String!) {
  viewer { login }
  requested: search(query: $requested, type: ISSUE, first: ${PAGE}) { issueCount nodes { ${FIELDS} } }
  direct: search(query: $direct, type: ISSUE, first: ${PAGE}) { nodes { ... on PullRequest { url } } }
  mine: search(query: $mine, type: ISSUE, first: ${PAGE}) { issueCount nodes { ${FIELDS} } }
  reviewed: search(query: $reviewed, type: ISSUE, first: ${REVIEWED_PAGE}) { issueCount nodes { ${FIELDS} } }
}`

/** The search queries behind each section. `review-requested:@me` covers your teams too; `user-review-requested` only you. */
export function inboxQueries(now: number) {
  const since = new Date(now - REVIEWED_DAYS * 86_400_000).toISOString().slice(0, 10)
  return {
    requested: 'is:pr is:open archived:false review-requested:@me sort:updated-desc',
    direct: 'is:pr is:open archived:false user-review-requested:@me sort:updated-desc',
    mine: 'is:pr is:open archived:false author:@me sort:updated-desc',
    reviewed: `is:pr archived:false reviewed-by:@me -author:@me updated:>=${since} sort:updated-desc`,
  }
}

interface RawNode {
  number?: number
  title?: string
  url?: string
  isDraft?: boolean
  state?: InboxRow['state']
  createdAt?: string
  updatedAt?: string
  additions?: number
  deletions?: number
  changedFiles?: number
  author?: { login: string } | null
  repository?: { name: string; owner: { login: string } }
  viewerLatestReview?: { state: string } | null
  pending?: { totalCount: number } | null
  commits?: { nodes: ({ commit: { statusCheckRollup: { state: string } | null } } | null)[] } | null
}

interface RawSearch {
  issueCount?: number
  nodes: (RawNode | null)[]
}

interface RawInbox {
  viewer: { login: string }
  requested: RawSearch | null
  direct: { nodes: ({ url?: string } | null)[] } | null
  mine: RawSearch | null
  reviewed: RawSearch | null
}

export function ciState(rollup: string | null | undefined): InboxCi {
  switch (rollup) {
    case 'SUCCESS':
      return 'pass'
    case 'FAILURE':
    case 'ERROR':
      return 'fail'
    case 'PENDING':
    case 'EXPECTED':
      return 'pending'
    default:
      return 'none'
  }
}

function toRow(node: RawNode, direct: ReadonlySet<string> | null): InboxRow | null {
  // Search hits that are not pull requests, or that the token cannot read, come back empty.
  if (!node.url || node.number === undefined || !node.repository) return null
  const rollup = node.commits?.nodes?.[0]?.commit.statusCheckRollup?.state
  return {
    owner: node.repository.owner.login,
    name: node.repository.name,
    number: node.number,
    title: node.title ?? '',
    url: node.url,
    author: node.author?.login ?? 'ghost',
    createdAt: node.createdAt ?? '',
    updatedAt: node.updatedAt ?? '',
    draft: Boolean(node.isDraft),
    state: node.state ?? 'OPEN',
    additions: node.additions ?? 0,
    deletions: node.deletions ?? 0,
    changedFiles: node.changedFiles ?? 0,
    ci: ciState(rollup),
    pendingReview: (node.pending?.totalCount ?? 0) > 0,
    myReview: node.viewerLatestReview?.state ?? null,
    viaTeam: direct !== null && !direct.has(node.url),
  }
}

const rows = (search: RawSearch | null, direct: ReadonlySet<string> | null = null) =>
  (search?.nodes ?? []).flatMap((node) => {
    const row = node ? toRow(node, direct) : null
    return row ? [row] : []
  })

export function mapInbox(raw: RawInbox, fetchedAt: number): Inbox {
  const direct = raw.direct ? new Set(raw.direct.nodes.flatMap((node) => (node?.url ? [node.url] : []))) : null
  const sections = { requested: rows(raw.requested, direct), mine: rows(raw.mine), reviewed: rows(raw.reviewed) }
  return {
    viewer: raw.viewer.login,
    sections,
    totals: {
      requested: raw.requested?.issueCount ?? sections.requested.length,
      mine: raw.mine?.issueCount ?? sections.mine.length,
      reviewed: raw.reviewed?.issueCount ?? sections.reviewed.length,
    },
    fetchedAt,
  }
}

/** All three inbox sections in one GraphQL request. Repositories the token cannot read are left out. */
export async function fetchInbox(gh: GitHubClient, now = Date.now()): Promise<Inbox> {
  const raw = await gh.graphql<RawInbox>(INBOX_QUERY, inboxQueries(now), { partial: true })
  return mapInbox(raw, now)
}

export const MAX_SNAPSHOT_ITEMS = 150

/** The small, synced form MCP clients read with list_review_requests. */
export function inboxSnapshotItems(inbox: Inbox): InboxItem[] {
  return SECTIONS.flatMap((section) =>
    inbox.sections[section].map((row) => ({
      repo: `${row.owner}/${row.name}`,
      number: row.number,
      title: row.title,
      author: row.author,
      url: row.url,
      updatedAt: row.updatedAt,
      section,
    })),
  ).slice(0, MAX_SNAPSHOT_ITEMS)
}

export const sameItems = (a: readonly InboxItem[] | undefined, b: readonly InboxItem[]) =>
  a !== undefined && JSON.stringify(a) === JSON.stringify(b)

/** Why an inbox may come back empty: the token's reach, not an empty queue. */
export const TOKEN_SCOPE_HINT =
  'Search only returns pull requests the token can read. A fine-grained token must have the organization as its resource owner ' +
  '(or "All repositories" for your own account) and include each repository, with Pull requests: read and write, Contents: read, ' +
  'and Commit statuses and Checks: read for CI. Organizations can block fine-grained tokens or require approval for them. ' +
  'A classic token needs the repo scope, and SSO authorization for orgs that use SAML.'

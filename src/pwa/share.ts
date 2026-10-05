import { matchPrPath, type PullRef } from '../../shared/links'

/** The fields of the manifest's GET share target, in the order they are searched. */
export const SHARE_FIELDS = ['url', 'text', 'title'] as const

export interface CompareRef {
  owner: string
  name: string
  /** Absent when the URL compares against the default branch. */
  base: string | null
  head: string
  /** The fork the head branch is in, for `base...user:branch`. */
  headOwner: string | null
  url: string
}

export type SharedLink = { kind: 'pr'; pull: PullRef } | { kind: 'compare'; compare: CompareRef }

const SEGMENT = /^[A-Za-z0-9_.-]+$/
const GITHUB_LINK = /(?:https?:\/\/)?(?:www\.)?github\.com\/[^\s<>"'`]+/gi
const COMPARE_PATH = /^\/([^/]+)\/([^/]+)\/compare\/(.+?)\/?$/

/** `base...head`, `base..head` or just `head`; a head may name its fork as `user:branch` or `user:repo:branch`. */
function readCompare(owner: string, name: string, spec: string, url: string): CompareRef | null {
  const [base, head] = spec.includes('...') ? spec.split('...', 2) : spec.includes('..') ? spec.split('..', 2) : [null, spec]
  if (head === undefined || head === '' || base === '') return null
  const parts = head.split(':')
  const branch = parts.at(-1)!
  const headOwner = parts.length > 1 ? parts[0]! : null
  if (!branch || (headOwner !== null && !SEGMENT.test(headOwner))) return null
  return { owner, name, base, head: branch, headOwner: headOwner === owner ? null : headOwner, url }
}

/** A github.com pull request or compare link, as pasted or shared (scheme optional, trailing punctuation ignored). */
export function readGitHubLink(raw: string): SharedLink | null {
  const text = raw.replace(/[.,;:!?)\]}>'"]+$/, '')
  let url: URL
  try {
    url = new URL(/^https?:\/\//i.test(text) ? text : `https://${text}`)
  } catch {
    return null
  }
  if (!/^(www\.)?github\.com$/i.test(url.hostname)) return null
  const pull = matchPrPath(url.pathname)
  if (pull) return { kind: 'pr', pull }
  const compare = COMPARE_PATH.exec(url.pathname)
  if (!compare) return null
  try {
    const [owner, name, spec] = [compare[1]!, compare[2]!, compare[3]!].map(decodeURIComponent) as [string, string, string]
    if (!SEGMENT.test(owner) || !SEGMENT.test(name)) return null
    const link = readCompare(owner, name, spec, `https://github.com${url.pathname}`)
    return link && { kind: 'compare', compare: link }
  } catch {
    return null
  }
}

/** The first pull request or compare link in what was shared: apps put the URL in `url`, `text` or even `title`. */
export function sharedLink(params: URLSearchParams): SharedLink | null {
  for (const field of SHARE_FIELDS) {
    for (const match of params.get(field)?.matchAll(GITHUB_LINK) ?? []) {
      const link = readGitHubLink(match[0])
      if (link) return link
    }
  }
  return null
}

/** Links to pull requests, shared by the PWA and the server (MCP results, gate output). */

export interface PullRef {
  owner: string
  name: string
  number: number
}

const SEGMENT = /^[A-Za-z0-9_.-]+$/

const validRef = (owner: string, name: string, number: number): PullRef | null =>
  SEGMENT.test(owner) && SEGMENT.test(name) && Number.isSafeInteger(number) && number > 0 ? { owner, name, number } : null

/** The canonical Rubberduck path of a pull request: /pr/owner/name/123. */
export const prPath = ({ owner, name, number }: PullRef) =>
  `/pr/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/${number}`

export const prUrl = (origin: string, ref: PullRef) => `${origin.replace(/\/+$/, '')}${prPath(ref)}`

export const githubPrUrl = ({ owner, name, number }: PullRef) => `https://github.com/${owner}/${name}/pull/${number}`

const PR_PATH = /^\/pr\/([^/]+)\/([^/]+)\/(\d+)\/?$/
/** github.com's own shape, so swapping the host in a PR URL works: /owner/name/pull/123, /files, /commits… */
const MIRROR_PATH = /^\/([^/]+)\/([^/]+)\/pull\/(\d+)(?:\/(?:files|commits|checks|changes)(?:\/.*)?)?\/?$/

/** The pull request a Rubberduck or GitHub path points at, in either route shape. */
export function matchPrPath(pathname: string): PullRef | null {
  const match = PR_PATH.exec(pathname) ?? MIRROR_PATH.exec(pathname)
  if (!match) return null
  try {
    return validRef(decodeURIComponent(match[1]!), decodeURIComponent(match[2]!), Number(match[3]))
  } catch {
    return null
  }
}

/**
 * Reads what someone pasted to open a pull request: a GitHub or Rubberduck URL, "owner/name#123",
 * or "#123" / "123" for the repo in `context`.
 */
export function parsePrReference(input: string, context?: { owner: string; name: string } | null): PullRef | null {
  const text = input.trim()
  if (!text) return null
  const short = /^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)#(\d+)$/.exec(text)
  if (short) return validRef(short[1]!, short[2]!, Number(short[3]))
  const bare = /^#?(\d+)$/.exec(text)
  if (bare) return context ? validRef(context.owner, context.name, Number(bare[1])) : null
  let url: URL
  try {
    url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `https://${text}`)
  } catch {
    return null
  }
  return matchPrPath(url.pathname)
}

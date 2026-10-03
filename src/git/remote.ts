const GITHUB_REMOTE = /^(?:https?:\/\/(?:[^@/]+@)?github\.com\/|ssh:\/\/git@github\.com(?::\d+)?\/|git@github\.com:)([^/]+)\/([^/]+?)(?:\.git)?\/?$/

export function parseGitHubRemote(url: string): { owner: string; name: string } | null {
  const match = GITHUB_REMOTE.exec(url.trim())
  if (!match?.[1] || !match[2]) return null
  return { owner: match[1], name: match[2] }
}

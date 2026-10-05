/** Repo ids like `gh:owner/name` contain a slash, so they are encoded into a single path segment. */
export const repoPath = (repoId: string) => `/repos/${encodeURIComponent(repoId)}`

export const repoHistoryPath = (repoId: string) => `${repoPath(repoId)}/history`

/** A session file on its own, without the sidebar: what "open in new window" opens. */
export const fileWindowPath = (sessionId: string, path: string) =>
  `/sessions/${encodeURIComponent(sessionId)}/window?${new URLSearchParams({ file: path })}`

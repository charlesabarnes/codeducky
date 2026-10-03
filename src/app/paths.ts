/** Repo ids like `gh:owner/name` contain a slash, so they are encoded into a single path segment. */
export const repoPath = (repoId: string) => `/repos/${encodeURIComponent(repoId)}`

export const repoHistoryPath = (repoId: string) => `${repoPath(repoId)}/history`

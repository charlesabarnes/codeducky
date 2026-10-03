import { matchRoutes } from 'react-router'
import { describe, expect, it } from 'vitest'
import { repoHistoryPath, repoPath } from '../../src/app/paths'

const routes = [{ path: 'repos/:repoId' }, { path: 'repos/:repoId/history' }]

describe('repo paths', () => {
  it.each(['gh:charlesabarnes/gangway', 'gh:acme/web.app', '0190c3a2-7d1e-7000-8000-000000000000'])(
    'round-trips %s through the routes',
    (repoId) => {
      expect(matchRoutes(routes, repoPath(repoId))?.map((match) => [match.route.path, match.params.repoId])).toEqual([
        ['repos/:repoId', repoId],
      ])
      expect(matchRoutes(routes, repoHistoryPath(repoId))?.map((match) => [match.route.path, match.params.repoId])).toEqual([
        ['repos/:repoId/history', repoId],
      ])
    },
  )
})

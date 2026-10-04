import type { RouteObject } from 'react-router'
import { ChecklistsPage } from '../features/checklists/ChecklistsPage'
import { HistoryPage } from '../features/history/HistoryPage'
import { InboxPage } from '../features/inbox/InboxPage'
import { LastSessionPage } from './LastSessionPage'
import { PrOpenPage } from '../features/pr/PrOpenPage'
import { Layout } from './Layout'
import { RepoPage } from '../features/repos/RepoPage'
import { ReposPage } from '../features/repos/ReposPage'
import { SessionPage } from '../features/session/SessionPage'
import { SettingsPage } from '../features/settings/SettingsPage'
import { SignInCallback } from '../features/sync/SignInCallback'

export const routes: RouteObject[] = [
  {
    element: <Layout />,
    children: [
      { id: 'repos', index: true, element: <ReposPage /> },
      { id: 'repo', path: 'repos/:repoId', element: <RepoPage /> },
      { id: 'history', path: 'repos/:repoId/history', element: <HistoryPage /> },
      { id: 'checklists', path: 'checklists', element: <ChecklistsPage /> },
      { id: 'session', path: 'sessions/:sessionId', element: <SessionPage /> },
      { id: 'settings', path: 'settings', element: <SettingsPage /> },
      { id: 'inbox', path: 'inbox', element: <InboxPage /> },
      { id: 'last', path: 'last', element: <LastSessionPage /> },
      { id: 'signin-callback', path: 'signin/callback', element: <SignInCallback /> },
      { id: 'pr', path: 'pr/:owner/:repo/:number', element: <PrOpenPage /> },
      // github.com's PR paths, so replacing the host in a PR URL opens it here. Static routes rank above it.
      { id: 'pr-mirror', path: ':owner/:repo/pull/:number/*', element: <PrOpenPage /> },
    ],
  },
]

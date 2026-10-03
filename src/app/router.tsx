import { createBrowserRouter } from 'react-router'
import { ChecklistsPage } from '../features/checklists/ChecklistsPage'
import { HistoryPage } from '../features/history/HistoryPage'
import { Layout } from './Layout'
import { RepoPage } from '../features/repos/RepoPage'
import { ReposPage } from '../features/repos/ReposPage'
import { SessionPage } from '../features/session/SessionPage'
import { SettingsPage } from '../features/settings/SettingsPage'

export const router = createBrowserRouter([
  {
    element: <Layout />,
    children: [
      { index: true, element: <ReposPage /> },
      { path: 'repos/:repoId', element: <RepoPage /> },
      { path: 'repos/:repoId/history', element: <HistoryPage /> },
      { path: 'checklists', element: <ChecklistsPage /> },
      { path: 'sessions/:sessionId', element: <SessionPage /> },
      { path: 'settings', element: <SettingsPage /> },
    ],
  },
])

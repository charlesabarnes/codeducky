import { createBrowserRouter } from 'react-router'
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
      { path: 'sessions/:sessionId', element: <SessionPage /> },
      { path: 'settings', element: <SettingsPage /> },
    ],
  },
])

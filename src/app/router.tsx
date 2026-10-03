import { createBrowserRouter } from 'react-router'
import { Layout } from './Layout'
import { ReposPage } from '../features/repos/ReposPage'
import { SettingsPage } from '../features/settings/SettingsPage'

export const router = createBrowserRouter([
  {
    element: <Layout />,
    children: [
      { index: true, element: <ReposPage /> },
      { path: 'settings', element: <SettingsPage /> },
    ],
  },
])

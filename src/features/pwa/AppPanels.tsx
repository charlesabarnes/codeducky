import { FolderAccessPanel } from './FolderAccess'
import { StoragePanel } from './StoragePanel'

/** Settings for this browser's copy of the app: storage and folder access. */
export function AppPanels() {
  return (
    <>
      <StoragePanel />
      <FolderAccessPanel />
    </>
  )
}

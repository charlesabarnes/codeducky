import { FolderAccessPanel } from './FolderAccess'
import { PresencePanels } from './PresencePanels'
import { StoragePanel } from './StoragePanel'

/** Settings for this browser's copy of the app: installing it, its badge and notifications, storage and folder access. */
export function AppPanels() {
  return (
    <>
      <PresencePanels />
      <StoragePanel />
      <FolderAccessPanel />
    </>
  )
}

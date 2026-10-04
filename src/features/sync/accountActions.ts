import { syncController } from '../../sync/client'
import { DEFAULT_RETURN_TO } from '../../sync/controller'

/** Signs out after a confirm; this browser keeps its data and unsent changes. */
export function signOutKeepingData(): void {
  const { pending } = syncController.getSnapshot()
  const unsent = pending > 0 ? `\n\n${pending} change(s) have not uploaded yet. They stay in this browser and upload when you sign in again.` : ''
  if (window.confirm(`Sign out of Code Ducky? Your review data stays in this browser.${unsent}`)) void syncController.signOut()
}

/** For shared computers: signs out and removes the account's review data, caches and GitHub token from this browser. */
export async function signOutRemovingData(): Promise<void> {
  const { pending, user } = syncController.getSnapshot()
  const who = user ? `@${user.login}'s` : 'the'
  const unsent = pending > 0 ? ` ${pending} change(s) that have not uploaded yet are lost.` : ''
  if (!window.confirm(`Sign out and remove ${who} review data and GitHub token from this browser?${unsent} Appearance settings stay.`)) return
  await syncController.signOutAndRemoveData()
  window.location.assign(DEFAULT_RETURN_TO)
}

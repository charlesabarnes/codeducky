import { uuidv7 } from '../../shared/ids'

export { uuidv7 }

/**
 * Repos with a GitHub remote get an id derived from owner/name, so two devices that open
 * their own checkout of the same repo end up with the same record.
 */
export function repoIdFor(owner: string, name: string): string | null {
  return owner && name ? `gh:${owner.toLowerCase()}/${name.toLowerCase()}` : null
}

const PATCH_SESSION_PREFIX = 'patch-'

/** Sessions opened from a patch file stay on this device; their id says so, and so does every record keyed by it. */
export const patchSessionId = () => `${PATCH_SESSION_PREFIX}${uuidv7()}`

export const isPatchSessionId = (id: unknown): boolean => typeof id === 'string' && id.startsWith(PATCH_SESSION_PREFIX)

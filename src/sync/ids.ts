export { uuidv7 } from '../../shared/ids'

/**
 * Repos with a GitHub remote get an id derived from owner/name, so two devices that open
 * their own checkout of the same repo end up with the same record.
 */
export function repoIdFor(owner: string, name: string): string | null {
  return owner && name ? `gh:${owner.toLowerCase()}/${name.toLowerCase()}` : null
}

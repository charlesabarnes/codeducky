import git from 'isomorphic-git'
import type { GitContext } from './context'

const PACK_DIR = '/.git/objects/pack'
const IDX_V2_FIRST_OID_OFFSET = 8 + 256 * 4

export async function listPackIndexes({ fs }: GitContext): Promise<string[]> {
  try {
    return (await fs.promises.readdir(PACK_DIR)).filter((name) => name.endsWith('.idx'))
  } catch {
    return []
  }
}

function firstOid(idx: Uint8Array): string | null {
  const isV2 = idx[0] === 0xff && idx[1] === 0x74 && idx[2] === 0x4f && idx[3] === 0x63
  const offset = isV2 ? IDX_V2_FIRST_OID_OFFSET : 256 * 4 + 4
  if (idx.byteLength < offset + 20) return null
  return Array.from(idx.subarray(offset, offset + 20), (byte) => byte.toString(16).padStart(2, '0')).join('')
}

/**
 * isomorphic-git checksums a packfile on first use, but concurrent reads (as in `walk`) each start
 * their own checksum before the first finishes. Touching one object per pack serially avoids that.
 */
export async function warmPacks(ctx: GitContext): Promise<void> {
  const { fs, dir, gitdir, cache } = ctx
  for (const name of await listPackIndexes(ctx)) {
    const oid = firstOid((await fs.promises.readFile(`${PACK_DIR}/${name}`)) as Uint8Array)
    if (oid) await git.readObject({ fs, dir, gitdir, cache, oid, format: 'deflated' }).catch(() => undefined)
  }
}

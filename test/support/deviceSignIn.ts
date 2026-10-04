import type { CodeDuckyDb } from '../../src/db/db'
import type { SyncController } from '../../src/sync/controller'
import { enqueueAll } from '../../src/sync/engine'
import { META_AUTH, META_CURSOR, setMeta, type StoredAuth } from '../../src/sync/meta'
import { fakeSignIn, fetchSend } from './fakeSignIn'

/**
 * Signs a device in as `login` through the fake GitHub and stores the session the way the
 * controller does after a sign-in: cursor reset and everything local queued for upload.
 */
export async function signInDevice(controller: SyncController, db: CodeDuckyDb, base: string, login: string, name: string) {
  const { token, tokenId, user } = await fakeSignIn(fetchSend, base, login, name)
  await setMeta(db, META_AUTH, { token, tokenId, name } satisfies StoredAuth)
  await setMeta(db, META_CURSOR, 0)
  await enqueueAll(db)
  await controller.start()
  await controller.sync()
  return user
}

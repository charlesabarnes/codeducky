import { fromBase64Url, toBase64Url, type PushRequest, type PushTarget, type VapidKeys } from './webPush'
import type { PushTransport } from './sender'

/** A fixed pair from npm run vapid, for tests only. */
export const TEST_VAPID: VapidKeys = {
  publicKey: 'BO5YUxHrmBsgbxebAao2TZal1Lih0RA-OY4Uea80Kmi7glZfTUPmO5SjHcWKJADYH8-Q_xwjpyC0B2vfxYllS9o',
  privateKey: 'fqeB9jiQI95Bp3uEcQm88CF-7PRe5ggN8oBNEbtI620',
  subject: 'mailto:ops@ducky.example',
}

/** A browser's side of a push subscription: its ECDH key pair and auth secret. */
export interface Receiver {
  target: PushTarget
  keys: CryptoKeyPair
}

export async function receiverKeys(endpoint = `https://fcm.googleapis.com/fcm/send/${crypto.randomUUID()}`): Promise<Receiver> {
  const keys = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits'])
  const p256dh = toBase64Url(new Uint8Array(await crypto.subtle.exportKey('raw', keys.publicKey)))
  return { target: { endpoint, p256dh, auth: toBase64Url(crypto.getRandomValues(new Uint8Array(16))) }, keys }
}

async function hkdf(salt: Uint8Array, ikm: Uint8Array, info: string | Uint8Array, bytes: number) {
  const key = await crypto.subtle.importKey('raw', ikm as Uint8Array<ArrayBuffer>, 'HKDF', false, ['deriveBits'])
  const infoBytes = typeof info === 'string' ? new TextEncoder().encode(info) : info
  return new Uint8Array(
    await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt: salt as Uint8Array<ArrayBuffer>, info: infoBytes as Uint8Array<ArrayBuffer> }, key, bytes * 8),
  )
}

/** Decrypts an aes128gcm push body the way the browser does (RFC 8291), for checking what was sent. */
export async function decryptPush({ target, keys }: Receiver, body: Uint8Array): Promise<string> {
  const salt = body.slice(0, 16)
  const idLength = body[20]!
  const asPublic = body.slice(21, 21 + idLength)
  const sender = await crypto.subtle.importKey('raw', asPublic, { name: 'ECDH', namedCurve: 'P-256' }, false, [])
  const secret = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: sender }, keys.privateKey, 256))
  const uaPublic = fromBase64Url(target.p256dh)
  const keyInfo = new Uint8Array([...new TextEncoder().encode('WebPush: info\0'), ...uaPublic, ...asPublic])
  const ikm = await hkdf(fromBase64Url(target.auth), secret, keyInfo, 32)
  const cek = await crypto.subtle.importKey('raw', await hkdf(salt, ikm, 'Content-Encoding: aes128gcm\0', 16), 'AES-GCM', false, ['decrypt'])
  const nonce = await hkdf(salt, ikm, 'Content-Encoding: nonce\0', 12)
  const padded = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: nonce }, cek, body.slice(21 + idLength)))
  const end = padded.lastIndexOf(2)
  return new TextDecoder().decode(padded.slice(0, end))
}

/** A push transport that records each request and answers with the status `respond` picks (201 by default). */
export function fakeTransport(respond: (request: PushRequest) => number = () => 201) {
  const sent: PushRequest[] = []
  const transport: PushTransport = async (request) => {
    sent.push(request)
    return { status: respond(request) }
  }
  return { transport, sent }
}

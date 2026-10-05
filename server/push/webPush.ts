/**
 * Web Push with WebCrypto: payload encryption (RFC 8291, aes128gcm from RFC 8188) and VAPID
 * authentication (RFC 8292). Bun implements every primitive it needs, so no library is involved.
 */

export interface VapidKeys {
  /** Uncompressed P-256 public key (65 bytes), base64url. */
  publicKey: string
  /** P-256 private scalar (32 bytes), base64url. */
  privateKey: string
  /** A mailto: or https: contact for the push services. */
  subject: string
}

/** A browser's PushSubscription, as `subscription.toJSON()` gives it. */
export interface PushTarget {
  endpoint: string
  /** The browser's P-256 public key, base64url. */
  p256dh: string
  /** The 16-byte authentication secret, base64url. */
  auth: string
}

export interface PushRequest {
  endpoint: string
  headers: Record<string, string>
  body: Uint8Array
}

const RECORD_SIZE = 4096
const JWT_TTL_SEC = 12 * 60 * 60
const encoder = new TextEncoder()

type Bytes = Uint8Array<ArrayBuffer>

export function toBase64Url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64url')
}

export function fromBase64Url(value: string): Bytes {
  return new Uint8Array(Buffer.from(value, 'base64url'))
}

const concat = (...parts: Uint8Array[]): Bytes => {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0))
  let at = 0
  for (const part of parts) {
    out.set(part, at)
    at += part.length
  }
  return out
}

const isPublicKey = (bytes: Uint8Array) => bytes.length === 65 && bytes[0] === 0x04

/** Whether a base64url string is an uncompressed P-256 public key, as PushSubscription.getKey('p256dh') gives. */
export const validPublicKey = (value: string) => /^[A-Za-z0-9_-]+$/.test(value) && isPublicKey(fromBase64Url(value))

/** Whether a base64url string is a 16-byte authentication secret. */
export const validAuthSecret = (value: string) => /^[A-Za-z0-9_-]+$/.test(value) && fromBase64Url(value).length === 16

const jwkOf = (publicKey: Uint8Array, privateKey: Uint8Array) => ({
  kty: 'EC',
  crv: 'P-256',
  x: toBase64Url(publicKey.subarray(1, 33)),
  y: toBase64Url(publicKey.subarray(33, 65)),
  d: toBase64Url(privateKey),
})

/** A new VAPID key pair, for `npm run vapid`. */
export async function generateVapidKeys(): Promise<{ publicKey: string; privateKey: string }> {
  const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'])
  const publicKey = new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey))
  const { d } = await crypto.subtle.exportKey('jwk', pair.privateKey)
  return { publicKey: toBase64Url(publicKey), privateKey: d! }
}

function importSigningKey(publicKey: string, privateKey: string): Promise<CryptoKey> {
  const jwk = jwkOf(fromBase64Url(publicKey), fromBase64Url(privateKey))
  return crypto.subtle.importKey('jwk', jwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign'])
}

async function hkdf(salt: Uint8Array, ikm: Uint8Array, info: Uint8Array, bytes: number): Promise<Bytes> {
  const key = await crypto.subtle.importKey('raw', ikm as Bytes, 'HKDF', false, ['deriveBits'])
  return new Uint8Array(await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt: salt as Bytes, info: info as Bytes }, key, bytes * 8))
}

export interface EncryptOptions {
  /** Tests pass the RFC 8291 example's values; otherwise both are fresh for every message. */
  salt?: Uint8Array
  senderKeys?: CryptoKeyPair
}

/** Encrypts one push message for a subscription: a single aes128gcm record (RFC 8291 section 3.4). */
export async function encryptPayload(target: Pick<PushTarget, 'p256dh' | 'auth'>, plaintext: Uint8Array, options: EncryptOptions = {}): Promise<Bytes> {
  const uaPublic = fromBase64Url(target.p256dh)
  if (!isPublicKey(uaPublic)) throw new Error('invalid subscription key')
  if (plaintext.length + 1 + 16 > RECORD_SIZE - 86) throw new Error('push payload too large')
  const sender = options.senderKeys ?? (await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']))
  const asPublic = new Uint8Array(await crypto.subtle.exportKey('raw', sender.publicKey))
  const receiver = await crypto.subtle.importKey('raw', uaPublic, { name: 'ECDH', namedCurve: 'P-256' }, false, [])
  const ecdhSecret = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: receiver }, sender.privateKey, 256))
  const keyInfo = concat(encoder.encode('WebPush: info\0'), uaPublic, asPublic)
  const ikm = await hkdf(fromBase64Url(target.auth), ecdhSecret, keyInfo, 32)
  const salt = options.salt ?? crypto.getRandomValues(new Uint8Array(16))
  const cek = await hkdf(salt, ikm, encoder.encode('Content-Encoding: aes128gcm\0'), 16)
  const nonce = await hkdf(salt, ikm, encoder.encode('Content-Encoding: nonce\0'), 12)
  const key = await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['encrypt'])
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce }, key, concat(plaintext, Uint8Array.of(2))))
  const header = new Uint8Array(21)
  header.set(salt, 0)
  new DataView(header.buffer).setUint32(16, RECORD_SIZE)
  header[20] = asPublic.length
  return concat(header, asPublic, ciphertext)
}

/** Signs VAPID JWTs, one per push service origin, reusing each until it is close to expiry. */
export function createVapidSigner(vapid: VapidKeys, now: () => number = Date.now) {
  let key: Promise<CryptoKey> | null = null
  const cache = new Map<string, { jwt: string; exp: number }>()

  const sign = async (audience: string, exp: number) => {
    key ??= importSigningKey(vapid.publicKey, vapid.privateKey)
    const header = toBase64Url(encoder.encode(JSON.stringify({ typ: 'JWT', alg: 'ES256' })))
    const claims = toBase64Url(encoder.encode(JSON.stringify({ aud: audience, exp, sub: vapid.subject })))
    const signature = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, await key, encoder.encode(`${header}.${claims}`))
    return `${header}.${claims}.${toBase64Url(new Uint8Array(signature))}`
  }

  return async (endpoint: string): Promise<string> => {
    const audience = new URL(endpoint).origin
    const at = Math.floor(now() / 1000)
    const cached = cache.get(audience)
    if (cached && cached.exp - at > 60 * 60) return `vapid t=${cached.jwt}, k=${vapid.publicKey}`
    const exp = at + JWT_TTL_SEC
    const jwt = await sign(audience, exp)
    cache.set(audience, { jwt, exp })
    return `vapid t=${jwt}, k=${vapid.publicKey}`
  }
}

export type VapidSigner = ReturnType<typeof createVapidSigner>

/** The HTTP request that delivers one message to one subscription. */
export async function buildPushRequest(
  target: PushTarget,
  payload: string,
  signer: VapidSigner,
  ttlSec: number,
): Promise<PushRequest> {
  const headers = {
    Authorization: await signer(target.endpoint),
    'Content-Encoding': 'aes128gcm',
    'Content-Type': 'application/octet-stream',
    TTL: String(ttlSec),
    Urgency: 'normal',
  }
  return { endpoint: target.endpoint, headers, body: await encryptPayload(target, encoder.encode(payload)) }
}

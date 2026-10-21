import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto'

/**
 * OAuth state the desk hands out (client registrations, sign-in requests,
 * codes, tokens) is sealed with AES-GCM instead of stored, so nothing about a
 * sign-in lands in the versioned desk database. Each kind has its own prefix,
 * which is also the AAD: a sealed code can never be replayed as a token.
 */
export type SealKind = 'cl' | 'rq' | 'st' | 'cd' | 'at' | 'rt'

function key(): Buffer | null {
  const secret = process.env.DESK_OAUTH_SECRET ?? process.env.DESK_ADMIN_KEY
  if (!secret || secret.length < 24) return null
  return Buffer.from(hkdfSync('sha256', secret, 'client-desk', 'oauth-seal-v1', 32))
}

export const sealingAvailable = () => key() !== null

export function seal(kind: SealKind, payload: object): string {
  const k = key()
  if (!k) throw new Error('OAuth is not configured (DESK_OAUTH_SECRET or DESK_ADMIN_KEY)')
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', k, iv)
  cipher.setAAD(Buffer.from(kind))
  const body = Buffer.concat([cipher.update(JSON.stringify(payload), 'utf8'), cipher.final()])
  return `${kind}_${Buffer.concat([iv, body, cipher.getAuthTag()]).toString('base64url')}`
}

/** The payload, or null if it is not ours, of another kind, tampered with or past its `exp` (seconds). */
export function unseal<T extends { exp?: number }>(kind: SealKind, value: string | undefined | null, now = Date.now()): T | null {
  const k = key()
  if (!k || !value?.startsWith(`${kind}_`)) return null
  try {
    const raw = Buffer.from(value.slice(kind.length + 1), 'base64url')
    if (raw.length < 29) return null
    const decipher = createDecipheriv('aes-256-gcm', k, raw.subarray(0, 12))
    decipher.setAAD(Buffer.from(kind))
    decipher.setAuthTag(raw.subarray(raw.length - 16))
    const text = Buffer.concat([decipher.update(raw.subarray(12, raw.length - 16)), decipher.final()]).toString('utf8')
    const payload = JSON.parse(text) as T
    if (typeof payload.exp === 'number' && payload.exp * 1000 < now) return null
    return payload
  } catch {
    return null
  }
}

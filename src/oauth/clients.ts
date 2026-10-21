import { isIP } from 'node:net'
import { seal, unseal } from './seal'

/**
 * The apps (Claude, Claude Code, other MCP hosts) that can ask a person to sign
 * in. Two ways to be one, as the MCP spec allows:
 * - Client ID Metadata Documents: the client_id is an https URL whose JSON
 *   lists the app's name and redirect URIs. Claude uses this.
 * - Dynamic Client Registration: POST /oauth/register. The registration is
 *   sealed into the client_id itself, so nothing is stored.
 */
export type OAuthClient = { id: string; name: string; redirectUris: string[] }

type Registration = { ru: string[]; n?: string }

const BLOCKED_SCHEMES = new Set(['javascript:', 'data:', 'file:', 'vbscript:', 'about:', 'blob:'])
const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]'])

/** https anywhere, http only back to this machine, or an app's own scheme (cursor://...). */
export function redirectUriOk(uri: unknown): uri is string {
  if (typeof uri !== 'string' || uri.length > 2000) return false
  let u: URL
  try {
    u = new URL(uri)
  } catch {
    return false
  }
  if (u.hash) return false
  if (u.protocol === 'https:') return true
  if (u.protocol === 'http:') return LOOPBACK.has(u.hostname)
  return !BLOCKED_SCHEMES.has(u.protocol)
}

/** Exact match, except a loopback redirect may use any port (RFC 8252 7.3). */
export function redirectMatches(registered: string[], requested: string): boolean {
  if (registered.includes(requested)) return true
  let req: URL
  try {
    req = new URL(requested)
  } catch {
    return false
  }
  if (req.protocol !== 'http:' || !LOOPBACK.has(req.hostname)) return false
  return registered.some((r) => {
    try {
      const u = new URL(r)
      return u.protocol === 'http:' && u.hostname === req.hostname && u.pathname === req.pathname && u.search === req.search
    } catch {
      return false
    }
  })
}

export function register(body: Record<string, unknown>): { client: OAuthClient } | { error: string } {
  const uris = body.redirect_uris
  if (!Array.isArray(uris) || uris.length === 0 || uris.length > 10 || !uris.every(redirectUriOk)) {
    return { error: 'redirect_uris must be 1 to 10 https (or loopback http) URLs' }
  }
  const name = typeof body.client_name === 'string' ? body.client_name.slice(0, 80) : undefined
  const reg: Registration = { ru: uris as string[], ...(name && { n: name }) }
  return { client: { id: seal('cl', reg), name: name ?? 'An app', redirectUris: reg.ru } }
}

const cimdCache = new Map<string, { client: OAuthClient; until: number }>()

/** Only public https hosts, so a client_id can't make the desk fetch its own network. */
function fetchableUrl(id: string): URL | null {
  try {
    const u = new URL(id)
    if (u.protocol !== 'https:' || u.username || u.password || u.port) return null
    const host = u.hostname.replace(/^\[|\]$/g, '')
    if (isIP(host) || host === 'localhost' || !host.includes('.') || /\.(local|internal|localhost)$/.test(host)) return null
    return u
  } catch {
    return null
  }
}

async function metadataDocument(id: string, fetchImpl: typeof fetch): Promise<OAuthClient | null> {
  const cached = cimdCache.get(id)
  if (cached && cached.until > Date.now()) return cached.client
  const url = fetchableUrl(id)
  if (!url) return null
  try {
    const res = await fetchImpl(url, { redirect: 'error', signal: AbortSignal.timeout(5000), headers: { accept: 'application/json' } })
    if (!res.ok) return null
    const text = await res.text()
    if (text.length > 10_000) return null
    const doc = JSON.parse(text) as Record<string, unknown>
    const uris = doc.redirect_uris
    if (doc.client_id !== id || !Array.isArray(uris) || uris.length === 0 || !uris.every(redirectUriOk)) return null
    const client = {
      id,
      name: typeof doc.client_name === 'string' ? doc.client_name.slice(0, 80) : url.hostname,
      redirectUris: uris as string[],
    }
    cimdCache.set(id, { client, until: Date.now() + 10 * 60_000 })
    return client
  } catch {
    return null
  }
}

export async function resolveOAuthClient(id: string | undefined, fetchImpl: typeof fetch = fetch): Promise<OAuthClient | null> {
  if (!id) return null
  if (id.startsWith('https://')) return metadataDocument(id, fetchImpl)
  const reg = unseal<Registration & { exp?: number }>('cl', id)
  return reg ? { id, name: reg.n ?? 'An app', redirectUris: reg.ru } : null
}

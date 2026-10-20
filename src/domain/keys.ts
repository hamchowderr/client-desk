import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { and, eq, isNull } from 'drizzle-orm'
import type { DbOrTx } from '../db/client'
import { apiKeys, clients } from '../db/schema'
import { DeskError, notFound } from './errors'
import { type Principal, requireAdmin } from './principal'

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex')

/**
 * Mint a key. Returned once; only its hash is stored.
 * Admin keys start `desk_admin_`, client keys `desk_client_`.
 */
export async function createApiKey(
  db: DbOrTx,
  input: { label: string; scope: 'admin' } | { label: string; scope: 'client'; client: string },
) {
  let clientId: string | null = null
  if (input.scope === 'client') {
    const [c] = await db
      .select({ id: clients.id })
      .from(clients)
      .where(eq(clients.code, input.client.trim().toUpperCase()))
    if (!c) throw notFound('Client')
    clientId = c.id
  }
  const key = `desk_${input.scope}_${randomBytes(24).toString('base64url')}`
  const [row] = await db
    .insert(apiKeys)
    .values({ label: input.label, scope: input.scope, clientId, hash: sha256(key), prefix: key.slice(0, 16) })
    .returning({ id: apiKeys.id, label: apiKeys.label, scope: apiKeys.scope, prefix: apiKeys.prefix })
  return { ...row, key }
}

export async function revokeApiKey(db: DbOrTx, id: string) {
  await db.update(apiKeys).set({ revokedAt: new Date() }).where(eq(apiKeys.id, id))
}

/** Mint a key over the API (admin only). The key is in the response once and never again. */
export async function mintApiKey(
  db: DbOrTx,
  p: Principal,
  input: { label: string; scope: 'admin' | 'client'; client?: string },
) {
  requireAdmin(p)
  if (input.scope === 'client') {
    if (!input.client) throw new DeskError('invalid', 'A client key needs the client code')
    return createApiKey(db, { label: input.label, scope: 'client', client: input.client })
  }
  return createApiKey(db, { label: input.label, scope: 'admin' })
}

/** Every key's label, scope, client and last use; never the key or its hash. */
export async function listApiKeys(db: DbOrTx, p: Principal) {
  requireAdmin(p)
  return db
    .select({
      id: apiKeys.id,
      label: apiKeys.label,
      scope: apiKeys.scope,
      client: clients.code,
      prefix: apiKeys.prefix,
      lastUsedAt: apiKeys.lastUsedAt,
      revokedAt: apiKeys.revokedAt,
      createdAt: apiKeys.createdAt,
    })
    .from(apiKeys)
    .leftJoin(clients, eq(apiKeys.clientId, clients.id))
    .orderBy(apiKeys.createdAt)
}

export async function revokeKey(db: DbOrTx, p: Principal, id: string) {
  requireAdmin(p)
  const [row] = await db
    .update(apiKeys)
    .set({ revokedAt: new Date() })
    .where(and(eq(apiKeys.id, id), isNull(apiKeys.revokedAt)))
    .returning({ id: apiKeys.id, label: apiKeys.label })
  if (!row) throw notFound('Active key')
  return { revoked: row.id, label: row.label }
}

/**
 * Turn a bearer token into a principal. DESK_ADMIN_KEY (from Infisical) is the
 * bootstrap owner key; everything else is looked up by hash.
 */
export async function principalForKey(db: DbOrTx, token: string): Promise<Principal | null> {
  const bootstrap = process.env.DESK_ADMIN_KEY
  if (bootstrap && bootstrap.length >= 24) {
    const a = Buffer.from(sha256(token))
    const b = Buffer.from(sha256(bootstrap))
    if (timingSafeEqual(a, b)) return { kind: 'admin', label: 'owner' }
  }
  if (!token.startsWith('desk_')) return null
  const [row] = await db
    .select()
    .from(apiKeys)
    .where(and(eq(apiKeys.hash, sha256(token)), isNull(apiKeys.revokedAt)))
  if (!row) return null
  // Best effort; a failed touch must not fail the request.
  db.update(apiKeys).set({ lastUsedAt: new Date() }).where(eq(apiKeys.id, row.id)).catch(() => {})
  if (row.scope === 'admin') return { kind: 'admin', label: row.label }
  if (!row.clientId) throw new DeskError('forbidden', 'Client key has no client')
  return { kind: 'client', clientId: row.clientId, label: row.label }
}

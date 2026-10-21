import { eq, sql } from 'drizzle-orm'
import type { DbOrTx } from '../db/client'
import { clients, contacts } from '../db/schema'
import type { Principal } from '../domain/principal'
import { unseal } from './seal'

/** Who a sign-in or token is for. Kept small: it rides inside every sealed token. */
export type Who = { k: 'admin'; e: string } | { k: 'client'; c: string; e: string }

export const ACCESS_TTL_S = 60 * 60
export const REFRESH_TTL_S = 30 * 24 * 60 * 60

const ownerEmails = () =>
  (process.env.DESK_OWNER_EMAILS ?? '')
    .split(',')
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean)

/** The desk identity for a verified email: the owner, or exactly one client contact. */
export async function whoForEmail(db: DbOrTx, email: string): Promise<Who | null> {
  const address = email.trim().toLowerCase()
  if (ownerEmails().includes(address)) return { k: 'admin', e: address }
  const matches = await db.select({ id: contacts.id }).from(contacts).where(sql`lower(${contacts.email}) = ${address}`)
  if (matches.length !== 1) return null
  return { k: 'client', c: matches[0]!.id, e: address }
}

/**
 * The principal behind a sealed identity, checked again on every use: a token
 * stops working as soon as the contact is removed or their email changes, or
 * the owner's address leaves DESK_OWNER_EMAILS.
 */
export async function principalForWho(db: DbOrTx, who: Who): Promise<Principal | null> {
  if (who.k === 'admin') return ownerEmails().includes(who.e) ? { kind: 'admin', label: who.e } : null
  const [row] = await db
    .select({ contact: contacts, client: clients })
    .from(contacts)
    .innerJoin(clients, eq(clients.id, contacts.clientId))
    .where(eq(contacts.id, who.c))
  if (!row || row.contact.email?.trim().toLowerCase() !== who.e) return null
  return { kind: 'client', clientId: row.client.id, contactId: row.contact.id, label: `oauth:${row.contact.name}` }
}

export type AccessToken = { who: Who; cid: string; exp: number }

/** An OAuth access token the desk issued, as a principal; null for anything else. */
export async function principalForAccessToken(db: DbOrTx, token: string) {
  const at = unseal<AccessToken>('at', token)
  if (!at) return null
  const principal = await principalForWho(db, at.who)
  return principal ? { principal, clientId: at.cid, expiresAt: at.exp } : null
}

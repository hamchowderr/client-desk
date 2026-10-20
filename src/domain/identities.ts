import { createHash, randomInt } from 'node:crypto'
import { and, eq, gt, isNull, sql } from 'drizzle-orm'
import type { DbOrTx } from '../db/client'
import { chatIdentities, clients, contacts, linkCodes } from '../db/schema'
import { resolveClient } from './clients'
import { DeskError, notFound } from './errors'
import { type Principal, requireAdmin } from './principal'

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex')
/** No 0/O or 1/I/L, so a code read over the phone survives. */
const ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ'
const CODE_DAYS = 7

const normalise = (code: string) => code.toUpperCase().replace(/[^0-9A-Z]/g, '')

/** Who a chat sender is, and the client principal the agent acts as for them. */
export type ChatSender = { principal: Extract<Principal, { kind: 'client' }>; name: string; role: string; client: string }

async function senderFor(db: DbOrTx, contactId: string, platform: string): Promise<ChatSender | null> {
  const [row] = await db
    .select({ contact: contacts, client: clients })
    .from(contacts)
    .innerJoin(clients, eq(clients.id, contacts.clientId))
    .where(eq(contacts.id, contactId))
  if (!row) return null
  return {
    principal: { kind: 'client', clientId: row.client.id, contactId: row.contact.id, label: `${platform}:${row.contact.name}` },
    name: row.contact.name,
    role: row.contact.role,
    client: row.client.name,
  }
}

/**
 * The contact behind a chat account. A linked account wins; otherwise an email
 * the platform vouches for links itself when exactly one contact has it.
 */
export async function chatSender(db: DbOrTx, platform: string, externalId: string, email?: string) {
  const [linked] = await db
    .select()
    .from(chatIdentities)
    .where(and(eq(chatIdentities.platform, platform), eq(chatIdentities.externalId, externalId)))
  if (linked) return senderFor(db, linked.contactId, platform)
  const address = email?.trim().toLowerCase()
  if (!address) return null
  const matches = await db.select().from(contacts).where(sql`lower(${contacts.email}) = ${address}`)
  if (matches.length !== 1) return null
  await linkIdentity(db, matches[0]!.id, platform, externalId)
  return senderFor(db, matches[0]!.id, platform)
}

async function linkIdentity(db: DbOrTx, contactId: string, platform: string, externalId: string) {
  await db
    .insert(chatIdentities)
    .values({ contactId, platform, externalId })
    .onConflictDoUpdate({ target: [chatIdentities.platform, chatIdentities.externalId], set: { contactId } })
}

/** A one-time code a contact sends the client agent ("link K7QM-4XPA") to link their chat account. */
export async function inviteContact(db: DbOrTx, p: Principal, clientRef: string, contactRef: string, now = new Date()) {
  requireAdmin(p)
  const client = await resolveClient(db, p, clientRef)
  const isUuid = /^[0-9a-f-]{36}$/i.test(contactRef)
  const [contact] = await db
    .select()
    .from(contacts)
    .where(
      and(
        eq(contacts.clientId, client.id),
        isUuid ? eq(contacts.id, contactRef) : sql`lower(${contacts.email}) = ${contactRef.trim().toLowerCase()}`,
      ),
    )
  if (!contact) throw notFound('Contact')
  const raw = Array.from({ length: 8 }, () => ALPHABET[randomInt(ALPHABET.length)]).join('')
  const code = `${raw.slice(0, 4)}-${raw.slice(4)}`
  const expiresAt = new Date(now.getTime() + CODE_DAYS * 86_400_000)
  await db.insert(linkCodes).values({ hash: sha256(raw), contactId: contact.id, expiresAt })
  return {
    contact: contact.name,
    code,
    expiresAt,
    message: `Send "link ${code}" to the Otaku Solutions assistant in Teams (or any channel it's in).`,
  }
}

/** Link a chat account with a code from inviteContact. Codes work once. */
export async function redeemLinkCode(db: DbOrTx, platform: string, externalId: string, code: string, now = new Date()) {
  const [row] = await db
    .update(linkCodes)
    .set({ usedAt: now })
    .where(and(eq(linkCodes.hash, sha256(normalise(code))), isNull(linkCodes.usedAt), gt(linkCodes.expiresAt, now)))
    .returning()
  if (!row) throw new DeskError('invalid', 'That code is wrong, used or expired')
  await linkIdentity(db, row.contactId, platform, externalId)
  return senderFor(db, row.contactId, platform)
}

/** Unlink every chat account of a contact. */
export async function unlinkContact(db: DbOrTx, p: Principal, clientRef: string, contactId: string) {
  requireAdmin(p)
  const client = await resolveClient(db, p, clientRef)
  const [contact] = await db
    .select()
    .from(contacts)
    .where(and(eq(contacts.id, contactId), eq(contacts.clientId, client.id)))
  if (!contact) throw notFound('Contact')
  const removed = await db.delete(chatIdentities).where(eq(chatIdentities.contactId, contact.id)).returning()
  return { contact: contact.name, unlinked: removed.map((r) => r.platform) }
}

/** The link command in a chat message, if that's what it is. */
export function linkCommand(text: string): string | null {
  const m = /(?:^|\s)link\s+([0-9a-z]{4}-?[0-9a-z]{4})\s*$/i.exec(text.replace(/<[^>]+>/g, ' ').trim())
  return m ? m[1]! : null
}

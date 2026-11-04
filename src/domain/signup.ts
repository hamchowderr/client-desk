import { timingSafeEqual } from 'node:crypto'
import { eq, sql } from 'drizzle-orm'
import type { Db } from '../db/client'
import { clients, contacts } from '../db/schema'
import { nextChargeAfter } from './billing'
import { getClientOverview } from './clients'
import { DeskError } from './errors'
import { type Principal } from './principal'
import { setupClient, suggestCode } from './setup'

/** The hub's FluentCRM automation acts as this admin when it adds a paying client. */
const HUB: Principal = { kind: 'admin', label: 'hub-checkout' }

/** The Retainer's price on the hub, unless DESK_RETAINER_RATE_CENTS says otherwise. */
const DEFAULT_RATE_CENTS = 150000

/** True when `given` is the shared secret. False when none is configured, so the hook is off until one is. */
export function hookSecretMatches(given: string | null | undefined, secret = process.env.DESK_HOOK_SECRET): boolean {
  const want = secret?.trim()
  if (!want || !given) return false
  const a = Buffer.from(given.trim())
  const b = Buffer.from(want)
  return a.length === b.length && timingSafeEqual(a, b)
}

export type PaidSignup = { email: string; name: string; company?: string }

type Obj = Record<string, unknown>
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v)
const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : undefined)

/**
 * Who paid, from the FluentCRM outgoing webhook: either custom data
 * (`email`, `first_name`, `last_name`, `company`) or the raw contact, with the
 * same keys at the top level or under `subscriber`, and the company as a
 * string or `{ name }`. Null without a valid email.
 */
export function parseSignup(body: unknown): PaidSignup | null {
  if (!isObj(body)) return null
  const c = isObj(body.subscriber) ? { ...body, ...body.subscriber } : body
  const email = str(c.email)?.toLowerCase()
  if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return null
  const name = str(c.full_name) ?? ([str(c.first_name), str(c.last_name)].filter(Boolean).join(' ') || email.split('@')[0])
  const company = str(c.company) ?? str(c.company_name) ?? (isObj(c.company) ? str(c.company.name) : undefined)
  return { email, name, ...(company && { company }) }
}

/** A free client code: the suggested one, else longer or numbered versions of it. */
async function freeCode(db: Db, name: string): Promise<string> {
  const letters = name.toUpperCase().replace(/[^A-Z0-9]/g, '')
  const base = suggestCode(name) || letters.slice(0, 3) || 'CL'
  const candidates = [base, letters.slice(0, 4), letters.slice(0, 5), letters.slice(0, 6)]
  for (let n = 2; n < 100; n++) candidates.push(`${base.slice(0, 4)}${n}`)
  for (const code of candidates) {
    if (!/^[A-Z0-9]{2,6}$/.test(code)) continue
    const taken = await db.select({ id: clients.id }).from(clients).where(eq(clients.code, code))
    if (!taken.length) return code
  }
  throw new DeskError('conflict', 'No free client code for this name')
}

/**
 * Add a client who just paid for the Retainer: the client, the payer as the
 * retainer owner (so they can sign in), and the retainer, charged again a month
 * from today, in onboarding until the kickoff is logged. Nothing changes when
 * the payer is already a contact on a client: a reactivation, or a repeat.
 */
export async function addPaidClient(db: Db, signup: PaidSignup, now = new Date()) {
  const [known] = await db
    .select({ clientId: contacts.clientId, code: clients.code })
    .from(contacts)
    .innerJoin(clients, eq(clients.id, contacts.clientId))
    .where(sql`lower(${contacts.email}) = ${signup.email}`)
  if (known) return { outcome: 'already_client' as const, code: known.code }

  const rate = Number(process.env.DESK_RETAINER_RATE_CENTS) || DEFAULT_RATE_CENTS
  const name = signup.company ?? signup.name
  const result = await setupClient(db, HUB, {
    name,
    code: await freeCode(db, name),
    company: signup.company,
    timezone: 'America/Chicago',
    contactName: signup.name,
    contactEmail: signup.email,
    monthlyRateCents: rate,
    activeLimit: 1,
    nextChargeAt: nextChargeAfter(now).toISOString(),
    kickoffDone: false,
  })
  return { outcome: 'created' as const, code: result.client.code, client: await getClientOverview(db, HUB, result.client.code) }
}

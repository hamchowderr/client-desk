import { eq } from 'drizzle-orm'
import type { Db } from '../db/client'
import { clients } from '../db/schema'
import { addContact, createClient, getClientOverview } from './clients'
import { DeskError } from './errors'
import { type Principal, requireAdmin } from './principal'
import { logKickoff, startRetainer } from './retainers'

export type ClientSetup = {
  code?: string
  name?: string
  company?: string
  timezone?: string
  contactName?: string
  contactEmail?: string
  monthlyRateCents?: number
  activeLimit?: number
  nextChargeAt?: Date | string
  kickoffDone?: boolean
}

/** Up to four letters from the name's words, e.g. "Growth Mindset Advisors" -> GMA. */
export function suggestCode(name: string) {
  const words = name.toUpperCase().replace(/[^A-Z0-9 ]/g, ' ').split(/\s+/).filter(Boolean)
  const code = words.length > 1 ? words.map((w) => w[0]).join('').slice(0, 4) : (words[0] ?? '').slice(0, 3)
  return code.length >= 2 ? code : ''
}

const REQUIRED: Array<[keyof ClientSetup, string]> = [
  ['name', 'client name'],
  ['code', 'client code'],
  ['contactName', 'main contact'],
  ['contactEmail', 'contact email'],
  ['monthlyRateCents', 'monthly rate'],
  ['nextChargeAt', 'first charge date'],
]

/**
 * A new-client form, filled in as far as Chowderr has said: a suggested code,
 * whether that code is free, and what's still missing. Saves nothing.
 */
export async function draftClientSetup(db: Db, p: Principal, input: ClientSetup) {
  requireAdmin(p)
  const draft: ClientSetup = { timezone: 'America/New_York', activeLimit: 1, kickoffDone: false, ...input }
  if (!draft.code && draft.name) draft.code = suggestCode(draft.name)
  if (draft.code) draft.code = draft.code.trim().toUpperCase()
  const codeTaken = draft.code
    ? (await db.select({ id: clients.id }).from(clients).where(eq(clients.code, draft.code))).length > 0
    : false
  const missing = REQUIRED.filter(([k]) => draft[k] === undefined || draft[k] === '').map(([, label]) => label)
  return { setup: draft, codeTaken, missing }
}

/**
 * Add a client in one go: the client, their main contact (the retainer owner),
 * the retainer, and the kickoff if it already happened. All or nothing.
 */
export async function setupClient(db: Db, p: Principal, input: Required<Omit<ClientSetup, 'company'>> & { company?: string }) {
  requireAdmin(p)
  const missing = REQUIRED.filter(([k]) => input[k] === undefined || input[k] === '').map(([, label]) => label)
  if (missing.length) throw new DeskError('invalid', `Still need: ${missing.join(', ')}`)
  const code = await db.transaction(async (tx) => {
    const client = await createClient(tx, p, {
      code: input.code,
      name: input.name,
      company: input.company || undefined,
      timezone: input.timezone,
    })
    await addContact(tx, p, client.code, { name: input.contactName, email: input.contactEmail.trim(), role: 'owner' })
    await startRetainer(tx, p, {
      client: client.code,
      monthlyRateCents: input.monthlyRateCents,
      activeLimit: input.activeLimit,
      // A bare date means that day; noon UTC keeps it on that day in any US zone.
      nextChargeAt: new Date(/^\d{4}-\d{2}-\d{2}$/.test(String(input.nextChargeAt)) ? `${input.nextChargeAt}T12:00:00Z` : input.nextChargeAt),
    })
    if (input.kickoffDone) await logKickoff(tx, p, client.code)
    return client.code
  })
  return { created: true, ...(await getClientOverview(db, p, code)) }
}

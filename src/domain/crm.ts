import { and, eq, isNotNull } from 'drizzle-orm'
import type { CrmAdapter } from '../crm'
import type { DbOrTx } from '../db/client'
import { clients, contacts } from '../db/schema'
import { type Principal, requireAdmin } from './principal'
import { describeRetainer, loadOpenRetainer } from './retainers'

/** Every retainer state a contact can be tagged with; one at a time. */
export const RETAINER_TAGS = ['onboarding', 'active', 'paused', 'cancelling', 'ended'] as const
const tagFor = (state: string) => ({ slug: `desk-${state}`, title: `Desk: ${state[0]!.toUpperCase()}${state.slice(1)}` })

function splitName(name: string) {
  const [first = '', ...rest] = name.trim().split(/\s+/)
  return { firstName: first, lastName: rest.join(' ') }
}

/**
 * Mirror one client into the CRM: each contact with an email is tagged
 * "Desk client", their client code, and the retainer's current state, with
 * the other state tags removed.
 */
export async function syncClientToCrm(db: DbOrTx, crm: CrmAdapter, clientId: string, now = new Date()) {
  const [client] = await db.select().from(clients).where(eq(clients.id, clientId))
  if (!client) return { client: null, contacts: 0 }
  const r = await loadOpenRetainer(db, clientId)
  const state = r ? (await describeRetainer(db, r, now)).status : 'ended'
  const people = await db
    .select()
    .from(contacts)
    .where(and(eq(contacts.clientId, clientId), isNotNull(contacts.email)))
  const attach = [
    { slug: 'desk-client', title: 'Desk client' },
    { slug: `desk-${client.code.toLowerCase()}`, title: `Desk: ${client.code}` },
    tagFor(state),
  ]
  const detach = RETAINER_TAGS.filter((t) => t !== state).map((t) => `desk-${t}`)
  for (const person of people) {
    await crm.syncContact({ email: person.email!.trim(), ...splitName(person.name) }, { attach, detach })
  }
  return { client: client.code, state, contacts: people.length }
}

/** Mirror one client, or every current client, into the CRM now. */
export async function syncCrm(db: DbOrTx, p: Principal, crm: CrmAdapter | null, clientId?: string) {
  requireAdmin(p)
  if (!crm) return { crm: null, synced: [] }
  const ids = clientId ? [clientId] : (await db.select({ id: clients.id }).from(clients)).map((c) => c.id)
  const synced = []
  for (const id of ids) synced.push(await syncClientToCrm(db, crm, id))
  return { crm: crm.name, synced }
}

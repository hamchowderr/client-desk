import { asc, eq } from 'drizzle-orm'
import type { DbOrTx } from '../db/client'
import { contacts, customers, type Client } from '../db/schema'
import { DeskError } from './errors'
import { type Principal, requireAdmin } from './principal'
import { resolveClient } from './clients'

export type For = { forKind: 'customer' | 'team'; forId: string | null; forName: string }

/** Words that mean the client's own company as a whole. */
const WHOLE_TEAM = ['team', 'the team', 'everyone', 'internal', 'us', 'ours']

const norm = (s: string | null | undefined) => (s ?? '').trim().toLowerCase().replace(/\s+/g, ' ')

/** "Rene Gonzalez, The Tax Doctor": first and last name, then company. */
export function label(first: string, last: string | null | undefined, company: string | null | undefined) {
  const name = [first, last].filter((x) => x?.trim()).join(' ')
  return company?.trim() ? `${name}, ${company.trim()}` : name
}

const teamCompany = (client: Pick<Client, 'name' | 'company'>) => client.company || client.name

/** Add one of a client's customers (e.g. Rene Gonzalez at The Tax Doctor). */
export async function addCustomer(
  db: DbOrTx,
  p: Principal,
  clientRef: string,
  input: { firstName: string; lastName?: string; company?: string; notes?: string },
) {
  requireAdmin(p)
  const client = await resolveClient(db, p, clientRef)
  const firstName = input.firstName.trim()
  if (!firstName) throw new DeskError('invalid', 'A customer needs a first name')
  const lastName = input.lastName?.trim() || null
  const company = input.company?.trim() || null
  const existing = await db.select().from(customers).where(eq(customers.clientId, client.id))
  const same = existing.find(
    (c) => norm(c.firstName) === norm(firstName) && norm(c.lastName) === norm(lastName) && norm(c.company) === norm(company),
  )
  if (same) throw new DeskError('conflict', `${label(firstName, lastName, company)} is already on ${client.name}'s list`)
  const [row] = await db
    .insert(customers)
    .values({ clientId: client.id, firstName, lastName, company, notes: input.notes?.trim() || null })
    .returning()
  return { ...row, label: label(row.firstName, row.lastName, row.company) }
}

/** Who a client's requests can be for: their customers and their team. */
export async function whoFor(db: DbOrTx, p: Principal, clientRef: string) {
  const client = await resolveClient(db, p, clientRef)
  const [cs, team] = await Promise.all([
    db.select().from(customers).where(eq(customers.clientId, client.id)).orderBy(asc(customers.firstName)),
    db.select().from(contacts).where(eq(contacts.clientId, client.id)).orderBy(asc(contacts.name)),
  ])
  return {
    client: { code: client.code, name: client.name },
    customers: cs.map((c) => ({
      firstName: c.firstName,
      lastName: c.lastName,
      company: c.company,
      label: label(c.firstName, c.lastName, c.company),
      ...(p.kind === 'admin' ? { notes: c.notes } : {}),
    })),
    team: [client.name, ...team.map((c) => label(c.name, null, teamCompany(client)))],
  }
}

/**
 * Match what someone typed ("Tax Doctor", "Rene", "Cass", "team") to one of the
 * client's customers or team members. Refuses a guess: no match or two matches
 * is an error that lists the choices.
 */
export async function resolveFor(db: DbOrTx, client: Pick<Client, 'id' | 'name' | 'company'>, text: string): Promise<For> {
  const q = norm(text)
  if (!q) throw new DeskError('invalid', "Say who it's for")
  if (WHOLE_TEAM.includes(q) || [client.name, client.company, `${client.name} team`].some((n) => n && norm(n) === q)) {
    return { forKind: 'team', forId: null, forName: client.name }
  }
  const [cs, team] = await Promise.all([
    db.select().from(customers).where(eq(customers.clientId, client.id)),
    db.select().from(contacts).where(eq(contacts.clientId, client.id)),
  ])
  const fits = (q: string, ...names: Array<string | null>) =>
    names.map(norm).some((n) => n && (n === q || (q.length >= 4 && n.includes(q))))
  const hits: For[] = []
  for (const c of cs) {
    const full = label(c.firstName, c.lastName, c.company)
    if (fits(q, c.firstName, c.lastName, `${c.firstName} ${c.lastName ?? ''}`, c.company, full)) {
      hits.push({ forKind: 'customer', forId: c.id, forName: full })
    }
  }
  for (const c of team) {
    const [first] = c.name.trim().split(/\s+/)
    if (fits(q, c.name, first, c.email)) hits.push({ forKind: 'team', forId: c.id, forName: label(c.name, null, teamCompany(client)) })
  }
  if (hits.length === 1) return hits[0]
  const options = [
    ...cs.map((c) => label(c.firstName, c.lastName, c.company)),
    client.name,
    ...team.map((c) => c.name),
  ].join('; ')
  if (hits.length > 1) {
    throw new DeskError('invalid', `"${text}" matches ${hits.map((h) => h.forName).join(' and ')}. Which one? Choices: ${options}.`)
  }
  throw new DeskError(
    'invalid',
    `"${text}" isn't on ${client.name}'s list. Choices: ${options}. Chowderr can add someone new with add_customer.`,
  )
}

/** Who a request is for, as shown with it. */
export function presentFor(r: { forKind: string | null; forName: string | null }) {
  return r.forName ? { kind: r.forKind as 'customer' | 'team', name: r.forName } : null
}

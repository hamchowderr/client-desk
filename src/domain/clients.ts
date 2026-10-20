import { and, asc, eq, inArray, ne } from 'drizzle-orm'
import type { DbOrTx } from '../db/client'
import {
  type ChannelKind,
  channels,
  clients,
  contacts,
  requests,
  type Client,
} from '../db/schema'
import { DeskError, notFound } from './errors'
import { type Principal, assertCanSeeClient, requireAdmin } from './principal'
import { describeRetainer, loadOpenRetainer } from './retainers'
import { formatRequestId } from './refs'

export type NewClient = {
  code: string
  name: string
  company?: string
  timezone?: string
  vaultNote?: string
  notes?: string
}

function assertTimeZone(tz: string) {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz })
  } catch {
    throw new DeskError('invalid', `Unknown time zone "${tz}"`)
  }
}

export async function createClient(db: DbOrTx, p: Principal, input: NewClient): Promise<Client> {
  requireAdmin(p)
  const code = input.code.trim().toUpperCase()
  if (!/^[A-Z0-9]{2,6}$/.test(code)) {
    throw new DeskError('invalid', 'Client code must be 2 to 6 letters or digits, e.g. GMA')
  }
  if (input.timezone) assertTimeZone(input.timezone)
  const existing = await db.select({ id: clients.id }).from(clients).where(eq(clients.code, code))
  if (existing.length) throw new DeskError('conflict', `Client code ${code} is taken`)
  const [row] = await db
    .insert(clients)
    .values({ ...input, code, timezone: input.timezone ?? 'America/New_York' })
    .returning()
  return row
}

/** Accepts a client id or code. */
export async function resolveClient(db: DbOrTx, p: Principal, ref: string): Promise<Client> {
  const isUuid = /^[0-9a-f-]{36}$/i.test(ref)
  const [row] = await db
    .select()
    .from(clients)
    .where(isUuid ? eq(clients.id, ref) : eq(clients.code, ref.trim().toUpperCase()))
  if (!row) throw notFound('Client')
  assertCanSeeClient(p, row.id)
  return row
}

export async function updateClient(
  db: DbOrTx,
  p: Principal,
  ref: string,
  patch: Partial<Omit<NewClient, 'code'>> & { status?: 'active' | 'past' },
): Promise<Client> {
  requireAdmin(p)
  const client = await resolveClient(db, p, ref)
  if (patch.timezone) assertTimeZone(patch.timezone)
  const [row] = await db.update(clients).set(patch).where(eq(clients.id, client.id)).returning()
  return row
}

export async function addContact(
  db: DbOrTx,
  p: Principal,
  clientRef: string,
  input: { name: string; email?: string; role?: 'owner' | 'member'; telegramId?: string; slackId?: string },
) {
  requireAdmin(p)
  const client = await resolveClient(db, p, clientRef)
  const [row] = await db
    .insert(contacts)
    .values({ ...input, clientId: client.id })
    .returning()
  return row
}

export async function addChannel(
  db: DbOrTx,
  p: Principal,
  clientRef: string,
  input: { kind: ChannelKind; externalId: string },
) {
  requireAdmin(p)
  const client = await resolveClient(db, p, clientRef)
  const [row] = await db
    .insert(channels)
    .values({ ...input, clientId: client.id })
    .onConflictDoNothing()
    .returning()
  if (!row) throw new DeskError('conflict', `That ${input.kind} channel is already linked to a client`)
  return row
}

/** Which client a message from a channel belongs to. Used by channel agents. */
export async function findClientByChannel(db: DbOrTx, kind: ChannelKind, externalId: string) {
  const [row] = await db
    .select({ client: clients })
    .from(channels)
    .innerJoin(clients, eq(channels.clientId, clients.id))
    .where(and(eq(channels.kind, kind), eq(channels.externalId, externalId)))
  return row?.client ?? null
}

const OPEN_STATUSES = ['new', 'scoping', 'queued', 'active', 'in_review', 'waiting_on_client'] as const

/** A client with its retainer, active work and queue: the answer to "where are we with X". */
export async function getClientOverview(db: DbOrTx, p: Principal, ref: string, now = new Date()) {
  const client = await resolveClient(db, p, ref)
  const retainer = await loadOpenRetainer(db, client.id)
  const open = await db
    .select()
    .from(requests)
    .where(and(eq(requests.clientId, client.id), inArray(requests.status, [...OPEN_STATUSES])))
    .orderBy(asc(requests.position), asc(requests.receivedAt))
  const summarize = (r: (typeof open)[number]) => ({
    id: formatRequestId(client.code, r.number),
    uuid: r.id,
    title: r.title,
    type: r.type,
    status: r.status,
    sizeDays: r.sizeDays,
    position: r.position,
    startedAt: r.startedAt,
    deliveredAt: r.deliveredAt,
    replyDueAt: r.firstResponseAt ? null : r.replyDueAt,
  })
  const contactRows =
    p.kind === 'admin'
      ? await db.select().from(contacts).where(eq(contacts.clientId, client.id))
      : []
  return {
    client: {
      id: client.id,
      code: client.code,
      name: client.name,
      company: client.company,
      timezone: client.timezone,
      status: client.status,
      ...(p.kind === 'admin' ? { vaultNote: client.vaultNote, notes: client.notes } : {}),
    },
    retainer: retainer ? await describeRetainer(db, retainer, now) : null,
    active: open.filter((r) => r.status === 'active').map(summarize),
    queue: open.filter((r) => r.status === 'queued').map(summarize),
    inReview: open.filter((r) => r.status === 'in_review').map(summarize),
    waitingOnClient: open.filter((r) => r.status === 'waiting_on_client').map(summarize),
    intake: open.filter((r) => r.status === 'new' || r.status === 'scoping').map(summarize),
    ...(p.kind === 'admin' ? { contacts: contactRows } : {}),
  }
}

export async function listClients(db: DbOrTx, p: Principal, opts: { includePast?: boolean } = {}) {
  requireAdmin(p)
  const rows = await db
    .select()
    .from(clients)
    .where(opts.includePast ? undefined : ne(clients.status, 'past'))
    .orderBy(asc(clients.name))
  const out = []
  for (const c of rows) {
    const retainer = await loadOpenRetainer(db, c.id)
    const counts = await db
      .select({ status: requests.status, id: requests.id })
      .from(requests)
      .where(and(eq(requests.clientId, c.id), inArray(requests.status, [...OPEN_STATUSES])))
    const count = (s: string) => counts.filter((r) => r.status === s).length
    out.push({
      code: c.code,
      name: c.name,
      company: c.company,
      status: c.status,
      retainerStatus: retainer?.status ?? null,
      activeLimit: retainer?.activeLimit ?? null,
      active: count('active'),
      queued: count('queued'),
      intake: count('new') + count('scoping'),
      inReview: count('in_review'),
      waitingOnClient: count('waiting_on_client'),
    })
  }
  return out
}

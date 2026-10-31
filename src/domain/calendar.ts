import { and, eq, inArray, ne } from 'drizzle-orm'
import type { DbOrTx } from '../db/client'
import { clients, requests, retainers } from '../db/schema'
import { listPauses } from './retainers'
import type { Principal } from './principal'
import { resolveClient } from './clients'
import { formatRequestId } from './refs'
import { chargeDateFor, monthKey, parseMonth, shiftMonth } from './time'

export type CalendarEvent = {
  at: Date
  kind: 'received' | 'reply_due' | 'started' | 'delivered' | 'charge' | 'paused' | 'ends'
  title: string
  client: { code: string; name: string }
  request?: string
  for?: string | null
}

/** How far ahead "coming up" looks, for scheduled tasks that ask what's next. */
export const UPCOMING_DAYS = 14

const OPEN = ['new', 'scoping', 'queued', 'active', 'in_review', 'waiting_on_client'] as const

/**
 * One month of dates across the desk: requests coming in, replies due, work
 * starting and delivered, charges, paused months and retainer end dates. The
 * owner sees every client (or one); a client sees only their own. Also lists
 * what's coming up in the next two weeks, whatever month is shown.
 */
export async function calendar(
  db: DbOrTx,
  p: Principal,
  opts: { client?: string; month?: string } = {},
  now = new Date(),
) {
  const month = opts.month ?? monthKey(now)
  parseMonth(month)
  const from = new Date(`${month}-01T00:00:00Z`)
  const to = new Date(`${shiftMonth(month, 1)}-01T00:00:00Z`)
  const soonTo = new Date(now.getTime() + UPCOMING_DAYS * 86_400_000)

  const clientId = p.kind === 'client' ? p.clientId : opts.client ? (await resolveClient(db, p, opts.client)).id : null
  const client = clientId ? (await db.select().from(clients).where(eq(clients.id, clientId)))[0] : null

  const scope = clientId ? [eq(clients.id, clientId)] : [eq(clients.status, 'active')]
  const rows = await db
    .select({ request: requests, client: clients })
    .from(requests)
    .innerJoin(clients, eq(requests.clientId, clients.id))
    .where(and(...scope, ne(requests.status, 'declined')))
  const open = await db
    .select({ retainer: retainers, client: clients })
    .from(retainers)
    .innerJoin(clients, eq(retainers.clientId, clients.id))
    .where(and(...scope, inArray(retainers.status, ['onboarding', 'active', 'cancelling'])))

  const events: CalendarEvent[] = []
  for (const { request: r, client: c } of rows) {
    const base = {
      client: { code: c.code, name: c.name },
      request: formatRequestId(c.code, r.number),
      title: r.title,
      for: r.forName,
    }
    events.push({ ...base, at: r.receivedAt, kind: 'received' })
    if (r.replyDueAt && !r.firstResponseAt && (OPEN as readonly string[]).includes(r.status))
      events.push({ ...base, at: r.replyDueAt, kind: 'reply_due' })
    if (r.startedAt) events.push({ ...base, at: r.startedAt, kind: 'started' })
    if (r.deliveredAt) events.push({ ...base, at: r.deliveredAt, kind: 'delivered' })
  }
  for (const { retainer: r, client: c } of open) {
    const who = { code: c.code, name: c.name }
    const paused = new Set((await listPauses(db, r.id)).map((x) => x.month))
    // Every billing month that touches the shown month or the next two weeks.
    const first = monthKey(from < now ? from : now)
    const last = monthKey(to > soonTo ? to : soonTo)
    for (let m = shiftMonth(first, -1); m <= last; m = shiftMonth(m, 1)) {
      const at = chargeDateFor(m, r.currentPeriodEnd)
      if (at < r.startedAt || (r.cancelAt && at >= r.cancelAt)) continue
      events.push(
        paused.has(m)
          ? { at, kind: 'paused', title: 'Paused month: no charge, no work', client: who }
          : { at, kind: 'charge', title: 'Retainer charge', client: who },
      )
    }
    if (r.cancelAt) events.push({ at: r.cancelAt, kind: 'ends', title: 'Retainer ends', client: who })
  }

  const byTime = (a: CalendarEvent, b: CalendarEvent) => a.at.getTime() - b.at.getTime()
  const inMonth = events.filter((e) => e.at >= from && e.at < to).sort(byTime)
  const upcoming = events.filter((e) => e.at >= now && e.at < soonTo && e.kind !== 'received').sort(byTime)
  return {
    calendar: month,
    client: client ? { code: client.code, name: client.name } : null,
    today: now,
    events: inMonth,
    upcoming,
  }
}

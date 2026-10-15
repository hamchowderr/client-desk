import { and, asc, eq, inArray, isNotNull, isNull, ne } from 'drizzle-orm'
import type { DbOrTx } from '../db/client'
import { clients, requests, retainers } from '../db/schema'
import { type Principal, requireAdmin } from './principal'
import { formatRequestId } from './refs'
import { describeRetainer } from './retainers'

/** Spots on the Retainer page ("6 of 8 taken"). */
export function capacity() {
  return Number(process.env.DESK_CAPACITY ?? 8)
}

/**
 * The morning view: replies owed, what's active per client, what waits on whom.
 * Overdue replies come first, then the ones due today.
 */
export async function digest(db: DbOrTx, p: Principal, now = new Date()) {
  requireAdmin(p)
  const replyRows = await db
    .select({ request: requests, client: clients })
    .from(requests)
    .innerJoin(clients, eq(requests.clientId, clients.id))
    .where(
      and(
        isNotNull(requests.replyDueAt),
        isNull(requests.firstResponseAt),
        inArray(requests.status, ['new', 'scoping', 'queued', 'active', 'in_review', 'waiting_on_client']),
      ),
    )
    .orderBy(asc(requests.replyDueAt))

  const endOfToday = new Date(now)
  endOfToday.setUTCHours(23, 59, 59, 999)

  const repliesDue = replyRows.map(({ request: r, client: c }) => ({
    id: formatRequestId(c.code, r.number),
    client: c.name,
    title: r.title,
    dueAt: r.replyDueAt,
    overdue: r.replyDueAt! < now,
  }))

  const open = await db
    .select({ retainer: retainers, client: clients })
    .from(retainers)
    .innerJoin(clients, eq(retainers.clientId, clients.id))
    .where(ne(retainers.status, 'ended'))
    .orderBy(asc(clients.name))

  const openRequests = await db
    .select({ request: requests, client: clients })
    .from(requests)
    .innerJoin(clients, eq(requests.clientId, clients.id))
    .where(inArray(requests.status, ['new', 'scoping', 'queued', 'active', 'in_review', 'waiting_on_client']))
    .orderBy(asc(requests.position), asc(requests.receivedAt))

  const boards = []
  for (const { retainer, client } of open) {
    const mine = openRequests.filter((x) => x.client.id === client.id).map((x) => x.request)
    const pick = (s: string) =>
      mine
        .filter((r) => r.status === s)
        .map((r) => ({
          id: formatRequestId(client.code, r.number),
          title: r.title,
          type: r.type,
          sizeDays: r.sizeDays,
          startedAt: r.startedAt,
          deliveredAt: r.deliveredAt,
        }))
    const state = await describeRetainer(db, retainer, now)
    boards.push({
      code: client.code,
      name: client.name,
      retainer: { status: state.status, activeLimit: state.activeLimit, nextChargeAt: state.nextChargeAt },
      active: pick('active'),
      queued: pick('queued'),
      intake: [...pick('new'), ...pick('scoping')],
      inReview: pick('in_review'),
      waitingOnClient: pick('waiting_on_client'),
    })
  }

  return {
    at: now,
    repliesDue,
    counts: {
      overdueReplies: repliesDue.filter((r) => r.overdue).length,
      repliesDueToday: repliesDue.filter((r) => !r.overdue && r.dueAt! <= endOfToday).length,
      active: boards.reduce((n, b) => n + b.active.length, 0),
      queued: boards.reduce((n, b) => n + b.queued.length, 0),
      waitingOnClients: boards.reduce((n, b) => n + b.waitingOnClient.length, 0),
    },
    spots: { taken: open.length, capacity: capacity() },
    clients: boards,
  }
}

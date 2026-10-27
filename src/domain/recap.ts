import { and, asc, eq, gte, inArray, or } from 'drizzle-orm'
import type { DbOrTx } from '../db/client'
import { requests } from '../db/schema'
import { resolveClient } from './clients'
import type { Principal } from './principal'
import { formatRequestId } from './refs'
import { describeRetainer, loadOpenRetainer } from './retainers'

const WEEK_MS = 7 * 86_400_000

/**
 * A client's week: what was delivered in the last seven days, what's in
 * progress, what's waiting on them, and what's next in their queue.
 */
export async function weeklyRecap(db: DbOrTx, p: Principal, clientRef: string, now = new Date()) {
  const client = await resolveClient(db, p, clientRef)
  const since = new Date(now.getTime() - WEEK_MS)
  const rows = await db
    .select()
    .from(requests)
    .where(
      and(
        eq(requests.clientId, client.id),
        or(
          inArray(requests.status, ['active', 'queued', 'waiting_on_client', 'new', 'scoping']),
          and(inArray(requests.status, ['in_review', 'done']), gte(requests.deliveredAt, since)),
          gte(requests.receivedAt, since),
        ),
      ),
    )
    .orderBy(asc(requests.position), asc(requests.receivedAt))
  const item = (r: (typeof rows)[number]) => ({
    id: formatRequestId(client.code, r.number),
    title: r.title,
    for: r.forName,
    status: r.status,
    sizeDays: r.sizeDays,
    startedAt: r.startedAt,
    deliveredAt: r.deliveredAt,
    deliverableUrl: r.deliverableUrl,
  })
  const shipped = rows
    .filter((r) => (r.status === 'in_review' || r.status === 'done') && r.deliveredAt && r.deliveredAt >= since)
    .sort((a, b) => b.deliveredAt!.getTime() - a.deliveredAt!.getTime())
    .map(item)
  const inProgress = rows.filter((r) => r.status === 'active').map(item)
  const waitingOnYou = rows.filter((r) => r.status === 'waiting_on_client').map(item)
  const queued = rows.filter((r) => r.status === 'queued')
  const upNext = queued.slice(0, 3).map(item)
  const received = rows.filter((r) => r.receivedAt >= since).length
  const retainer = await loadOpenRetainer(db, client.id)

  const parts = [
    shipped.length && `${shipped.length} delivered`,
    inProgress.length && `${inProgress.length} in progress`,
    waitingOnYou.length && `${waitingOnYou.length} waiting on you`,
  ].filter(Boolean) as string[]
  return {
    client: { code: client.code, name: client.name },
    from: since,
    to: now,
    headline: parts.length ? parts.join(', ') : 'all quiet',
    shipped,
    inProgress,
    waitingOnYou,
    upNext,
    moreQueued: Math.max(queued.length - upNext.length, 0),
    received,
    retainer: retainer ? await describeRetainer(db, retainer, now) : null,
  }
}

export type Recap = Awaited<ReturnType<typeof weeklyRecap>>

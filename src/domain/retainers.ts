import { and, asc, eq, ne } from 'drizzle-orm'
import type { DbOrTx } from '../db/client'
import { clients, pauses, retainers, type Retainer } from '../db/schema'
import { DeskError, notFound, ruleBroken } from './errors'
import { type Principal, assertCanSeeClient, requireAdmin } from './principal'
import { billingMonthAt, chargeDateFor, parseMonth, shiftMonth } from './time'

/** Pause by the month, up to three months in a row. */
export const MAX_CONSECUTIVE_PAUSED_MONTHS = 3

export async function loadOpenRetainer(db: DbOrTx, clientId: string): Promise<Retainer | null> {
  const [row] = await db
    .select()
    .from(retainers)
    .where(and(eq(retainers.clientId, clientId), ne(retainers.status, 'ended')))
  if (!row) return null
  return settleCancellation(db, row)
}

/** A cancellation takes effect at the end of the paid month; settle it lazily on read. */
async function settleCancellation(db: DbOrTx, r: Retainer, now = new Date()): Promise<Retainer | null> {
  if (r.status === 'cancelling' && r.cancelAt && r.cancelAt <= now) {
    await db.update(retainers).set({ status: 'ended' }).where(eq(retainers.id, r.id))
    return null
  }
  return r
}

async function clientIdFor(db: DbOrTx, p: Principal, clientRef: string): Promise<string> {
  const isUuid = /^[0-9a-f-]{36}$/i.test(clientRef)
  const [c] = await db
    .select({ id: clients.id })
    .from(clients)
    .where(isUuid ? eq(clients.id, clientRef) : eq(clients.code, clientRef.trim().toUpperCase()))
  if (!c) throw notFound('Client')
  assertCanSeeClient(p, c.id)
  return c.id
}

export async function requireOpenRetainer(db: DbOrTx, p: Principal, clientRef: string) {
  const clientId = await clientIdFor(db, p, clientRef)
  const r = await loadOpenRetainer(db, clientId)
  if (!r) throw new DeskError('rule', 'This client has no open retainer')
  return r
}

export async function listPauses(db: DbOrTx, retainerId: string) {
  return db.select().from(pauses).where(eq(pauses.retainerId, retainerId)).orderBy(asc(pauses.month))
}

export function isPausedAt(r: Retainer, pausedMonths: string[], at: Date): boolean {
  return pausedMonths.includes(billingMonthAt(at, r.currentPeriodEnd))
}

/** Retainer state in plain terms, as agents and the board report it. */
export async function describeRetainer(db: DbOrTx, r: Retainer, now = new Date()) {
  const months = (await listPauses(db, r.id)).map((x) => x.month)
  const upcoming = months.filter((m) => chargeDateFor(m, r.currentPeriodEnd) > now)
  const pausedNow = isPausedAt(r, months, now)
  return {
    id: r.id,
    status: pausedNow && r.status === 'active' ? ('paused' as const) : r.status,
    monthlyRate: { cents: r.monthlyRateCents, currency: r.currency },
    activeLimit: r.activeLimit,
    libraryAccess: r.libraryAccess,
    startedAt: r.startedAt,
    kickoffDone: r.kickoffAt !== null,
    nextChargeAt: r.status === 'cancelling' ? null : r.currentPeriodEnd,
    endsAt: r.cancelAt,
    pausedMonths: upcoming,
  }
}

export async function startRetainer(
  db: DbOrTx,
  p: Principal,
  input: {
    client: string
    monthlyRateCents: number
    currency?: string
    activeLimit?: number
    startedAt?: Date
    nextChargeAt: Date
    billingRef?: string
    kickoffDone?: boolean
  },
) {
  requireAdmin(p)
  const clientId = await clientIdFor(db, p, input.client)
  if (await loadOpenRetainer(db, clientId)) {
    throw new DeskError('conflict', 'This client already has an open retainer')
  }
  if (!Number.isInteger(input.monthlyRateCents) || input.monthlyRateCents <= 0) {
    throw new DeskError('invalid', 'Monthly rate must be a positive whole number of cents')
  }
  const started = input.startedAt ?? new Date()
  const [row] = await db
    .insert(retainers)
    .values({
      clientId,
      monthlyRateCents: input.monthlyRateCents,
      currency: input.currency ?? 'usd',
      activeLimit: input.activeLimit ?? 1,
      startedAt: started,
      currentPeriodEnd: input.nextChargeAt,
      billingRef: input.billingRef,
      // Existing clients imported mid-retainer already had their kickoff.
      status: input.kickoffDone ? 'active' : 'onboarding',
      kickoffAt: input.kickoffDone ? started : null,
    })
    .returning()
  return row
}

/** "A kickoff call starts every retainer." Requests open once it's logged. */
export async function logKickoff(db: DbOrTx, p: Principal, clientRef: string, at = new Date()) {
  requireAdmin(p)
  const r = await requireOpenRetainer(db, p, clientRef)
  if (r.status !== 'onboarding') throw new DeskError('conflict', 'Kickoff is already logged')
  const [row] = await db
    .update(retainers)
    .set({ status: 'active', kickoffAt: at })
    .where(eq(retainers.id, r.id))
    .returning()
  return row
}

export async function setActiveLimit(db: DbOrTx, p: Principal, clientRef: string, limit: number) {
  requireAdmin(p)
  if (!Number.isInteger(limit) || limit < 1 || limit > 10) {
    throw new DeskError('invalid', 'Active limit must be between 1 and 10')
  }
  const r = await requireOpenRetainer(db, p, clientRef)
  const [row] = await db
    .update(retainers)
    .set({ activeLimit: limit })
    .where(eq(retainers.id, r.id))
    .returning()
  return row
}

/** Billing moved the period on (renewal paid). */
export async function setNextCharge(db: DbOrTx, p: Principal, clientRef: string, nextChargeAt: Date) {
  requireAdmin(p)
  const r = await requireOpenRetainer(db, p, clientRef)
  const [row] = await db
    .update(retainers)
    .set({ currentPeriodEnd: nextChargeAt })
    .where(eq(retainers.id, r.id))
    .returning()
  return row
}

/**
 * "By the month, requested before the next charge, up to three months in a row.
 * Your queue and your place are kept." Clients can ask for it themselves.
 */
export async function pauseMonth(
  db: DbOrTx,
  p: Principal,
  clientRef: string,
  month: string,
  now = new Date(),
) {
  try {
    parseMonth(month)
  } catch (e) {
    throw new DeskError('invalid', (e as Error).message)
  }
  const r = await requireOpenRetainer(db, p, clientRef)
  if (r.status === 'cancelling') throw ruleBroken('A retainer that is cancelling cannot be paused')
  const charge = chargeDateFor(month, r.currentPeriodEnd)
  if (charge <= now) {
    throw ruleBroken(
      `A pause has to be asked for before the charge that opens that month (${charge.toISOString().slice(0, 10)})`,
    )
  }
  const existing = (await listPauses(db, r.id)).map((x) => x.month)
  if (existing.includes(month)) return { retainerId: r.id, month, alreadyPaused: true }
  const all = new Set([...existing, month])
  let run = 1
  for (let m = shiftMonth(month, -1); all.has(m); m = shiftMonth(m, -1)) run++
  for (let m = shiftMonth(month, 1); all.has(m); m = shiftMonth(m, 1)) run++
  if (run > MAX_CONSECUTIVE_PAUSED_MONTHS) {
    throw ruleBroken(`That would be ${run} months paused in a row; the limit is ${MAX_CONSECUTIVE_PAUSED_MONTHS}`)
  }
  await db.insert(pauses).values({ retainerId: r.id, month, requestedAt: now })
  return { retainerId: r.id, month, alreadyPaused: false, skipsChargeOn: charge }
}

/** How many months ahead the pause calendar shows. */
export const PAUSE_PLAN_MONTHS = 6

/**
 * The next few billing months, each with its charge date and whether it can be
 * paused now (the same rules as pauseMonth), for the pause calendar.
 */
export async function pausePlan(db: DbOrTx, p: Principal, clientRef: string, now = new Date()) {
  const r = await requireOpenRetainer(db, p, clientRef)
  const paused = new Set((await listPauses(db, r.id)).map((x) => x.month))
  const runWith = (month: string) => {
    const all = new Set([...paused, month])
    let run = 1
    for (let m = shiftMonth(month, -1); all.has(m); m = shiftMonth(m, -1)) run++
    for (let m = shiftMonth(month, 1); all.has(m); m = shiftMonth(m, 1)) run++
    return run
  }
  const first = billingMonthAt(now, r.currentPeriodEnd)
  const months = Array.from({ length: PAUSE_PLAN_MONTHS }, (_, i) => {
    const month = shiftMonth(first, i + 1)
    const chargeOn = chargeDateFor(month, r.currentPeriodEnd)
    const isPaused = paused.has(month)
    let blockedBecause: string | null = null
    if (r.status === 'cancelling') blockedBecause = 'The retainer is ending'
    else if (r.cancelAt && chargeOn >= r.cancelAt) blockedBecause = 'After the retainer ends'
    else if (chargeOn <= now) blockedBecause = 'Already charged'
    else if (!isPaused && runWith(month) > MAX_CONSECUTIVE_PAUSED_MONTHS)
      blockedBecause = `More than ${MAX_CONSECUTIVE_PAUSED_MONTHS} months in a row`
    return { month, chargeOn, paused: isPaused, canPause: !isPaused && !blockedBecause, blockedBecause }
  })
  return {
    retainer: await describeRetainer(db, r, now),
    maxInARow: MAX_CONSECUTIVE_PAUSED_MONTHS,
    months,
  }
}

export async function unpauseMonth(db: DbOrTx, p: Principal, clientRef: string, month: string, now = new Date()) {
  const r = await requireOpenRetainer(db, p, clientRef)
  if (chargeDateFor(month, r.currentPeriodEnd) <= now) {
    throw ruleBroken('That month has already started')
  }
  await db.delete(pauses).where(and(eq(pauses.retainerId, r.id), eq(pauses.month, month)))
  return { retainerId: r.id, month }
}

/** "A cancellation takes effect at the end of the month you've paid for." */
export async function cancelRetainer(db: DbOrTx, p: Principal, clientRef: string) {
  const r = await requireOpenRetainer(db, p, clientRef)
  if (r.status === 'cancelling') return r
  const [row] = await db
    .update(retainers)
    .set({ status: 'cancelling', cancelAt: r.currentPeriodEnd })
    .where(eq(retainers.id, r.id))
    .returning()
  return row
}


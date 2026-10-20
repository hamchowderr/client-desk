import { createHmac, timingSafeEqual } from 'node:crypto'
import { and, desc, eq, inArray, ne, sql } from 'drizzle-orm'
import type { Db, DbOrTx } from '../db/client'
import { billingEvents, contacts, retainers, type Retainer } from '../db/schema'
import { DeskError } from './errors'
import { type Principal, requireAdmin } from './principal'
import { requireOpenRetainer } from './retainers'
import { chargeDateFor, monthKey, shiftMonth } from './time'

/** How long before the next charge date a payment still counts as that charge. */
export const EARLY_PAYMENT_DAYS = 10
/** Stripe's own default tolerance for a signed webhook's timestamp. */
const SIGNATURE_TOLERANCE_SECONDS = 300

/**
 * Check a `Stripe-Signature` header against the raw body: HMAC-SHA256 of
 * "timestamp.body" with the endpoint's signing secret, within five minutes.
 */
export function verifyStripeSignature(rawBody: string, header: string | undefined, secret: string, now = new Date()) {
  if (!header) return false
  const parts = header.split(',').map((p) => p.trim().split('='))
  const t = parts.find(([k]) => k === 't')?.[1]
  const sigs = parts.filter(([k]) => k === 'v1').map(([, v]) => v)
  if (!t || !sigs.length) return false
  if (Math.abs(now.getTime() / 1000 - Number(t)) > SIGNATURE_TOLERANCE_SECONDS) return false
  const expected = Buffer.from(createHmac('sha256', secret).update(`${t}.${rawBody}`).digest('hex'))
  return sigs.some((s) => {
    const got = Buffer.from(s ?? '')
    return got.length === expected.length && timingSafeEqual(got, expected)
  })
}

/** The charge a month after `current`, on the same day (clamped to short months). */
export function nextChargeAfter(current: Date) {
  return chargeDateFor(shiftMonth(monthKey(current), 1), current)
}

type StripeInvoice = {
  id: string
  customer?: string | null
  customer_email?: string | null
  subscription?: string | null
  amount_paid?: number
  currency?: string
  status_transitions?: { paid_at?: number | null }
}
export type StripeEvent = { id: string; type: string; created: number; data: { object: unknown } }
export type StripeOutcome = {
  outcome: 'duplicate' | 'ignored' | 'unmatched' | 'recorded' | 'advanced'
  retainerId: string | null
  nextChargeAt?: Date
}

/**
 * The open retainer a Stripe invoice belongs to: by billing ref (customer or
 * subscription id), else by the invoice email matching a client contact. An
 * email match records the customer id, so later invoices match directly.
 */
async function retainerForInvoice(db: DbOrTx, inv: StripeInvoice): Promise<Retainer | null> {
  const refs = [inv.customer, inv.subscription].filter((x): x is string => Boolean(x))
  const open = ne(retainers.status, 'ended')
  if (refs.length) {
    const [r] = await db.select().from(retainers).where(and(open, inArray(retainers.billingRef, refs)))
    if (r) return r
  }
  const email = inv.customer_email?.trim().toLowerCase()
  if (!email) return null
  const matches = await db
    .select({ retainer: retainers })
    .from(contacts)
    .innerJoin(retainers, eq(retainers.clientId, contacts.clientId))
    .where(and(open, sql`lower(${contacts.email}) = ${email}`))
  const distinct = [...new Map(matches.map((m) => [m.retainer.id, m.retainer])).values()]
  if (distinct.length !== 1) return null
  const r = distinct[0]!
  if (!r.billingRef && inv.customer) {
    await db.update(retainers).set({ billingRef: inv.customer }).where(eq(retainers.id, r.id))
  }
  return r
}

/**
 * Apply one Stripe event. A paid invoice moves the retainer's next charge on a
 * month (so pauses and "paid through" stay right) when it pays the coming
 * charge; anything else is recorded and left alone. Redelivered events are
 * no-ops. Returns what the desk did, for the webhook response and the log.
 */
export function applyStripeEvent(db: Db, event: StripeEvent) {
  return db.transaction((tx) => applyInTx(tx, event))
}

async function applyInTx(db: DbOrTx, event: StripeEvent): Promise<StripeOutcome> {
  const [seen] = await db.select().from(billingEvents).where(eq(billingEvents.id, event.id))
  if (seen) return { outcome: 'duplicate', retainerId: seen.retainerId ?? null }

  const record = (fields: Partial<typeof billingEvents.$inferInsert> & { outcome: string }) =>
    db
      .insert(billingEvents)
      .values({ id: event.id, source: 'stripe', kind: event.type, ...fields })
      .onConflictDoNothing()

  if (event.type !== 'invoice.paid') {
    await record({ outcome: 'ignored' })
    return { outcome: 'ignored', retainerId: null }
  }

  const inv = event.data.object as StripeInvoice
  const paidAt = new Date(((inv.status_transitions?.paid_at ?? event.created) as number) * 1000)
  const base = { invoiceId: inv.id, amountCents: inv.amount_paid ?? null, currency: inv.currency ?? null, paidAt }
  const r = await retainerForInvoice(db, inv)
  if (!r) {
    await record({ ...base, outcome: 'unmatched' })
    return { outcome: 'unmatched', retainerId: null }
  }

  const windowOpens = new Date(r.currentPeriodEnd.getTime() - EARLY_PAYMENT_DAYS * 86_400_000)
  if (paidAt < windowOpens) {
    await record({ ...base, retainerId: r.id, outcome: 'recorded' })
    return { outcome: 'recorded', retainerId: r.id }
  }
  const next = nextChargeAfter(r.currentPeriodEnd)
  await db.update(retainers).set({ currentPeriodEnd: next }).where(eq(retainers.id, r.id))
  await record({ ...base, retainerId: r.id, outcome: `next charge ${next.toISOString().slice(0, 10)}` })
  return { outcome: 'advanced', retainerId: r.id, nextChargeAt: next }
}

/** Point a retainer at its billing record: a Stripe customer (cus_) or subscription (sub_) id. */
export async function linkBilling(db: DbOrTx, p: Principal, clientRef: string, ref: string) {
  requireAdmin(p)
  if (!/^(cus|sub)_[A-Za-z0-9]+$/.test(ref)) throw new DeskError('invalid', 'Use a Stripe customer (cus_…) or subscription (sub_…) id')
  const r = await requireOpenRetainer(db, p, clientRef)
  const [row] = await db.update(retainers).set({ billingRef: ref }).where(eq(retainers.id, r.id)).returning()
  return { billingRef: row!.billingRef }
}

/** Payments the desk has seen for a client, newest first. */
export async function billingHistory(db: DbOrTx, p: Principal, clientRef: string) {
  requireAdmin(p)
  const r = await requireOpenRetainer(db, p, clientRef)
  const rows = await db
    .select()
    .from(billingEvents)
    .where(eq(billingEvents.retainerId, r.id))
    .orderBy(desc(billingEvents.createdAt))
  return {
    billingRef: r.billingRef,
    nextChargeAt: r.currentPeriodEnd,
    payments: rows.map((e) => ({
      invoice: e.invoiceId,
      amount: e.amountCents == null ? null : { cents: e.amountCents, currency: e.currency },
      paidAt: e.paidAt,
      outcome: e.outcome,
    })),
  }
}

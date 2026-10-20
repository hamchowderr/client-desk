import { createHmac } from 'node:crypto'
import { beforeEach, describe, expect, it } from 'vitest'
import type { Db } from '../src/db/client'
import { retainers } from '../src/db/schema'
import { applyStripeEvent, billingHistory, linkBilling, type StripeEvent, verifyStripeSignature } from '../src/domain/billing'
import { addContact } from '../src/domain/clients'
import { OWNER } from '../src/domain/principal'
import { seedClient, testDb } from './helpers'

const secret = 'whsec_test'
const sign = (body: string, t: number) => `t=${t},v1=${createHmac('sha256', secret).update(`${t}.${body}`).digest('hex')}`

/** A paid invoice, charged on the 15th like seedClient's retainer. */
function paid(id: string, paidAt: string, invoice: Record<string, unknown> = {}): StripeEvent {
  const at = Math.floor(new Date(paidAt).getTime() / 1000)
  return {
    id,
    type: 'invoice.paid',
    created: at,
    data: {
      object: {
        id: `in_${id}`,
        customer: 'cus_GMA1',
        customer_email: 'Owner@GMA.example',
        amount_paid: 54900,
        currency: 'usd',
        status_transitions: { paid_at: at },
        ...invoice,
      },
    },
  }
}

/** What an import left behind: free text, not a Stripe id. */
const linkBillingNote = (db: Db) => db.update(retainers).set({ billingRef: 'Stripe invoice' })

const nextCharge = async (db: Db) => (await db.select().from(retainers))[0]!.currentPeriodEnd.toISOString()

describe('stripe signature', () => {
  const body = '{"id":"evt_1"}'
  const now = new Date('2026-11-15T12:00:00Z')
  const t = now.getTime() / 1000
  it('accepts a correct, fresh signature', () => {
    expect(verifyStripeSignature(body, sign(body, t), secret, now)).toBe(true)
  })
  it('rejects a wrong secret, a changed body, a stale timestamp or no header', () => {
    expect(verifyStripeSignature(body, sign(body, t).replace(/.$/, '0'), secret, now)).toBe(false)
    expect(verifyStripeSignature('{"id":"evt_2"}', sign(body, t), secret, now)).toBe(false)
    expect(verifyStripeSignature(body, sign(body, t - 301), secret, now)).toBe(false)
    expect(verifyStripeSignature(body, undefined, secret, now)).toBe(false)
  })
})

describe('stripe payments', () => {
  let db: Db
  beforeEach(async () => {
    db = await testDb()
    await seedClient(db) // next charge 2026-11-15
  })

  it('a paid invoice matched by contact email moves the next charge on a month and links the customer', async () => {
    await addContact(db, OWNER, 'GMA', { name: 'Owner', email: 'owner@gma.example', role: 'owner' })
    const r = await applyStripeEvent(db, paid('evt_1', '2026-11-15T12:05:00Z'))
    expect(r.outcome).toBe('advanced')
    expect(await nextCharge(db)).toBe('2026-12-15T12:00:00.000Z')

    const history = await billingHistory(db, OWNER, 'GMA')
    expect(history.billingRef).toBe('cus_GMA1')
    expect(history.payments).toEqual([
      expect.objectContaining({ invoice: 'in_evt_1', amount: { cents: 54900, currency: 'usd' }, outcome: 'next charge 2026-12-15' }),
    ])

    // Later invoices match on the customer id, whatever their email says.
    const next = await applyStripeEvent(db, paid('evt_2', '2026-12-15T12:01:00Z', { customer_email: 'billing@other.example' }))
    expect(next.outcome).toBe('advanced')
    expect(await nextCharge(db)).toBe('2027-01-15T12:00:00.000Z')
  })

  it('an email match replaces a billing note that is not a Stripe id', async () => {
    await linkBillingNote(db)
    await addContact(db, OWNER, 'GMA', { name: 'Owner', email: 'owner@gma.example', role: 'owner' })
    await applyStripeEvent(db, paid('evt_1', '2026-11-15T12:05:00Z'))
    expect((await billingHistory(db, OWNER, 'GMA')).billingRef).toBe('cus_GMA1')
  })

  it('a redelivered event changes nothing', async () => {
    await linkBilling(db, OWNER, 'GMA', 'cus_GMA1')
    await applyStripeEvent(db, paid('evt_1', '2026-11-15T12:05:00Z'))
    expect((await applyStripeEvent(db, paid('evt_1', '2026-11-15T12:05:00Z'))).outcome).toBe('duplicate')
    expect(await nextCharge(db)).toBe('2026-12-15T12:00:00.000Z')
  })

  it('a payment well before the next charge is recorded but does not move it', async () => {
    await linkBilling(db, OWNER, 'GMA', 'cus_GMA1')
    expect((await applyStripeEvent(db, paid('evt_1', '2026-10-20T12:00:00Z'))).outcome).toBe('recorded')
    expect(await nextCharge(db)).toBe('2026-11-15T12:00:00.000Z')
  })

  it('an invoice nobody matches, or another event type, is logged and left alone', async () => {
    expect((await applyStripeEvent(db, paid('evt_1', '2026-11-15T12:05:00Z'))).outcome).toBe('unmatched')
    expect((await applyStripeEvent(db, { id: 'evt_2', type: 'customer.created', created: 0, data: { object: {} } })).outcome).toBe('ignored')
    expect(await nextCharge(db)).toBe('2026-11-15T12:00:00.000Z')
  })

  it('only takes Stripe customer or subscription ids', async () => {
    await expect(linkBilling(db, OWNER, 'GMA', 'acct_123')).rejects.toMatchObject({ code: 'invalid' })
    await expect(linkBilling(db, OWNER, 'GMA', 'sub_123')).resolves.toEqual({ billingRef: 'sub_123' })
  })
})

import { beforeEach, describe, expect, it } from 'vitest'
import type { Db } from '../src/db/client'
import { contacts, retainers } from '../src/db/schema'
import { addPaidClient, hookSecretMatches, parseSignup } from '../src/domain/signup'
import { seedClient, testDb } from './helpers'
import { addContact } from '../src/domain/clients'
import { OWNER } from '../src/domain/principal'

describe('retainer-paid hook input', () => {
  it('reads custom data and the raw FluentCRM contact', () => {
    expect(parseSignup({ email: ' Dan@DGC.example ', first_name: 'Dan', last_name: 'Condell', company: 'DGC Strategy' })).toEqual({
      email: 'dan@dgc.example',
      name: 'Dan Condell',
      company: 'DGC Strategy',
    })
    expect(parseSignup({ subscriber: { email: 'a@b.co', full_name: 'Ann Lee', company: { name: 'Lee Co' } } })).toEqual({
      email: 'a@b.co',
      name: 'Ann Lee',
      company: 'Lee Co',
    })
    expect(parseSignup({ email: 'solo@b.co' })).toEqual({ email: 'solo@b.co', name: 'solo' })
  })
  it('refuses a body without a valid email', () => {
    expect(parseSignup({ email: 'nope' })).toBeNull()
    expect(parseSignup('x')).toBeNull()
    expect(parseSignup(null)).toBeNull()
  })
  it('checks the secret, and is off with none set', () => {
    expect(hookSecretMatches('s3cret', 's3cret')).toBe(true)
    expect(hookSecretMatches('wrong', 's3cret')).toBe(false)
    expect(hookSecretMatches('s3cret', '')).toBe(false)
    expect(hookSecretMatches(undefined, 's3cret')).toBe(false)
  })
})

describe('adding a paying client', () => {
  let db: Db
  beforeEach(async () => {
    db = await testDb()
  })

  it('adds the client, the payer as owner, and a $1,500 retainer charged a month later, in onboarding', async () => {
    const r = await addPaidClient(db, { email: 'dan@dgc.example', name: 'Dan Condell', company: 'DGC Strategy' }, new Date('2026-11-04T21:00:00Z'))
    expect(r.outcome).toBe('created')
    expect(r.code).toBe('DS')
    const [contact] = await db.select().from(contacts)
    expect(contact).toMatchObject({ name: 'Dan Condell', email: 'dan@dgc.example', role: 'owner' })
    const [retainer] = await db.select().from(retainers)
    expect(retainer.monthlyRateCents).toBe(150000)
    expect(retainer.activeLimit).toBe(1)
    expect(retainer.currentPeriodEnd.toISOString().slice(0, 10)).toBe('2026-12-04')
    expect(retainer.kickoffAt).toBeNull()
  })

  it('does nothing when the payer is already a contact', async () => {
    await seedClient(db)
    await addContact(db, OWNER, 'GMA', { name: 'Owner', email: 'Owner@GMA.example', role: 'owner' })
    const r = await addPaidClient(db, { email: 'owner@gma.example', name: 'Owner' })
    expect(r).toEqual({ outcome: 'already_client', code: 'GMA' })
    expect(await db.select().from(retainers)).toHaveLength(1)
  })

  it('picks another code when the suggested one is taken', async () => {
    await seedClient(db, { code: 'DS' })
    const r = await addPaidClient(db, { email: 'x@dgc.example', name: 'Dan Condell', company: 'DGC Strategy' })
    expect(r.code).toBe('DGCS')
  })
})

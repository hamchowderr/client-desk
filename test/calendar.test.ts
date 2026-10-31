import { beforeEach, describe, expect, it } from 'vitest'
import type { Db } from '../src/db/client'
import { calendar } from '../src/domain/calendar'
import { OWNER } from '../src/domain/principal'
import { createRequest } from '../src/domain/requests'
import { pauseMonth } from '../src/domain/retainers'
import { seedClient, testDb } from './helpers'

let db: Db

beforeEach(async () => {
  db = await testDb()
})

const context = { trigger: 'A new lead', result: 'Lead in the CRM', systems: 'HighLevel', currentWay: 'Typed in by hand', for: 'team' }

describe('calendar', () => {
  it("shows a month's requests, replies due and charges, and what's coming up", async () => {
    const { asClient } = await seedClient(db, { nextChargeAt: new Date('2026-12-15T12:00:00Z') })
    await createRequest(db, asClient, { client: 'GMA', title: 'Fix the lead form', ...context, receivedAt: new Date('2026-12-02T15:00:00Z') })

    const now = new Date('2026-12-02T16:00:00Z')
    const cal = await calendar(db, OWNER, { month: '2026-12' }, now)
    expect(cal.calendar).toBe('2026-12')
    expect(cal.events.map((e) => e.kind)).toEqual(['received', 'reply_due', 'charge'])
    expect(cal.events[0]).toMatchObject({ request: 'GMA-001', client: { code: 'GMA' }, for: 'Growth Mindset Advisors' })
    expect(cal.events[2].at.toISOString()).toBe('2026-12-15T12:00:00.000Z')
    expect(cal.upcoming.map((e) => e.kind)).toEqual(['reply_due', 'charge'])
  })

  it('marks a paused month instead of a charge', async () => {
    await seedClient(db, { nextChargeAt: new Date('2026-12-15T12:00:00Z') })
    await pauseMonth(db, OWNER, 'GMA', '2027-01', new Date('2026-12-01T00:00:00Z'))
    const cal = await calendar(db, OWNER, { month: '2027-01' }, new Date('2026-12-01T00:00:00Z'))
    expect(cal.events.map((e) => e.kind)).toEqual(['paused'])
  })

  it('a client sees only their own dates', async () => {
    const { asClient } = await seedClient(db)
    const other = await seedClient(db, { code: 'OTH' })
    await createRequest(db, other.asClient, { client: 'OTH', title: 'Theirs', ...context, receivedAt: new Date('2026-11-03T15:00:00Z') })
    await createRequest(db, asClient, { client: 'GMA', title: 'Mine', ...context, receivedAt: new Date('2026-11-03T15:00:00Z') })
    const cal = await calendar(db, asClient, { month: '2026-11' }, new Date('2026-11-01T00:00:00Z'))
    expect(cal.client?.code).toBe('GMA')
    expect(cal.events.every((e) => e.client.code === 'GMA')).toBe(true)
    expect(cal.events.some((e) => e.title === 'Mine')).toBe(true)
  })
})

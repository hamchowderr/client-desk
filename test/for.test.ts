import { beforeEach, describe, expect, it } from 'vitest'
import type { Db } from '../src/db/client'
import { addContact, getClientOverview } from '../src/domain/clients'
import { addCustomer, whoFor } from '../src/domain/customers'
import { OWNER } from '../src/domain/principal'
import { createRequest, listRequests, queueRequest, scopeRequest, setRequestFor, splitRequest } from '../src/domain/requests'
import { seedClient, testDb } from './helpers'

let db: Db

beforeEach(async () => {
  db = await testDb()
})

const context = {
  trigger: 'A new client signs',
  result: 'Their card is in the Rolodex',
  systems: 'Vercel, the intake form',
  currentWay: 'Typed in by hand',
}

async function setup() {
  const seeded = await seedClient(db)
  await addContact(db, OWNER, 'GMA', { name: 'Cass Cheung', email: 'ops@gma.example' })
  await addCustomer(db, OWNER, 'GMA', { firstName: 'Rene', lastName: 'Gonzalez', company: 'The Tax Doctor' })
  await addCustomer(db, OWNER, 'GMA', { firstName: 'Jared', lastName: 'Erdmann', company: 'Employer First Benefits Solutions' })
  return seeded
}

describe('who a request is for', () => {
  it('lists customers as first and last name with company, and the team under the client name', async () => {
    await setup()
    const w = await whoFor(db, OWNER, 'GMA')
    expect(w.customers.map((c) => c.label)).toEqual([
      'Jared Erdmann, Employer First Benefits Solutions',
      'Rene Gonzalez, The Tax Doctor',
    ])
    expect(w.team).toEqual(['Growth Mindset Advisors', 'Cass Cheung, Growth Mindset Advisors'])
  })

  it('matches a first name, a company or a team member, and keeps the full label', async () => {
    const { asClient } = await setup()
    const byFirst = await createRequest(db, asClient, { client: 'GMA', title: 'Rolodex', ...context, for: 'Rene' })
    expect(byFirst.for).toEqual({ kind: 'customer', name: 'Rene Gonzalez, The Tax Doctor' })
    const byCompany = await createRequest(db, asClient, { client: 'GMA', title: 'Agent', ...context, for: 'employer first' })
    expect(byCompany.for?.name).toBe('Jared Erdmann, Employer First Benefits Solutions')
    const byTeam = await createRequest(db, asClient, { client: 'GMA', title: 'Training', ...context, for: 'Cass' })
    expect(byTeam.for).toEqual({ kind: 'team', name: 'Cass Cheung, Growth Mindset Advisors' })
    const whole = await createRequest(db, asClient, { client: 'GMA', title: 'n8n cloud', ...context, for: 'Growth Mindset Advisors' })
    expect(whole.for).toEqual({ kind: 'team', name: 'Growth Mindset Advisors' })
  })

  it('refuses a name it does not know, and lists the choices', async () => {
    const { asClient } = await setup()
    await expect(createRequest(db, asClient, { client: 'GMA', title: 'X', ...context, for: 'Sam' })).rejects.toThrow(
      /isn't on Growth Mindset Advisors's list.*Rene Gonzalez, The Tax Doctor/,
    )
  })

  it("a client can't send a request without saying who it's for", async () => {
    const { asClient } = await setup()
    await expect(createRequest(db, asClient, { client: 'GMA', title: 'X', ...context })).rejects.toThrow(/who it's for/)
  })

  it("can't be queued until it says who it's for, and parts of a split keep it", async () => {
    await setup()
    const r = await createRequest(db, OWNER, { client: 'GMA', title: 'Big build', type: 'build', trigger: 't', result: 'r', sizeDays: 3 })
    await expect(queueRequest(db, OWNER, r.id)).rejects.toThrow(/who it's for/)
    await scopeRequest(db, OWNER, r.id, { for: 'Tax Doctor' })
    const parts = await splitRequest(db, OWNER, r.id, [
      { title: 'Part 1', sizeDays: 2 },
      { title: 'Part 2', sizeDays: 3 },
    ])
    expect(JSON.stringify(parts)).toContain('Rene Gonzalez, The Tax Doctor')
  })

  it('filters requests by who they are for and shows it in the client overview', async () => {
    const { asClient } = await setup()
    await createRequest(db, asClient, { client: 'GMA', title: 'Rolodex', ...context, for: 'Rene' })
    await createRequest(db, asClient, { client: 'GMA', title: 'Agent', ...context, for: 'Jared' })
    const tax = await listRequests(db, OWNER, { for: 'tax doctor' })
    expect(tax.map((r) => r.title)).toEqual(['Rolodex'])
    const o = await getClientOverview(db, OWNER, 'GMA')
    expect(o.intake.map((i) => i.for).sort()).toEqual([
      'Jared Erdmann, Employer First Benefits Solutions',
      'Rene Gonzalez, The Tax Doctor',
    ])
  })
  it('the client can add their own customer and change who a request is for', async () => {
    const { asClient } = await setup()
    const added = await addCustomer(db, asClient, asClient.kind === 'client' ? asClient.clientId : '', {
      firstName: 'Carlos',
      lastName: 'Diaz',
      company: 'Diaz Dental',
    })
    expect(added.label).toBe('Carlos Diaz, Diaz Dental')
    const r = await createRequest(db, asClient, { client: 'GMA', title: 'CRM move', ...context, for: 'Rene' })
    const moved = await setRequestFor(db, asClient, r.id, 'Carlos')
    expect(moved.for?.name).toBe('Carlos Diaz, Diaz Dental')
    await expect(
      addCustomer(db, asClient, asClient.kind === 'client' ? asClient.clientId : '', { firstName: 'carlos', lastName: 'diaz', company: 'diaz dental' }),
    ).rejects.toThrow(/already on/)
  })
})

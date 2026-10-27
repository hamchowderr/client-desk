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
  await addContact(db, OWNER, 'EA', { name: 'Casey Park', email: 'ops@ea.example' })
  await addCustomer(db, OWNER, 'EA', { firstName: 'Riley', lastName: 'Grant', company: 'The Tax Office' })
  await addCustomer(db, OWNER, 'EA', { firstName: 'Drew', lastName: 'Ellis', company: 'Benefit Partners Inc' })
  return seeded
}

describe('who a request is for', () => {
  it('lists customers as first and last name with company, and the team under the client name', async () => {
    await setup()
    const w = await whoFor(db, OWNER, 'EA')
    expect(w.customers.map((c) => c.label)).toEqual([
      'Drew Ellis, Benefit Partners Inc',
      'Riley Grant, The Tax Office',
    ])
    expect(w.team).toEqual(['Example Advisors', 'Casey Park, Example Advisors'])
  })

  it('matches a first name, a company or a team member, and keeps the full label', async () => {
    const { asClient } = await setup()
    const byFirst = await createRequest(db, asClient, { client: 'EA', title: 'Rolodex', ...context, for: 'Riley' })
    expect(byFirst.for).toEqual({ kind: 'customer', name: 'Riley Grant, The Tax Office' })
    const byCompany = await createRequest(db, asClient, { client: 'EA', title: 'Agent', ...context, for: 'benefit partners' })
    expect(byCompany.for?.name).toBe('Drew Ellis, Benefit Partners Inc')
    const byTeam = await createRequest(db, asClient, { client: 'EA', title: 'Training', ...context, for: 'Casey' })
    expect(byTeam.for).toEqual({ kind: 'team', name: 'Casey Park, Example Advisors' })
    const whole = await createRequest(db, asClient, { client: 'EA', title: 'n8n cloud', ...context, for: 'Example Advisors' })
    expect(whole.for).toEqual({ kind: 'team', name: 'Example Advisors' })
  })

  it('refuses a name it does not know, and lists the choices', async () => {
    const { asClient } = await setup()
    await expect(createRequest(db, asClient, { client: 'EA', title: 'X', ...context, for: 'Sam' })).rejects.toThrow(
      /isn't on Example Advisors's list.*Riley Grant, The Tax Office/,
    )
  })

  it("a client can't send a request without saying who it's for", async () => {
    const { asClient } = await setup()
    await expect(createRequest(db, asClient, { client: 'EA', title: 'X', ...context })).rejects.toThrow(/who it's for/)
  })

  it("can't be queued until it says who it's for, and parts of a split keep it", async () => {
    await setup()
    const r = await createRequest(db, OWNER, { client: 'EA', title: 'Big build', type: 'build', trigger: 't', result: 'r', sizeDays: 3 })
    await expect(queueRequest(db, OWNER, r.id)).rejects.toThrow(/who it's for/)
    await scopeRequest(db, OWNER, r.id, { for: 'Tax Office' })
    const parts = await splitRequest(db, OWNER, r.id, [
      { title: 'Part 1', sizeDays: 2 },
      { title: 'Part 2', sizeDays: 3 },
    ])
    expect(JSON.stringify(parts)).toContain('Riley Grant, The Tax Office')
  })

  it('filters requests by who they are for and shows it in the client overview', async () => {
    const { asClient } = await setup()
    await createRequest(db, asClient, { client: 'EA', title: 'Rolodex', ...context, for: 'Riley' })
    await createRequest(db, asClient, { client: 'EA', title: 'Agent', ...context, for: 'Drew' })
    const tax = await listRequests(db, OWNER, { for: 'tax office' })
    expect(tax.map((r) => r.title)).toEqual(['Rolodex'])
    const o = await getClientOverview(db, OWNER, 'EA')
    expect(o.intake.map((i) => i.for).sort()).toEqual([
      'Drew Ellis, Benefit Partners Inc',
      'Riley Grant, The Tax Office',
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
    const r = await createRequest(db, asClient, { client: 'EA', title: 'CRM move', ...context, for: 'Riley' })
    const moved = await setRequestFor(db, asClient, r.id, 'Carlos')
    expect(moved.for?.name).toBe('Carlos Diaz, Diaz Dental')
    await expect(
      addCustomer(db, asClient, asClient.kind === 'client' ? asClient.clientId : '', { firstName: 'carlos', lastName: 'diaz', company: 'diaz dental' }),
    ).rejects.toThrow(/already on/)
  })
})

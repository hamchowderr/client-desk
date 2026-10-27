import { beforeEach, describe, expect, it } from 'vitest'
import type { Db } from '../src/db/client'
import { getClientOverview } from '../src/domain/clients'
import { digest } from '../src/domain/digest'
import { DeskError } from '../src/domain/errors'
import { createApiKey, listApiKeys, mintApiKey, principalForKey, revokeKey } from '../src/domain/keys'
import { OWNER } from '../src/domain/principal'
import {
  addUpdate,
  closeRequest,
  createRequest,
  deliverRequest,
  getRequest,
  listRequests,
  queueRequest,
  reorderQueue,
  scopeRequest,
  splitRequest,
  startRequest,
} from '../src/domain/requests'
import { cancelRetainer, describeRetainer, logKickoff, pauseMonth, pausePlan, setActiveLimit } from '../src/domain/retainers'
import { replyDueAt } from '../src/domain/time'
import { scoped, seedClient, testDb } from './helpers'

const rule = (msg: RegExp) => expect.objectContaining({ code: 'rule', message: expect.stringMatching(msg) })

let db: Db
beforeEach(async () => {
  db = await testDb()
})

describe('same-day reply clock', () => {
  it('before 10pm on a weekday is due that day, client time', () => {
    // Wed 2026-10-14 21:30 in New York
    const due = replyDueAt(new Date('2026-10-15T01:30:00Z'), 'America/New_York')
    expect(due.toISOString()).toBe('2026-10-15T03:59:59.999Z') // 23:59:59 NY on the 14th
  })
  it('after 10pm rolls to the next business day', () => {
    // Fri 2026-10-16 22:15 in New York -> Monday the 19th
    const due = replyDueAt(new Date('2026-10-17T02:15:00Z'), 'America/New_York')
    expect(due.toISOString()).toBe('2026-10-20T03:59:59.999Z')
  })
  it('weekends roll to Monday', () => {
    const due = replyDueAt(new Date('2026-10-17T15:00:00Z'), 'Europe/London') // Sat
    expect(due.toISOString()).toBe('2026-10-19T22:59:59.999Z')
  })
})

const CONTEXT = {
  trigger: 'Someone fills in the website form',
  result: 'The lead is in the CRM and tagged',
  systems: 'WordPress form, HighLevel',
  currentWay: 'Copied in by hand each morning',
  for: 'team',
}

describe('intake and queue', () => {
  it('a client request lands as new with the reply clock running, and the owner answering stops it', async () => {
    const { asClient } = await seedClient(db)
    const r = await createRequest(db, asClient, {
      client: 'EA',
      title: 'Lead form stopped sending to CRM',
      ...CONTEXT,
      receivedAt: new Date('2026-10-15T01:00:00Z'),
    })
    expect(r.id).toBe('EA-001')
    expect(r.status).toBe('new')
    expect(r.replyDueAt).not.toBeNull()
    expect(r.systems).toBe(CONTEXT.systems)
    expect(r.currentWay).toBe(CONTEXT.currentWay)
    const board = await digest(db, OWNER, new Date('2026-10-15T02:00:00Z'))
    expect(board.repliesDue).toHaveLength(1)
    expect(board).not.toHaveProperty('spots')

    await scopeRequest(db, OWNER, 'EA-001', { type: 'fix', trigger: 'Form submit', result: 'Lead in CRM', sizeDays: 2 })
    expect((await digest(db, OWNER)).repliesDue).toHaveLength(0)
  })

  it("a client can't send a request without the full context, but the owner can log one bare", async () => {
    const { asClient } = await seedClient(db)
    const vague = createRequest(db, asClient, { client: 'EA', title: 'Fix our CRM', trigger: 'A new lead' })
    await expect(vague).rejects.toThrow(/what they get back.*which tools.*how it's done today/)
    await expect(createRequest(db, asClient, { client: 'EA', title: 'Fix our CRM', ...CONTEXT, systems: '  ' })).rejects.toThrow(
      /which tools/,
    )
    expect((await createRequest(db, OWNER, { client: 'EA', title: 'Fix our CRM' })).id).toBe('EA-001')
    const ok = await createRequest(db, asClient, { client: 'EA', title: 'Fix our CRM', ...CONTEXT, links: 'https://example.com/form' })
    expect(ok.links).toBe('https://example.com/form')
  })

  it('cannot queue until typed and scoped, and size must be 2 to 5 days', async () => {
    await seedClient(db)
    await createRequest(db, OWNER, { client: 'EA', title: 'Rebuild pipeline' })
    await expect(queueRequest(db, OWNER, 'EA-001')).rejects.toEqual(rule(/Missing: type, trigger, result, size/))
    await expect(scopeRequest(db, OWNER, 'EA-001', { sizeDays: 8 })).rejects.toEqual(rule(/2 to 5 business days/))
  })

  it('needs an open retainer to take a request', async () => {
    await seedClient(db)
    await cancelRetainer(db, OWNER, 'EA')
    // still open until the period end
    await expect(createRequest(db, OWNER, { client: 'EA', title: 'x' })).resolves.toBeTruthy()
  })
})

describe('active limit', () => {
  it('enforces the limit, and delivering starts the next in queue', async () => {
    await seedClient(db)
    for (const title of ['A', 'B']) {
      await createRequest(db, OWNER, { client: 'EA', title, ...scoped })
    }
    await queueRequest(db, OWNER, 'EA-001')
    await queueRequest(db, OWNER, 'EA-002')
    await startRequest(db, OWNER, 'EA-001')
    await expect(startRequest(db, OWNER, 'EA-002')).rejects.toEqual(rule(/already has 1 active request; their limit is 1/))

    const out = await deliverRequest(db, OWNER, 'EA-001', { note: 'Done, see link', deliverableUrl: 'https://loom.com/x' })
    expect(out.delivered.status).toBe('in_review')
    expect(out.started.map((s) => s.id)).toEqual(['EA-002'])
    await closeRequest(db, OWNER, 'EA-001')
  })

  it('raising the limit lets more run at once', async () => {
    await seedClient(db)
    for (const title of ['A', 'B', 'C']) {
      await createRequest(db, OWNER, { client: 'EA', title, ...scoped })
    }
    for (const id of ['EA-001', 'EA-002', 'EA-003']) await queueRequest(db, OWNER, id)
    await setActiveLimit(db, OWNER, 'EA', 3)
    for (const id of ['EA-001', 'EA-002', 'EA-003']) await startRequest(db, OWNER, id)
    const view = await getClientOverview(db, OWNER, 'EA')
    expect(view.active).toHaveLength(3)
  })

  it('no work before the kickoff call is logged', async () => {
    await seedClient(db, { kickoffDone: false })
    await createRequest(db, OWNER, { client: 'EA', title: 'A', ...scoped })
    await queueRequest(db, OWNER, 'EA-001')
    await expect(startRequest(db, OWNER, 'EA-001')).rejects.toEqual(rule(/kickoff/))
    await logKickoff(db, OWNER, 'EA')
    await expect(startRequest(db, OWNER, 'EA-001')).resolves.toMatchObject({ status: 'active' })
  })
})

describe('split and reorder', () => {
  it('splits big work into parts that queue where the parent sat', async () => {
    await seedClient(db)
    await createRequest(db, OWNER, { client: 'EA', title: 'First', ...scoped })
    await createRequest(db, OWNER, { client: 'EA', title: 'Rebuild sales pipeline', type: 'build', trigger: 'Deal won', result: 'Pipeline live', for: 'team' })
    await createRequest(db, OWNER, { client: 'EA', title: 'Last', ...scoped })
    await queueRequest(db, OWNER, 'EA-001')
    await scopeRequest(db, OWNER, 'EA-002', { sizeDays: 5 })
    await queueRequest(db, OWNER, 'EA-002')
    await queueRequest(db, OWNER, 'EA-003')
    const out = await splitRequest(db, OWNER, 'EA-002', [
      { title: 'Pipeline stages', sizeDays: 3 },
      { title: 'Deal automations', sizeDays: 4 },
    ])
    expect(out.parts.map((x) => x.id)).toEqual(['EA-004', 'EA-005'])
    const view = await getClientOverview(db, OWNER, 'EA')
    expect(view.queue.map((q) => q.title)).toEqual(['First', 'Pipeline stages', 'Deal automations', 'Last'])

    await reorderQueue(db, OWNER, 'EA', ['EA-003', 'EA-001', 'EA-004', 'EA-005'])
    const after = await getClientOverview(db, OWNER, 'EA')
    expect(after.queue.map((q) => q.id)).toEqual(['EA-003', 'EA-001', 'EA-004', 'EA-005'])
  })
})

describe('pauses', () => {
  const now = new Date('2026-10-20T00:00:00Z') // next charge 2026-11-15

  it('pauses a future month and refuses a fourth in a row', async () => {
    await seedClient(db)
    await pauseMonth(db, OWNER, 'EA', '2026-11', now)
    await pauseMonth(db, OWNER, 'EA', '2026-12', now)
    await pauseMonth(db, OWNER, 'EA', '2027-01', now)
    await expect(pauseMonth(db, OWNER, 'EA', '2027-02', now)).rejects.toEqual(rule(/4 months paused in a row/))
  })

  it('the pause plan shows the next six months and which can still be paused', async () => {
    const { asClient } = await seedClient(db)
    await pauseMonth(db, OWNER, 'EA', '2026-11', now)
    await pauseMonth(db, OWNER, 'EA', '2026-12', now)
    await pauseMonth(db, OWNER, 'EA', '2027-01', now)
    const plan = await pausePlan(db, asClient, 'EA', now)
    expect(plan.months).toHaveLength(6)
    expect(plan.months.slice(0, 4).map((m) => [m.month, m.paused, m.canPause])).toEqual([
      ['2026-11', true, false],
      ['2026-12', true, false],
      ['2027-01', true, false],
      ['2027-02', false, false],
    ])
    expect(plan.months[4]).toMatchObject({ month: '2027-03', canPause: true, blockedBecause: null })
  })

  it('must be asked before the charge that opens the month', async () => {
    await seedClient(db)
    await expect(pauseMonth(db, OWNER, 'EA', '2026-10', now)).rejects.toEqual(rule(/before the charge/))
  })

  it('a paused client keeps their queue but work does not start', async () => {
    const { retainer } = await seedClient(db)
    await createRequest(db, OWNER, { client: 'EA', title: 'A', ...scoped })
    await queueRequest(db, OWNER, 'EA-001')
    await pauseMonth(db, OWNER, 'EA', '2026-11', now)
    const during = new Date('2026-11-20T00:00:00Z')
    await expect(startRequest(db, OWNER, 'EA-001', during)).rejects.toEqual(rule(/paused this month/))
    expect((await describeRetainer(db, retainer, during)).status).toBe('paused')
    expect((await getClientOverview(db, OWNER, 'EA', during)).queue).toHaveLength(1)
  })
})

describe('client scope', () => {
  it('a client key sees only its own client and client-visible updates', async () => {
    const { asClient } = await seedClient(db)
    await seedClient(db, { code: 'ACA' })
    await createRequest(db, OWNER, { client: 'ACA', title: 'Other client work' })
    await createRequest(db, asClient, { client: 'EA', title: 'Mine', ...CONTEXT })
    await addUpdate(db, OWNER, 'EA-001', { body: 'internal thought' })
    await addUpdate(db, OWNER, 'EA-001', { body: 'On it today', visibility: 'client' })

    const mine = await getRequest(db, asClient, 'EA-001')
    expect(mine.timeline.map((t) => t.body)).toEqual(['Request received', 'On it today'])
    expect((await listRequests(db, asClient)).map((r) => r.client)).toEqual(['EA'])
    await expect(getRequest(db, asClient, 'ACA-001')).rejects.toBeInstanceOf(DeskError)
    await expect(createRequest(db, asClient, { client: 'ACA', title: 'sneaky', ...CONTEXT })).rejects.toMatchObject({ code: 'not_found' })
    await expect(startRequest(db, asClient, 'EA-001')).rejects.toMatchObject({ code: 'forbidden' })
  })

  it('api keys resolve to the right principal and are stored hashed', async () => {
    await seedClient(db)
    const admin = await createApiKey(db, { label: 'claude-desktop', scope: 'admin' })
    const client = await createApiKey(db, { label: 'ea-telegram', scope: 'client', client: 'EA' })
    expect(await principalForKey(db, admin.key)).toMatchObject({ kind: 'admin' })
    expect(await principalForKey(db, client.key)).toMatchObject({ kind: 'client' })
    expect(await principalForKey(db, 'desk_admin_nope')).toBeNull()
  })

  it('the owner mints, lists and revokes keys over the API; clients cannot', async () => {
    const { asClient } = await seedClient(db)
    const minted = await mintApiKey(db, OWNER, { label: 'ea-agent', scope: 'client', client: 'EA' })
    expect(await principalForKey(db, minted.key)).toMatchObject({ kind: 'client' })
    await expect(mintApiKey(db, OWNER, { label: 'x', scope: 'client' })).rejects.toMatchObject({ code: 'invalid' })
    await expect(mintApiKey(db, asClient, { label: 'x', scope: 'admin' })).rejects.toMatchObject({ code: 'forbidden' })

    const listed = await listApiKeys(db, OWNER)
    expect(listed).toEqual([expect.objectContaining({ id: minted.id, client: 'EA', revokedAt: null })])
    expect(JSON.stringify(listed)).not.toContain(minted.key)

    await revokeKey(db, OWNER, minted.id)
    expect(await principalForKey(db, minted.key)).toBeNull()
    await expect(revokeKey(db, OWNER, minted.id)).rejects.toMatchObject({ code: 'not_found' })
  })
})

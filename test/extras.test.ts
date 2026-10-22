import { beforeEach, describe, expect, it } from 'vitest'
import type { Db } from '../src/db/client'
import { addContact, getClientOverview } from '../src/domain/clients'
import { askClaudeUrl, emailClient, noticeEmail, recapEmail } from '../src/domain/notify'
import { OWNER } from '../src/domain/principal'
import { weeklyRecap } from '../src/domain/recap'
import { closeRequest, createRequest, deliverRequest, queueRequest, startRequest, waitOnClient } from '../src/domain/requests'
import { draftClientSetup, setupClient, suggestCode } from '../src/domain/setup'
import { scoped, seedClient, testDb } from './helpers'

let db: Db
beforeEach(async () => {
  db = await testDb()
})

describe('client emails', () => {
  it('ready for review: the note, the deliverable and a link that opens Claude on the request', () => {
    const e = noticeEmail(
      { kind: 'review', request: 'KBS-004', title: 'Rolodex', note: 'It <works>.', deliverableUrl: 'https://example.com/x' },
      'Rachel',
    )
    expect(e.subject).toBe('Ready for your review: Rolodex (KBS-004)')
    expect(e.html).toContain('Hi Rachel,')
    expect(e.html).toContain('It &lt;works&gt;.')
    expect(e.html).toContain('https://example.com/x')
    expect(e.html).toContain(askClaudeUrl('Show me KBS-004').replace(/&/g, '&amp;'))
  })

  it('a question quotes it and offers to answer in Claude', () => {
    const e = noticeEmail({ kind: 'question', request: 'KBS-002', title: 'GHL access', question: 'Which location?' }, '')
    expect(e.subject).toBe('A question about GHL access (KBS-002)')
    expect(e.html).toContain('Hi there,')
    expect(e.html).toContain('Which location?')
  })

  it('goes to every contact with an email, by first name', async () => {
    await seedClient(db)
    await addContact(db, OWNER, 'GMA', { name: 'Rachel Castro', email: 'r@gma.example', role: 'owner' })
    await addContact(db, OWNER, 'GMA', { name: 'No Email' })
    const sent: Array<{ to: string; subject: string }> = []
    const crm = {
      name: 'test',
      syncContact: async () => {},
      sendEmail: async (c: { email: string }, e: { subject: string }) => void sent.push({ to: c.email, subject: e.subject }),
    }
    const { client } = { client: (await getClientOverview(db, OWNER, 'GMA')).client }
    const to = await emailClient(db, crm, client.id, (first) => ({ subject: `hi ${first}`, html: '' }))
    expect(to).toEqual(['r@gma.example'])
    expect(sent).toEqual([{ to: 'r@gma.example', subject: 'hi Rachel' }])
  })
})

describe('weekly recap', () => {
  const now = new Date('2026-10-23T20:00:00Z')
  it('shows what was delivered this week, what is in progress, waiting and up next', async () => {
    const { asClient } = await seedClient(db, { activeLimit: 2 })
    const mk = async (title: string) => (await createRequest(db, OWNER, { client: 'GMA', title, ...scoped })).id
    const shipped = await mk('Shipped')
    const old = await mk('Old')
    const active = await mk('Active')
    const waiting = await mk('Waiting')
    const next = await mk('Next')
    for (const id of [shipped, old, active, next]) await queueRequest(db, OWNER, id)
    await startRequest(db, OWNER, old, new Date('2026-10-01T12:00:00Z'))
    await deliverRequest(db, OWNER, old, { note: 'done', startNext: false }, new Date('2026-10-05T12:00:00Z'))
    await closeRequest(db, OWNER, old)
    await startRequest(db, OWNER, shipped, new Date('2026-10-19T12:00:00Z'))
    await deliverRequest(db, OWNER, shipped, { note: 'here', startNext: false }, new Date('2026-10-22T12:00:00Z'))
    await startRequest(db, OWNER, active, new Date('2026-10-22T13:00:00Z'))
    await waitOnClient(db, OWNER, waiting, 'Which one?')

    const r = await weeklyRecap(db, asClient, 'GMA', now)
    expect(r.shipped.map((i) => i.title)).toEqual(['Shipped'])
    expect(r.inProgress.map((i) => i.title)).toEqual(['Active'])
    expect(r.waitingOnYou.map((i) => i.title)).toEqual(['Waiting'])
    expect(r.upNext.map((i) => i.title)).toEqual(['Next'])
    expect(r.headline).toBe('1 delivered, 1 in progress, 1 waiting on you')
    expect(recapEmail(r, 'Rachel').html).toContain('Shipped')
  })
})

describe('new client setup', () => {
  it('suggests a code and says what is missing, without saving', async () => {
    expect(suggestCode('Growth Mindset Advisors')).toBe('GMA')
    expect(suggestCode('KnowBS')).toBe('KNO')
    await seedClient(db)
    const d = await draftClientSetup(db, OWNER, { name: 'Growth Mindset Advisors', contactName: 'Pat' })
    expect(d.setup.code).toBe('GMA')
    expect(d.codeTaken).toBe(true)
    expect(d.missing).toEqual(['contact email', 'monthly rate', 'first charge date'])
  })

  it('adds the client, owner contact, retainer and kickoff in one step', async () => {
    const out = await setupClient(db, OWNER, {
      name: 'Acme Co',
      code: 'acm',
      timezone: 'America/Chicago',
      contactName: 'Pat Lee',
      contactEmail: 'pat@acme.example',
      monthlyRateCents: 150000,
      activeLimit: 2,
      nextChargeAt: '2026-11-01',
      kickoffDone: true,
    })
    expect(out.client.code).toBe('ACM')
    expect(out.retainer).toMatchObject({ status: 'active', activeLimit: 2, monthlyRate: { cents: 150000, currency: 'usd' } })
    expect(out.contacts).toEqual([expect.objectContaining({ name: 'Pat Lee', role: 'owner' })])
  })

  it('saves nothing when a step fails', async () => {
    await seedClient(db)
    const input = {
      name: 'Dup',
      code: 'GMA',
      timezone: 'America/Chicago',
      contactName: 'X',
      contactEmail: 'x@x.example',
      monthlyRateCents: 100,
      activeLimit: 1,
      nextChargeAt: '2026-11-01',
      kickoffDone: false,
    }
    await expect(setupClient(db, OWNER, input)).rejects.toMatchObject({ code: 'conflict' })
    await expect(setupClient(db, OWNER, { ...input, code: 'NEW', timezone: 'Not/AZone' })).rejects.toMatchObject({ code: 'invalid' })
    await expect(getClientOverview(db, OWNER, 'NEW')).rejects.toMatchObject({ code: 'not_found' })
  })
})

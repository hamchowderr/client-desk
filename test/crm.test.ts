import { beforeEach, describe, expect, it } from 'vitest'
import type { CrmAdapter, CrmContact } from '../src/crm'
import { FluentCrm } from '../src/crm/fluentcrm'
import type { Db } from '../src/db/client'
import { addContact } from '../src/domain/clients'
import { syncClientToCrm, syncCrm } from '../src/domain/crm'
import { OWNER } from '../src/domain/principal'
import { cancelRetainer, pauseMonth } from '../src/domain/retainers'
import { seedClient, testDb } from './helpers'

type Call = { contact: CrmContact; attach: string[]; detach: string[] }
function fakeCrm() {
  const calls: Call[] = []
  const crm: CrmAdapter = {
    name: 'fake',
    async syncContact(contact, tags) {
      calls.push({ contact, attach: tags.attach.map((t) => t.slug), detach: tags.detach })
    },
  }
  return { crm, calls }
}

describe('crm sync', () => {
  let db: Db
  beforeEach(async () => {
    db = await testDb()
  })

  it('tags each contact with an email by client and retainer state', async () => {
    const { client } = await seedClient(db)
    await addContact(db, OWNER, 'GMA', { name: 'Rachel Marie Castro', email: 'rachel@gma.example', role: 'owner' })
    await addContact(db, OWNER, 'GMA', { name: 'No Email' })
    const { crm, calls } = fakeCrm()
    await syncClientToCrm(db, crm, client.id, new Date('2026-10-20T12:00:00Z'))
    expect(calls).toEqual([
      {
        contact: { email: 'rachel@gma.example', firstName: 'Rachel', lastName: 'Marie Castro' },
        attach: ['desk-client', 'desk-gma', 'desk-active'],
        detach: ['desk-onboarding', 'desk-paused', 'desk-cancelling', 'desk-ended'],
      },
    ])
  })

  it('follows the retainer: paused in a paused month, cancelling after a cancel', async () => {
    const { client } = await seedClient(db) // charged on the 15th
    await addContact(db, OWNER, 'GMA', { name: 'Owner', email: 'owner@gma.example', role: 'owner' })
    await pauseMonth(db, OWNER, 'GMA', '2026-12', new Date('2026-10-20T12:00:00Z'))
    const { crm, calls } = fakeCrm()
    await syncClientToCrm(db, crm, client.id, new Date('2026-12-20T12:00:00Z'))
    expect(calls.at(-1)!.attach).toContain('desk-paused')
    await cancelRetainer(db, OWNER, 'GMA')
    await syncClientToCrm(db, crm, client.id, new Date('2026-10-20T12:00:00Z'))
    expect(calls.at(-1)!.attach).toContain('desk-cancelling')
  })

  it('does nothing without a CRM, and only the owner can run it', async () => {
    const { asClient } = await seedClient(db)
    expect(await syncCrm(db, OWNER, null)).toEqual({ crm: null, synced: [] })
    await expect(syncCrm(db, asClient, fakeCrm().crm)).rejects.toMatchObject({ code: 'forbidden' })
  })
})

describe('fluentcrm adapter', () => {
  function fakeFetch(existing: { id: number; email: string }[], tags: string[]) {
    const seen: { method: string; path: string; body?: any }[] = []
    const f = (async (url: string, init: RequestInit) => {
      const path = url.replace('https://hub.example/wp-json/fluent-crm/v2', '')
      const body = init.body ? JSON.parse(String(init.body)) : undefined
      seen.push({ method: init.method!, path, body })
      expect((init.headers as Record<string, string>).authorization).toBe(`Basic ${Buffer.from('bot:app pw').toString('base64')}`)
      const json = path.startsWith('/subscribers?')
        ? { subscribers: { data: existing } }
        : path.startsWith('/tags?')
          ? { tags: { data: tags.map((slug) => ({ slug })) } }
          : path === '/subscribers'
            ? { contact: { id: 99 } }
            : {}
      return new Response(JSON.stringify(json), { status: 200 })
    }) as unknown as typeof fetch
    return { f, seen }
  }
  const tags = { attach: [{ slug: 'desk-client', title: 'Desk client' }, { slug: 'desk-active', title: 'Desk: Active' }], detach: ['desk-paused'] }
  const contact = { email: 'Rachel@KnowBS.biz', firstName: 'Rachel', lastName: 'Castro' }

  it('adds a new contact as transactional, creates missing tags, then tags them', async () => {
    const { f, seen } = fakeFetch([], ['desk-client'])
    await new FluentCrm('https://hub.example/', 'bot:app pw', f).syncContact(contact, tags)
    expect(seen.find((c) => c.path === '/subscribers')!.body).toMatchObject({ email: 'Rachel@KnowBS.biz', status: 'transactional' })
    expect(seen.filter((c) => c.path === '/tags').map((c) => c.body.slug)).toEqual(['desk-active'])
    expect(seen.at(-1)).toEqual({
      method: 'POST',
      path: '/subscribers/sync-segments',
      body: { type: 'tags', subscribers: [99], find_by: 'slug', attach: ['desk-client', 'desk-active'], detach: ['desk-paused'] },
    })
  })

  it('leaves an existing contact (and its status) as it is, only changing tags', async () => {
    const { f, seen } = fakeFetch([{ id: 7, email: 'rachel@knowbs.biz' }], ['desk-client', 'desk-active'])
    await new FluentCrm('https://hub.example', 'bot:app pw', f).syncContact(contact, tags)
    expect(seen.some((c) => c.path === '/subscribers')).toBe(false)
    expect(seen.at(-1)!.body.subscribers).toEqual([7])
  })
})

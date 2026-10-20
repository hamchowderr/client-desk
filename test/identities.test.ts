import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Db } from '../src/db/client'
import { addContact } from '../src/domain/clients'
import { chatSender, inviteContact, linkCommand, redeemLinkCode, unlinkContact } from '../src/domain/identities'
import { OWNER } from '../src/domain/principal'
import { seedClient, testDb } from './helpers'

let db: Db
beforeEach(async () => {
  db = await testDb()
})

describe('linking chat accounts', () => {
  it('a link code links the account once, and the sender then acts as that client', async () => {
    const { client, asClient } = await seedClient(db)
    const rachel = await addContact(db, OWNER, 'GMA', { name: 'Rachel Castro', email: 'rachel@gma.example', role: 'owner' })
    expect(await chatSender(db, 'teams', 'aad-1')).toBeNull()

    const { code } = await inviteContact(db, OWNER, 'GMA', 'Rachel@GMA.example')
    expect(code).toMatch(/^[2-9A-Z]{4}-[2-9A-Z]{4}$/)
    await expect(inviteContact(db, asClient, 'GMA', 'rachel@gma.example')).rejects.toMatchObject({ code: 'forbidden' })

    const linked = await redeemLinkCode(db, 'teams', 'aad-1', code.toLowerCase().replace('-', ''))
    expect(linked?.principal).toEqual({ kind: 'client', clientId: client.id, contactId: rachel!.id, label: 'teams:Rachel Castro' })
    await expect(redeemLinkCode(db, 'teams', 'aad-2', code)).rejects.toMatchObject({ code: 'invalid' })
    expect((await chatSender(db, 'teams', 'aad-1'))?.role).toBe('owner')

    expect(await unlinkContact(db, OWNER, 'GMA', rachel!.id)).toEqual({ contact: 'Rachel Castro', unlinked: ['teams'] })
    expect(await chatSender(db, 'teams', 'aad-1')).toBeNull()
  })

  it('codes expire after a week', async () => {
    await seedClient(db)
    await addContact(db, OWNER, 'GMA', { name: 'Cass', email: 'cass@gma.example' })
    const { code } = await inviteContact(db, OWNER, 'GMA', 'cass@gma.example', new Date('2026-10-01T00:00:00Z'))
    await expect(redeemLinkCode(db, 'teams', 'aad-9', code, new Date('2026-10-09T00:00:00Z'))).rejects.toMatchObject({ code: 'invalid' })
  })

  it('an email the platform vouches for links itself when exactly one contact has it', async () => {
    await seedClient(db)
    await addContact(db, OWNER, 'GMA', { name: 'Violet', email: 'violet@gma.example' })
    expect((await chatSender(db, 'teams', 'aad-3', 'VIOLET@gma.example'))?.name).toBe('Violet')
    expect((await chatSender(db, 'teams', 'aad-3'))?.name).toBe('Violet')
    expect(await chatSender(db, 'teams', 'aad-4', 'stranger@else.example')).toBeNull()
  })

  it('reads the link command out of a chat message, mention or not', () => {
    expect(linkCommand('link K7QM-4XPA')).toBe('K7QM-4XPA')
    expect(linkCommand('<at>Otaku Solutions</at> link k7qm4xpa')).toBe('k7qm4xpa')
    expect(linkCommand('can you link the CRM to the form')).toBeNull()
  })
})

describe('client agent gate', () => {
  it('answers unknown senders without running the agent, and runs it as the client for linked ones', async () => {
    const { client } = await seedClient(db)
    await addContact(db, OWNER, 'GMA', { name: 'Rachel Castro', email: 'rachel@gma.example', role: 'owner' })
    vi.doMock('../src/db/client', async (orig) => ({ ...(await orig<object>()), getDb: () => db }))
    const { gate } = await import('../src/mastra/agents/client-agent')

    const posts: string[] = []
    const thread = { adapter: { name: 'teams' }, post: async (t: string) => void posts.push(t) } as any
    const ctxValues = new Map<string, unknown>()
    const ctx = { requestContext: { set: (k: string, v: unknown) => ctxValues.set(k, v) } } as any
    const run = vi.fn(async () => {})
    const msg = (text: string, userId: string, email?: string) =>
      ({ text, author: { userId, email, isBot: false, isMe: false, fullName: '', userName: '' } }) as any

    await gate(thread, msg('hi', 'aad-x'), run, ctx)
    expect(run).not.toHaveBeenCalled()
    expect(posts.at(-1)).toMatch(/link code/)

    const { code } = await inviteContact(db, OWNER, 'GMA', 'rachel@gma.example')
    await gate(thread, msg(`link ${code}`, 'aad-x'), run, ctx)
    expect(posts.at(-1)).toMatch(/^Linked\. Hi Rachel/)
    expect(run).not.toHaveBeenCalled()

    await gate(thread, msg('where is my rolodex?', 'aad-x'), run, ctx)
    expect(run).toHaveBeenCalledOnce()
    expect((ctxValues.get('user') as any).principal).toMatchObject({ kind: 'client', clientId: client.id })
    vi.doUnmock('../src/db/client')
  })
})

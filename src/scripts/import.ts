// npm run import -- clients.json
// Loads current retainer clients and their open requests. Safe to re-run:
// clients that already exist (by code) are skipped. See clients.example.json.
import { readFile } from 'node:fs/promises'
import { z } from 'zod'
import { getDb } from '../db/client'
import { REQUEST_TYPES } from '../db/schema'
import { addChannel, addContact, createClient } from '../domain/clients'
import { DeskError } from '../domain/errors'
import { OWNER } from '../domain/principal'
import { createRequest, queueRequest, startRequest } from '../domain/requests'
import { startRetainer } from '../domain/retainers'

const File = z.array(
  z.object({
    code: z.string(),
    name: z.string(),
    company: z.string().optional(),
    timezone: z.string().optional(),
    vaultNote: z.string().optional(),
    retainer: z.object({
      monthlyRateCents: z.number().int().positive(),
      nextChargeAt: z.coerce.date(),
      startedAt: z.coerce.date().optional(),
      activeLimit: z.number().int().optional(),
      billingRef: z.string().optional(),
    }),
    contacts: z
      .array(
        z.object({
          name: z.string(),
          email: z.string().optional(),
          role: z.enum(['owner', 'member']).optional(),
          telegramId: z.string().optional(),
          slackId: z.string().optional(),
        }),
      )
      .default([]),
    channels: z.array(z.object({ kind: z.enum(['telegram', 'slack', 'portal', 'email']), externalId: z.string() })).default([]),
    requests: z
      .array(
        z.object({
          title: z.string(),
          type: z.enum(REQUEST_TYPES).optional(),
          trigger: z.string().optional(),
          result: z.string().optional(),
          sizeDays: z.number().int().min(2).max(5).optional(),
          /** Where it stands today. Requests are imported in queue order. */
          state: z.enum(['active', 'queued', 'intake']).default('intake'),
        }),
      )
      .default([]),
  }),
)

const path = process.argv[2]
if (!path) {
  console.error('Usage: npm run import -- clients.json')
  process.exit(1)
}
const data = File.parse(JSON.parse(await readFile(path, 'utf8')))
const db = getDb()

for (const c of data) {
  try {
    await createClient(db, OWNER, { code: c.code, name: c.name, company: c.company, timezone: c.timezone, vaultNote: c.vaultNote })
  } catch (e) {
    if (e instanceof DeskError && e.code === 'conflict') {
      console.log(`skip ${c.code}: already exists`)
      continue
    }
    throw e
  }
  // Existing clients are past their kickoff.
  await startRetainer(db, OWNER, { client: c.code, ...c.retainer, kickoffDone: true })
  for (const contact of c.contacts) await addContact(db, OWNER, c.code, contact)
  for (const ch of c.channels) await addChannel(db, OWNER, c.code, ch)
  for (const r of c.requests) {
    const { state, ...fields } = r
    const created = await createRequest(db, OWNER, { client: c.code, source: 'import', ...fields })
    if (state === 'intake') continue
    await queueRequest(db, OWNER, created.id)
    if (state === 'active') await startRequest(db, OWNER, created.id)
  }
  console.log(`imported ${c.code} with ${c.requests.length} requests`)
}
process.exit(0)

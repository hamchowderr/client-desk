import { PGlite } from '@electric-sql/pglite'
import { drizzle } from 'drizzle-orm/pglite'
import { migrate } from 'drizzle-orm/pglite/migrator'
import type { Db } from '../src/db/client'
import * as schema from '../src/db/schema'
import { createClient } from '../src/domain/clients'
import { OWNER, type Principal } from '../src/domain/principal'
import { startRetainer } from '../src/domain/retainers'

/** A fresh in-memory Postgres with the real migrations applied. */
export async function testDb(): Promise<Db> {
  const client = new PGlite()
  const db = drizzle(client, { schema })
  await migrate(db, { migrationsFolder: new URL('../drizzle', import.meta.url).pathname })
  return db as unknown as Db
}

/** A client on an active retainer, charged on the 15th. */
export async function seedClient(
  db: Db,
  opts: { code?: string; timezone?: string; activeLimit?: number; kickoffDone?: boolean; nextChargeAt?: Date } = {},
) {
  const client = await createClient(db, OWNER, {
    code: opts.code ?? 'GMA',
    name: 'Growth Mindset Advisors',
    timezone: opts.timezone ?? 'America/New_York',
  })
  const retainer = await startRetainer(db, OWNER, {
    client: client.code,
    monthlyRateCents: 54900,
    activeLimit: opts.activeLimit ?? 1,
    nextChargeAt: opts.nextChargeAt ?? new Date('2026-11-15T12:00:00Z'),
    kickoffDone: opts.kickoffDone ?? true,
  })
  const asClient: Principal = { kind: 'client', clientId: client.id, label: 'gma-agent' }
  return { client, retainer, asClient }
}

export const scoped = { type: 'build' as const, trigger: 'Form submitted', result: 'Lead in CRM', sizeDays: 3 }

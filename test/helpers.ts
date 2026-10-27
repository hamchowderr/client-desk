import { PGlite } from '@electric-sql/pglite'
import { drizzle } from 'drizzle-orm/pglite'
import { migrate } from 'drizzle-orm/pglite/migrator'
import { drizzle as pgDrizzle } from 'drizzle-orm/postgres-js'
import { migrate as pgMigrate } from 'drizzle-orm/postgres-js/migrator'
import postgres from 'postgres'
import type { Db } from '../src/db/client'
import * as schema from '../src/db/schema'
import { createClient } from '../src/domain/clients'
import { OWNER, type Principal } from '../src/domain/principal'
import { startRetainer } from '../src/domain/retainers'

const migrationsFolder = new URL('../drizzle', import.meta.url).pathname

let databases = 0
const urls = new WeakMap<object, string>()

/** Another connection to the same server database, to race two callers. */
export function secondConnection(db: Db): Db {
  const url = urls.get(db)
  if (!url) throw new Error('secondConnection needs TEST_DATABASE_URL')
  return pgDrizzle(postgres(url, { max: 1, prepare: false, onnotice: () => {} }), { schema }) as unknown as Db
}

/**
 * A fresh database with the real migrations applied: in-memory PGlite, or a new
 * database on the server at TEST_DATABASE_URL (e.g. a local Doltgres).
 */
export async function testDb(): Promise<Db> {
  const serverUrl = process.env.TEST_DATABASE_URL
  if (serverUrl) {
    const name = `desk_test_${process.pid}_${databases++}`
    const admin = postgres(serverUrl, { max: 1, prepare: false, onnotice: () => {} })
    await admin.unsafe(`create database ${name}`)
    await admin.end()
    const url = new URL(serverUrl)
    url.pathname = `/${name}`
    const db = pgDrizzle(postgres(url.toString(), { max: 1, prepare: false, onnotice: () => {} }), { schema })
    await pgMigrate(db, { migrationsFolder })
    urls.set(db, url.toString())
    return db as unknown as Db
  }
  const client = new PGlite()
  const db = drizzle(client, { schema })
  await migrate(db, { migrationsFolder })
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

export const scoped = { type: 'build' as const, trigger: 'Form submitted', result: 'Lead in CRM', sizeDays: 3, for: 'team' }

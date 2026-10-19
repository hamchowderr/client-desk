import type { ExtractTablesWithRelations } from 'drizzle-orm'
import type { PgDatabase, PgQueryResultHKT, PgTransaction } from 'drizzle-orm/pg-core'
import { drizzle } from 'drizzle-orm/postgres-js'
import postgres from 'postgres'
import * as schema from './schema'

export type Schema = typeof schema
/** Any Drizzle Postgres database over the desk tables (postgres-js in prod, PGlite in tests). */
export type Db = PgDatabase<PgQueryResultHKT, Schema>
export type Tx = PgTransaction<PgQueryResultHKT, Schema, ExtractTablesWithRelations<Schema>>
export type DbOrTx = Db | Tx

let cached: Db | undefined

/**
 * The desk's database. DATABASE_URL points at Doltgres in production (any
 * Postgres works, without history); prepared statements stay off so poolers work.
 */
export function getDb(): Db {
  if (cached) return cached
  const url = process.env.DATABASE_URL
  if (!url) throw new Error('DATABASE_URL is not set')
  const sqlClient = postgres(url, { prepare: false, max: 5 })
  cached = drizzle(sqlClient, { schema }) as unknown as Db
  return cached
}

/** Tests swap in a PGlite database. */
export function setDb(db: Db) {
  cached = db
}

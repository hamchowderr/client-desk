// Applies drizzle/ migrations to DATABASE_URL (the desk's Doltgres database, or
// any Postgres). On Doltgres the result is committed so history starts clean.
//
// One-off move: with COPY_FROM_DATABASE_URL set (the old Supabase database, desk
// tables in its `desk` schema) and an empty desk, every row is copied across,
// ids and all, and committed as one change.
import { drizzle } from 'drizzle-orm/postgres-js'
import { migrate } from 'drizzle-orm/postgres-js/migrator'
import postgres from 'postgres'

const url = process.env.DATABASE_URL
if (!url) throw new Error('DATABASE_URL is not set')
const sql = postgres(url, { max: 1, prepare: false, onnotice: () => {} })

// The database container may still be starting.
for (let attempt = 1; ; attempt++) {
  try {
    await sql`select 1`
    break
  } catch (e) {
    if (attempt >= 30) throw e
    await new Promise((r) => setTimeout(r, 2000))
  }
}
await migrate(drizzle(sql), { migrationsFolder: 'drizzle' })
console.log('migrations applied')

const dolt = await sql`select dolt_version()`.then(
  () => true,
  () => false,
)
const commit = async (message: string) => {
  if (!dolt) return
  try {
    await sql`select dolt_commit('-A', '-m', ${message}, '--author', 'migrate <desk@otakusolutions.io>')`
  } catch (e) {
    if (!/nothing to commit/i.test(String((e as Error).message))) throw e
  }
}
await commit('migrate')

// Parents before children, so foreign keys hold row by row.
const TABLES = ['clients', 'contacts', 'channels', 'retainers', 'pauses', 'requests', 'updates', 'api_keys']

const from = process.env.COPY_FROM_DATABASE_URL
if (from) {
  const [{ n }] = await sql`select count(*)::int as n from clients`
  if (n > 0) {
    console.log('copy skipped: the desk already has clients')
  } else {
    const src = postgres(from, { max: 1, prepare: false, onnotice: () => {} })
    for (const table of TABLES) {
      const target = await sql`select column_name from information_schema.columns where table_schema = 'public' and table_name = ${table}`
      const wanted = new Set(target.map((c) => c.column_name as string))
      // requests reference their parent request; copy parents first.
      const order = table === 'requests' ? src`order by parent_id nulls first, number` : src``
      const rows = await src`select * from desk.${src(table)} ${order}`
      for (const row of rows) {
        const values = Object.fromEntries(
          Object.entries(row)
            .filter(([k]) => wanted.has(k))
            .map(([k, v]) => [k, v instanceof Date ? v.toISOString() : v]),
        )
        await sql`insert into ${sql(table)} ${sql(values)}`
      }
      console.log(`copied ${rows.length} ${table}`)
    }
    await src.end()
    await commit('Copy the desk from Supabase')
  }
}
await sql.end()

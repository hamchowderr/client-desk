// Applies drizzle/ migrations to DATABASE_URL (the Supabase connection string).
// Use the session pooler or direct connection (port 5432) for migrations.
import { drizzle } from 'drizzle-orm/postgres-js'
import { migrate } from 'drizzle-orm/postgres-js/migrator'
import postgres from 'postgres'

const url = process.env.DATABASE_URL
if (!url) throw new Error('DATABASE_URL is not set')
const sql = postgres(url, { max: 1, prepare: false, onnotice: () => {} })
await migrate(drizzle(sql), { migrationsFolder: 'drizzle' })
await sql.end()
console.log('migrations applied')

import { Mastra } from '@mastra/core'
import { PostgresStore } from '@mastra/pg'
import { crmFromEnv } from '../crm'
import { getDb } from '../db/client'
import { syncCrm } from '../domain/crm'
import { OWNER } from '../domain/principal'
import { clientAgent } from './agents/client-agent'
import { DeskKeyAuth } from './auth/key-auth'
import { clientMcp, deskMcp } from './mcp'
import { migrateAuth } from '../auth'
import { mcpRoute } from '../auth/mcp-route'
import { authRoutes } from '../auth/routes'
import { deskRoutes } from './routes'

/**
 * Client Desk. One Mastra server (Hono under the hood) serves:
 * - REST under /desk/* (OpenAPI at /api/openapi.json)
 * - MCP at /mcp: sign in with an emailed code (Better Auth, src/auth), and the
 *   email picks the client, or the owner's admin tools. Keys still work there and at
 *   /api/mcp/desk/mcp (admin) and /api/mcp/desk-client/mcp (client keys)
 * - the client agent, in each client's own chat (Teams first) at
 *   /api/agents/client-agent/channels/<platform>/webhook
 */
export const mastra = new Mastra({
  // Mastra's own tables (traces, threads, later agent memory) need no history, so
  // they stay in plain Postgres (Supabase); the desk itself is on Doltgres.
  ...(process.env.MASTRA_DATABASE_URL && {
    storage: new PostgresStore({
      id: 'desk-mastra',
      connectionString: process.env.MASTRA_DATABASE_URL,
      schemaName: 'mastra',
    }),
  }),
  agents: { clientAgent },
  mcpServers: { desk: deskMcp, 'desk-client': clientMcp },
  server: {
    port: Number(process.env.PORT ?? 4111),
    host: process.env.HOST ?? '0.0.0.0',
    auth: new DeskKeyAuth(),
    apiRoutes: [...deskRoutes, ...authRoutes, mcpRoute],
    build: { openAPIDocs: true, swaggerUI: true },
  },
})

// Retainer states also change with the calendar (a paused month starting, a
// cancellation running out), so the CRM is re-synced a few times a day too.
const CRM_RESYNC_MS = 6 * 60 * 60 * 1000
if (crmFromEnv() && process.env.DATABASE_URL) {
  setInterval(() => {
    syncCrm(getDb(), OWNER, crmFromEnv()).catch((e) => console.error('crm resync failed', e))
  }, CRM_RESYNC_MS).unref()
}

// Sign-in keeps its tables in Mastra's Postgres; create them if they're missing.
if (process.env.MASTRA_DATABASE_URL && process.env.NODE_ENV !== 'test') {
  migrateAuth().catch((e) => console.error('sign-in tables migration failed', e))
}

import { Mastra } from '@mastra/core'
import { PostgresStore } from '@mastra/pg'
import { DeskKeyAuth } from './auth/key-auth'
import { clientMcp, deskMcp } from './mcp'
import { deskRoutes } from './routes'

/**
 * Client Desk. One Mastra server (Hono under the hood) serves:
 * - REST under /desk/* (OpenAPI at /api/openapi.json)
 * - MCP at /api/mcp/desk/mcp (admin) and /api/mcp/desk-client/mcp (client keys)
 * Channel agents for clients arrive in Phase 3.
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
  mcpServers: { desk: deskMcp, 'desk-client': clientMcp },
  server: {
    port: Number(process.env.PORT ?? 4111),
    host: process.env.HOST ?? '0.0.0.0',
    auth: new DeskKeyAuth(),
    apiRoutes: deskRoutes,
    build: { openAPIDocs: true, swaggerUI: true },
  },
})

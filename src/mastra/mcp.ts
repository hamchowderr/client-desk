import { createTool } from '@mastra/core/tools'
import { MCPServer } from '@mastra/mcp'
import type { MCPServerResources } from '@mastra/mcp'
import { toNodeHandler } from '@modelcontextprotocol/node'
import { type AuthInfo, createMcpHandler } from '@modelcontextprotocol/server'
import { z } from 'zod'
import deskAppHtml from '../apps/desk.generated'
import { getDb } from '../db/client'
import { getClientOverview } from '../domain/clients'
import { digest } from '../domain/digest'
import { replyDueAt } from '../domain/time'
import skills from '../skills.generated'
import { principalFrom } from './principal'
import { type Op, adminOps, clientOps } from './ops'
import { runOp } from './run'

/**
 * One MCP Apps view (src/apps/desk.ts) renders every desk tool that shows
 * something: a client's work, a request and its stages, a request being
 * drafted, the pause calendar, and Chowderr's command center. It picks what to
 * draw from the tool that opened it.
 */
const APP_URI = 'ui://desk/app'
const ui = { _meta: { ui: { resourceUri: APP_URI } } }

/** Tools that render in the app. Their object results also go out as structuredContent. */
const APP_TOOLS = new Set([
  'digest',
  'get_client',
  'get_request',
  'list_requests',
  'create_request',
  'queue_request',
  'start_request',
  'deliver_request',
  'my_status',
  'my_requests',
  'get_my_request',
  'submit_request',
  'plan_pause',
  'request_pause',
])
/** These return lists, which structuredContent can't hold; the app reads their JSON text. */
const LIST_TOOLS = new Set(['list_requests', 'my_requests'])

/** One Mastra tool per desk operation, run as the authenticated caller. */
export function toolFor(op: Op) {
  const app = APP_TOOLS.has(op.id)
  return createTool({
    id: op.id,
    description: op.description,
    inputSchema: op.input,
    ...(app && { mcp: ui }),
    ...(app && !LIST_TOOLS.has(op.id) && { outputSchema: z.looseObject({}) }),
    execute: async (input, context) => {
      const principal = principalFrom(context?.requestContext)
      return (await runOp(op, principal, input)) as any
    },
  })
}

const showBoard = createTool({
  id: 'show_board',
  description:
    "Show Chowderr's Client Desk command center: replies owed, active work, queues and what's waiting on clients, across every retainer client. Renders as an interactive screen where the host supports MCP Apps.",
  inputSchema: z.object({}),
  mcp: ui,
  // With an outputSchema Mastra returns the board as structuredContent (what the view reads)
  // and as JSON text for hosts without MCP Apps.
  outputSchema: z.looseObject({}),
  execute: async (_input, context) => digest(getDb(), principalFrom(context?.requestContext)),
})

/**
 * Lays a request out as a card the client checks and sends themselves. Nothing
 * is saved until they press Submit on it (which calls submit_request).
 */
const draftRequest = createTool({
  id: 'draft_request',
  description:
    'Show the client a request card to check and send. Use this instead of submit_request: the card fills in as you write, and the client presses Submit on it. Nothing is saved until they do. Ask what starts it (trigger) and what they get back (result) first; if one is still missing, draft anyway and ask. Call it again with the changes if they want edits.',
  inputSchema: z.object({
    title: z.string().describe('Short, in their words'),
    type: z.enum(['build', 'fix', 'decision', 'working_session']).optional(),
    trigger: z.string().optional().describe('What starts it'),
    result: z.string().optional().describe('What they get back'),
    submittedBy: z.string().optional().describe('Name of the person on the client side'),
  }),
  mcp: ui,
  outputSchema: z.looseObject({}),
  execute: async (input, context) => {
    const p = principalFrom(context?.requestContext)
    if (p.kind !== 'client') throw new Error('draft_request is for client sign-ins; use create_request')
    const { client } = await getClientOverview(getDb(), p, p.clientId)
    const missing = [!input.trigger && 'trigger', !input.result && 'result'].filter(Boolean)
    return {
      draft: input,
      client: { code: client.code, name: client.name },
      replyByIfSentNow: replyDueAt(new Date(), client.timezone),
      missing,
      note: missing.length
        ? `Shown as a card. Before it can be sent, ask the client for the ${missing.join(' and ')}, then draft again.`
        : 'Shown as a card with a Submit button. Wait for the client to press it; only call submit_request yourself if they ask you to send it and cannot see the card.',
    }
  },
})

/**
 * Skills served as resources under skill://, following the Skills over MCP
 * draft (SEP-2640). The same files ship in the Claude plugin for hosts that
 * don't load skills from MCP yet.
 */
function skillResources(names: string[]): MCPServerResources {
  const uri = (name: string) => `skill://${name}/SKILL.md`
  const describe = (md: string) => /\ndescription:\s*(.+)\n/.exec(md)?.[1]?.trim()
  return {
    listResources: async () =>
      names.map((name) => ({
        uri: uri(name),
        name,
        description: describe(skills[name]),
        mimeType: 'text/markdown',
      })),
    getResourceContent: async ({ uri: requested }) => {
      const name = names.find((n) => uri(n) === requested)
      if (!name) throw new Error(`Unknown resource ${requested}`)
      return { text: skills[name] }
    },
  }
}

const deskApp = {
  name: 'Client Desk',
  description: 'Requests, stages, queues and the pause calendar, drawn to tap through',
  html: deskAppHtml,
  meta: {
    // Blend into the conversation; Anthropic Sans comes from the host.
    prefersBorder: false,
    csp: { resourceDomains: ['https://assets.claude.ai'] },
  },
}

const tools = (ops: readonly Op[]) => Object.fromEntries(ops.map((op) => [op.id, toolFor(op)]))

/** Chowderr's server: every admin action, the board view, and the desk skills. */
/**
 * Mastra's MCPServer only answers the 2026-07-28 protocol revision and rejects
 * older openings. Claude Code, Claude Desktop and most SDK clients still open
 * with 2025-11-25, so this keeps the same server but also serves those
 * statelessly. Everything else (tools, resources, auth context) is unchanged.
 */
function serveLegacyToo<T extends MCPServer>(server: T): T {
  const self = server as any
  self.getNodeHandler = () => {
    if (!self.nodeHandler) {
      self.httpHandler = createMcpHandler(() => self.createServerInstance(), {
        legacy: 'stateless',
        onerror: (error: Error) => self.logger.error('MCP handler error', { error: error.toString() }),
      })
      self.nodeHandler = toNodeHandler(self.httpHandler)
    }
    return self.nodeHandler
  }
  return server
}

export const deskMcp = serveLegacyToo(new MCPServer({
  id: 'desk',
  name: 'Client Desk',
  version: '0.1.0',
  description: 'Retainer clients, requests and queues for Otaku Solutions.',
  instructions:
    'Client Desk tracks retainer clients and their requests. Requests are ids like GMA-012. Read the skill:// resources (desk-intake, desk-status, desk-delivery) before taking in, reporting on or delivering requests. The tools enforce the Retainer rules; when one refuses, explain the rule instead of working around it.',
  tools: { ...tools(adminOps), show_board: showBoard },
  resources: skillResources(['desk-intake', 'desk-status', 'desk-delivery']),
  appResources: { [APP_URI]: deskApp },
}))

/** A client agent's server: one client's view and intake, nothing else. */
export const clientMcp = serveLegacyToo(new MCPServer({
  id: 'desk-client',
  name: 'Client Desk (client)',
  version: '0.1.0',
  description: "One retainer client's requests and status with Otaku Solutions.",
  instructions:
    "You act for one Otaku Solutions retainer client. Read skill://client-agent/SKILL.md first. Never commit to sizes, dates or prices for Chowderr.",
  tools: { ...tools(clientOps), draft_request: draftRequest },
  resources: skillResources(['client-agent']),
  appResources: { [APP_URI]: deskApp },
}))

/**
 * Serve one HTTP request on a server as an already-authenticated caller. The
 * short /mcp address uses this to pick the admin or the client server by who
 * signed in.
 */
export function serveMcp(server: MCPServer, request: Request, authInfo: AuthInfo): Promise<Response> {
  const self = server as any
  self.getNodeHandler()
  return self.httpHandler.fetch(request, { authInfo })
}

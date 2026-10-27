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
import { missingContext } from '../domain/requests'
import { resolveFor } from '../domain/customers'
import { replyDueAt } from '../domain/time'
import skills from '../skills.generated'
import { principalFrom } from './principal'
import { type Op, adminOps, clientOps } from './ops'
import { runOp } from './run'

/**
 * One MCP Apps view (src/apps/desk.ts) renders every desk tool that shows
 * something: a client's work, a request and its stages, a request being
 * drafted, the pause calendar, billing, the weekly recap, the new-client
 * form, and Chowderr's command center. It picks what to
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
  'new_client',
  'setup_client',
  'weekly_recap',
  'send_recap',
  'billing_history',
  'my_billing',
  'my_week',
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
    'Show the client a request card to check and send. Use this instead of submit_request: the card fills in as you write, and the client presses Submit on it. Nothing is saved until they do. A request can only be sent once it says what starts it, what they get back, which tools or accounts it touches, how it is done today, and who it is for (one of their customers, someone on their team, or their company itself; my_people lists them); draft as soon as you have a title, then ask for whatever the card still lists as missing, one short question at a time, and draft again with each answer.',
  inputSchema: z.object({
    title: z.string().describe('Short, in their words'),
    type: z.enum(['build', 'fix', 'decision', 'working_session']).optional(),
    trigger: z.string().optional().describe('What starts it: an event, a time, or a person doing something'),
    result: z.string().optional().describe('What they get back when it works, concretely'),
    systems: z.string().optional().describe('The tools, accounts and places it touches, e.g. their HighLevel, n8n, Google Drive'),
    currentWay: z.string().optional().describe("How it's done today, or what goes wrong now"),
    links: z.string().optional().describe('Examples, files or links that show what they mean (optional)'),
    for: z
      .string()
      .optional()
      .describe('Who it is for: one of their customers (e.g. Rene or The Tax Doctor), a team member (e.g. Cass), or their own company'),
    submittedBy: z.string().optional().describe('Name of the person on the client side'),
  }),
  mcp: ui,
  outputSchema: z.looseObject({}),
  execute: async (input, context) => {
    const p = principalFrom(context?.requestContext)
    if (p.kind !== 'client') throw new Error('draft_request is for client sign-ins; use create_request')
    const { client } = await getClientOverview(getDb(), p, p.clientId)
    const draft = { ...input }
    let forProblem: string | null = null
    if (input.for?.trim()) {
      try {
        draft.for = (await resolveFor(getDb(), client, input.for)).forName
      } catch (e) {
        forProblem = (e as Error).message
        draft.for = undefined
      }
    }
    const missing = missingContext(draft)
    return {
      draft,
      client: { code: client.code, name: client.name },
      replyByIfSentNow: replyDueAt(new Date(), client.timezone),
      missing: missing.map((m) => m.field),
      note: missing.length
        ? `Shown as a card. It can't be sent yet. Ask the client, one at a time: ${missing.map((m) => m.label).join('; ')}. Then draft again.${
            forProblem ? ` About who it's for: ${forProblem}` : ''
          }`
        : 'Shown as a card with a Submit button. Wait for the client to press it; only call submit_request yourself if they ask you to send it and cannot see the card.',
    }
  },
})

/**
 * How a client's Claude takes a request. Sent as the server's instructions, so
 * it applies in any host, including ones that never read skill:// resources.
 */
const CLIENT_INSTRUCTIONS = `You act for one Otaku Solutions retainer client, talking with someone on their team. Chowderr (Otaku Solutions) does the work.

Taking a request. A request only helps Chowderr if it has the full context, so never send a vague one. Before it goes, it must say:
1. What starts it (the trigger): an event, a time, or a person doing something.
2. What they get back when it works (the result), concretely.
3. Which tools, accounts or places it touches (e.g. their HighLevel, n8n, Google Drive, website).
4. How it's done today, or what goes wrong now.
5. Who it's for: one of their customers (first and last name, and company) or someone on their team, or their company itself. my_people lists who they can pick; if the person isn't there, add them with add_my_customer (first name, last name and company). To change who an existing request is for, use set_my_request_for.
Links, files or examples help too. One request is one trigger and one result; if they describe several things, make several requests. Ask for missing pieces one short question at a time, in their words, and offer an example answer when they seem unsure. Use draft_request so they see the card fill in and press Submit themselves.

Speak to them as "you" about their own work only. Never mention other clients or internal notes. Never promise sizes, dates or prices; Chowderr confirms scope. They can send as many requests as they like; a few run at once and the rest wait in their queue in order. Billing questions beyond my_billing go to Chowderr. When a screen reports they pressed something, it's done; confirm in a line and don't repeat it. More detail: skill://client-agent/SKILL.md.`

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
    'Client Desk tracks retainer clients and their requests. Requests are ids like GMA-012. A useful request says what starts it, what comes back, which tools or accounts it touches, and how it is done today; when logging or scoping one, fill those in or ask for them. Read the skill:// resources (desk-intake, desk-status, desk-delivery) before taking in, reporting on or delivering requests. The tools enforce the Retainer rules; when one refuses, explain the rule instead of working around it.',
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
  instructions: CLIENT_INSTRUCTIONS,
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

import { createTool } from '@mastra/core/tools'
import { MCPServer } from '@mastra/mcp'
import type { MCPServerResources } from '@mastra/mcp'
import { toNodeHandler } from '@modelcontextprotocol/node'
import { type AuthInfo, createMcpHandler } from '@modelcontextprotocol/server'
import { z } from 'zod'
import boardHtml from '../apps/board.generated'
import { getDb } from '../db/client'
import { digest } from '../domain/digest'
import skills from '../skills.generated'
import { principalFrom } from './principal'
import { type Op, adminOps, clientOps } from './ops'
import { runOp } from './run'

const BOARD_URI = 'ui://desk/board'

/** One Mastra tool per desk operation, run as the authenticated caller. */
export function toolFor(op: Op) {
  return createTool({
    id: op.id,
    description: op.description,
    inputSchema: op.input,
    execute: async (input, context) => {
      const principal = principalFrom(context?.requestContext)
      return runOp(op, principal, input)
    },
  })
}

const showBoard = createTool({
  id: 'show_board',
  description:
    "Show the Client Desk board: replies owed, active work, queues and what's waiting on clients, across every retainer client. Renders as an interactive view where the host supports MCP Apps.",
  inputSchema: z.object({}),
  mcp: { _meta: { ui: { resourceUri: BOARD_URI } } },
  // With an outputSchema Mastra returns the board as structuredContent (what the view reads)
  // and as JSON text for hosts without MCP Apps.
  outputSchema: z.looseObject({}),
  execute: async (_input, context) => digest(getDb(), principalFrom(context?.requestContext)),
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
  appResources: {
    [BOARD_URI]: { name: 'Client Desk board', description: 'Replies owed, active work and queues', html: boardHtml },
  },
}))

/** A client agent's server: one client's view and intake, nothing else. */
export const clientMcp = serveLegacyToo(new MCPServer({
  id: 'desk-client',
  name: 'Client Desk (client)',
  version: '0.1.0',
  description: "One retainer client's requests and status with Otaku Solutions.",
  instructions:
    "You act for one Otaku Solutions retainer client. Read skill://client-agent/SKILL.md first. Never commit to sizes, dates or prices for Chowderr.",
  tools: tools(clientOps),
  resources: skillResources(['client-agent']),
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

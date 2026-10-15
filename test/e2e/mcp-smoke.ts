// Smoke test against a running server: DESK_URL, DESK_ADMIN, DESK_CLIENT.
// MCP_LEGACY=1 uses the 1.x SDK client (2025-11-25 protocol) to check older clients still connect.
import { Client as ModernClient, StreamableHTTPClientTransport as ModernTransport } from '@modelcontextprotocol/client'
import { Client as LegacyClient } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport as LegacyTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'

const legacy = process.env.MCP_LEGACY === '1'
const Client: any = legacy ? LegacyClient : ModernClient
const StreamableHTTPClientTransport: any = legacy ? LegacyTransport : ModernTransport

const base = process.env.DESK_URL ?? 'http://localhost:4111'
async function connect(server: string, key: string): Promise<any> {
  const client = new Client({ name: 'smoke', version: '1.0.0' })
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`${base}/api/mcp/${server}/mcp`), {
      requestInit: { headers: { Authorization: `Bearer ${key}` } },
    }),
  )
  return client
}

const admin = await connect('desk', process.env.DESK_ADMIN!)
const tools = await admin.listTools()
console.log('admin tools:', tools.tools.length, tools.tools.map((t: any) => t.name).join(', '))
const board = tools.tools.find((t: any) => t.name === 'show_board')
console.log('show_board meta:', JSON.stringify(board?._meta))
const res = await admin.callTool({ name: 'show_board', arguments: {} })
console.log('show_board text:', (res.content as any)[0].text, '| structured clients:', (res.structuredContent as any)?.clients?.length)
const resources = await admin.listResources()
console.log('admin resources:', resources.resources.map((r: any) => r.uri).join(', '))
const skill = await admin.readResource({ uri: 'skill://desk-intake/SKILL.md' })
console.log('skill head:', (skill.contents[0] as any).text.split('\n')[1])
const ui = await admin.readResource({ uri: 'ui://desk/board' })
console.log('ui resource:', ui.contents[0].mimeType, `${Math.round(((ui.contents[0] as any).text?.length ?? 0) / 1024)} KB`)
const scoped = await admin.callTool({ name: 'scope_request', arguments: { request: 'ACME-004', type: 'fix', trigger: 'Invoice created in Stripe', result: 'Invoice in QuickBooks', sizeDays: 2 } })
console.log('scope_request:', JSON.stringify(scoped.structuredContent ?? (scoped.content as any)[0].text).slice(0, 120))
const refused = await admin.callTool({ name: 'start_request', arguments: { request: 'ACME-002' } })
console.log('start refused:', refused.isError, (refused.content as any)[0].text)

const client = await connect('desk-client', process.env.DESK_CLIENT!)
const ctools = await client.listTools()
console.log('client tools:', ctools.tools.map((t: any) => t.name).join(', '))
const me = await client.callTool({ name: 'my_status', arguments: {} })
console.log('my_status queue:', JSON.stringify((me.structuredContent as any)?.queue?.map((q: any) => q.id) ?? (me.content as any)[0].text.slice(0, 200)))
const cres = await client.listResources()
console.log('client resources:', cres.resources.map((r: any) => r.uri).join(', '))

const crossed = await connect('desk', process.env.DESK_CLIENT!)
const denied = await crossed.callTool({ name: 'digest', arguments: {} })
console.log('client key on admin server:', denied.isError, (denied.content as any)[0].text)
process.exit(0)

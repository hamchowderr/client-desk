// Smoke test against a running server (DESK_URL) sharing its DATABASE_URL and DESK_ADMIN_KEY: npx tsx test/e2e/oauth-smoke.ts <email>
// Drives the real server with the MCP SDK's own OAuth client: 401 -> discovery -> DCR -> authorize page -> token -> tools.
// The provider leg (Google/Microsoft) is stood in for by sealing the code the callback would issue.
import { randomBytes } from 'node:crypto'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { UnauthorizedError } from '@modelcontextprotocol/sdk/client/auth.js'
import { getDb } from '../../src/db/client'
import { seal } from '../../src/oauth/seal'
import { whoForEmail } from '../../src/oauth/identity'

const base = process.env.DESK_URL ?? 'http://localhost:4111'
const email = process.argv[2]!
let info: any, tokens: any, verifier = '', code = ''
const redirectUrl = 'http://localhost:6274/callback'
const provider: any = {
  redirectUrl,
  clientMetadata: { client_name: 'E2E Claude', redirect_uris: [redirectUrl], grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], token_endpoint_auth_method: 'none' },
  clientInformation: () => info,
  saveClientInformation: (i: any) => { info = i },
  tokens: () => tokens,
  saveTokens: (t: any) => { tokens = t },
  saveCodeVerifier: (v: string) => { verifier = v },
  codeVerifier: () => verifier,
  redirectToAuthorization: async (url: URL) => {
    const page = await fetch(url)
    const html = await page.text()
    console.log('authorize page:', page.status, /<h1>(.*?)<\/h1>/.exec(html)?.[1])
    const who = await whoForEmail(getDb(), email)
    code = seal('cd', { who, cid: url.searchParams.get('client_id'), ru: url.searchParams.get('redirect_uri'), cc: url.searchParams.get('code_challenge'), j: randomBytes(8).toString('hex'), exp: Math.floor(Date.now() / 1000) + 120 })
  },
}
const transport = () => new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { authProvider: provider })
let client = new Client({ name: 'e2e', version: '1.0.0' })
const t1 = transport()
try { await client.connect(t1) } catch (e) { if (!(e instanceof UnauthorizedError)) throw e; console.log('first connect: needs sign-in; registered client', String(info?.client_id).slice(0, 8)) }
await t1.finishAuth(code)
console.log('tokens:', tokens?.token_type, tokens?.expires_in, Boolean(tokens?.refresh_token))
client = new Client({ name: 'e2e', version: '1.0.0' })
await client.connect(transport())
const tools = await client.listTools()
console.log('tools:', tools.tools.length, tools.tools.map((t: any) => t.name).slice(0, 8).join(', '))
const call = await client.callTool({ name: email.startsWith('owner') ? 'digest' : 'my_status', arguments: {} })
console.log('call:', call.isError ? 'ERROR' : 'ok', JSON.stringify(call.structuredContent ?? (call.content as any)[0].text).slice(0, 160))
process.exit(0)

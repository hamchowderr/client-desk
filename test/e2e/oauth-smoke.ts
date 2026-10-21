// Connector sign-in against a running server, with the MCP SDK's own OAuth client:
// 401 -> discovery -> registration -> sign-in page -> emailed code -> consent -> token -> tools.
// Run the server with FLUENTCRM_URL pointing at test/e2e/fake-fluentcrm.mjs and pass that
// process's log as CRM_LOG, so the script can read the code it "emailed".
//   npx tsx test/e2e/oauth-smoke.ts <email>
import { readFileSync } from 'node:fs'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { UnauthorizedError } from '@modelcontextprotocol/sdk/client/auth.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'

const base = process.env.DESK_URL ?? 'http://localhost:4111'
const email = process.argv[2]!
const redirectUrl = 'http://localhost:6274/callback'
const jar = new Map<string, string>()

async function browse(url: string, init: { json?: unknown } = {}) {
  const headers: Record<string, string> = { cookie: [...jar].map(([k, v]) => `${k}=${v}`).join('; ') }
  // A browser sends its origin on every POST; Better Auth checks it.
  if (init.json) Object.assign(headers, { 'content-type': 'application/json', accept: 'application/json', origin: new URL(base).origin })
  const res = await fetch(new URL(url, base), {
    method: init.json ? 'POST' : 'GET',
    headers,
    body: init.json ? JSON.stringify(init.json) : undefined,
    redirect: 'manual',
  })
  for (const c of res.headers.getSetCookie()) {
    const [k, ...v] = c.split(';')[0]!.split('=')
    jar.set(k!, v.join('='))
  }
  return res
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
async function codeFromCrm(): Promise<string> {
  for (let i = 0; i < 20; i++) {
    const lines = readFileSync(process.env.CRM_LOG!, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l))
    const mine = lines.filter((l) => l.to === email).at(-1)
    if (mine) return /^(\d{6})/.exec(mine.subject)![1]!
    await sleep(250)
  }
  throw new Error('no code was emailed')
}

let info: any, tokens: any, verifier = '', code = ''
const provider: any = {
  redirectUrl,
  clientMetadata: { client_name: 'E2E Claude', redirect_uris: [redirectUrl], grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], token_endpoint_auth_method: 'none', application_type: 'native' },
  clientInformation: () => info,
  saveClientInformation: (i: any) => { info = i },
  tokens: () => tokens,
  saveTokens: (t: any) => { tokens = t },
  saveCodeVerifier: (v: string) => { verifier = v },
  codeVerifier: () => verifier,
  redirectToAuthorization: async (url: URL) => {
    const start = await browse(url.toString())
    // Node's fetch always says sec-fetch-mode: cors, so Better Auth answers with JSON instead of a 302.
    const location = start.headers.get('location') ?? ((await start.json()) as any).url
    const login = new URL(location, base)
    const page = await (await browse(login.toString())).text()
    console.log('sign-in page:', login.pathname, /<h1>(.*?)<\/h1>/.exec(page)?.[1])
    const oauth_query = login.search.slice(1)
    const ask = await browse('/auth/email-otp/send-verification-otp', { json: { email, type: 'sign-in', oauth_query } })
    if (!ask.ok) throw new Error(`code request failed: ${ask.status} ${await ask.text()}`)
    const otp = await codeFromCrm()
    console.log('code emailed through FluentCRM:', otp.replace(/\d/g, '•'))
    const signedIn = await browse('/auth/sign-in/email-otp', { json: { email, otp, oauth_query } })
    const next = new URL(((await signedIn.json()) as any).url, base)
    const consent = await (await browse(next.toString())).text()
    console.log('consent page:', /<h1>(.*?)<\/h1>/.exec(consent)?.[1])
    const allowed = await browse('/auth/oauth2/consent', { json: { accept: true, oauth_query: next.search.slice(1) } })
    code = new URL(((await allowed.json()) as any).url).searchParams.get('code')!
  },
}

const transport = () => new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { authProvider: provider })
const first = transport()
try {
  await new Client({ name: 'e2e', version: '1.0.0' }).connect(first)
} catch (e) {
  if (!(e instanceof UnauthorizedError)) throw e
}
await first.finishAuth(code)
console.log('tokens:', tokens?.token_type, tokens?.expires_in, 'refresh:', Boolean(tokens?.refresh_token))
const client = new Client({ name: 'e2e', version: '1.0.0' })
await client.connect(transport())
const tools = await client.listTools()
console.log('tools:', tools.tools.length, tools.tools.map((t: any) => t.name).slice(0, 6).join(', '))
const call = await client.callTool({ name: email.startsWith('owner') ? 'digest' : 'my_status', arguments: {} })
console.log('call:', call.isError ? 'ERROR' : 'ok', JSON.stringify(call.structuredContent ?? (call.content as any)[0].text).slice(0, 120))
process.exit(0)

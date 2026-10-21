import { createHash, randomBytes } from 'node:crypto'
import { eq } from 'drizzle-orm'
import { Hono } from 'hono'
import { memoryAdapter } from 'better-auth/adapters/memory'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getSchema } from 'better-auth/db'
import { deskAuthConfig, setAuth } from '../src/auth'
import { authRoutes } from '../src/auth/routes'
import { type Db, setDb } from '../src/db/client'
import { contacts } from '../src/db/schema'
import { addContact } from '../src/domain/clients'
import { OWNER } from '../src/domain/principal'
import { deskUserForToken } from '../src/mastra/auth/key-auth'
import { seedClient, testDb } from './helpers'

const BASE = 'http://localhost:4111'
const CALLBACK = 'http://localhost:6274/callback'

let db: Db
let app: Hono
let sent: { email: string; code: string }[]

beforeEach(async () => {
  vi.stubEnv('DESK_AUTH_SECRET', 'test-secret-that-is-long-enough-0123456789')
  vi.stubEnv('DESK_PUBLIC_URL', BASE)
  vi.stubEnv('DESK_OWNER_EMAILS', 'owner@otaku.example')
  db = await testDb()
  setDb(db)
  sent = []
  // The memory adapter needs every table up front.
  const tables = Object.keys(getSchema(deskAuthConfig({ database: memoryAdapter({}) })))
  setAuth(undefined, {
    database: memoryAdapter(Object.fromEntries(tables.map((t) => [t, []]))),
    sendCode: async (email, code) => {
      sent.push({ email, code })
    },
  })
  app = new Hono()
  for (const r of authRoutes) app.on((r.method === 'ALL' ? ['GET', 'POST'] : [r.method]) as string[], r.path, (r as any).handler)
})

afterEach(() => {
  vi.unstubAllEnvs()
  setAuth(undefined)
})

/** A tiny browser: keeps cookies, never follows redirects. */
function browser() {
  const jar = new Map<string, string>()
  return async (path: string, init: RequestInit & { json?: unknown } = {}) => {
    const headers = new Headers(init.headers)
    if (jar.size) headers.set('cookie', [...jar].map(([k, v]) => `${k}=${v}`).join('; '))
    if (init.json !== undefined) {
      headers.set('content-type', 'application/json')
      headers.set('accept', 'application/json')
    }
    const res = await app.request(path.startsWith('http') ? path : BASE + path, {
      ...init,
      headers,
      body: init.json !== undefined ? JSON.stringify(init.json) : init.body,
    })
    for (const c of res.headers.getSetCookie()) {
      const [pair] = c.split(';')
      const [k, ...v] = pair!.split('=')
      jar.set(k!.trim(), v.join('='))
    }
    return res
  }
}

async function register(fetch: ReturnType<typeof browser>) {
  const res = await fetch('/auth/oauth2/register', {
    method: 'POST',
    json: { client_name: 'Claude', redirect_uris: [CALLBACK], token_endpoint_auth_method: 'none', application_type: 'native' },
  })
  if (res.status >= 300) throw new Error(`register ${res.status}: ${await res.text()}`)
  return ((await res.json()) as { client_id: string }).client_id
}

/** The whole connector sign-in, as Claude and a person in a browser would do it. */
async function connect(email: string, opts: { typo?: boolean } = {}) {
  const fetch = browser()
  const clientId = await register(fetch)
  const verifier = randomBytes(32).toString('base64url')
  const authorize = new URLSearchParams({
    response_type: 'code',
    client_id: clientId,
    redirect_uri: CALLBACK,
    scope: 'openid email offline_access',
    code_challenge: createHash('sha256').update(verifier).digest('base64url'),
    code_challenge_method: 'S256',
    state: 'claude-state',
    resource: `${BASE}/mcp`,
  })
  const start = await fetch(`/auth/oauth2/authorize?${authorize}`)
  expect(start.status).toBe(302)
  const login = new URL(start.headers.get('location')!, BASE)
  expect(login.pathname).toBe('/sign-in')
  const signInPage = await fetch(login.pathname + login.search)
  expect(signInPage.status).toBe(200)
  expect(await signInPage.text()).toContain('Email me a code')
  const oauth_query = login.search.slice(1)

  const ask = await fetch('/auth/email-otp/send-verification-otp', { method: 'POST', json: { email, type: 'sign-in', oauth_query } })
  expect(ask.ok).toBe(true)
  const code = sent.find((s) => s.email === email)?.code ?? '123456'
  const signedIn = await fetch('/auth/sign-in/email-otp', {
    method: 'POST',
    json: { email, otp: opts.typo ? '000000' : code, oauth_query },
  })
  if (!signedIn.ok) return { refused: ((await signedIn.json()) as any).message as string }
  const toConsent = new URL(((await signedIn.json()) as any).url, BASE)
  expect(toConsent.pathname).toBe('/consent')
  const consentPage = await fetch(toConsent.pathname + toConsent.search)
  expect(await consentPage.text()).toContain('Let Claude use your Otaku Solutions account?')

  const allowed = await fetch('/auth/oauth2/consent', { method: 'POST', json: { accept: true, oauth_query: toConsent.search.slice(1) } })
  const back = new URL(((await allowed.json()) as any).url)
  expect(back.origin + back.pathname).toBe(CALLBACK)
  expect(back.searchParams.get('state')).toBe('claude-state')

  const token = await fetch('/auth/oauth2/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code: back.searchParams.get('code')!,
      code_verifier: verifier,
      client_id: clientId,
      redirect_uri: CALLBACK,
      resource: `${BASE}/mcp`,
    }),
  })
  expect(token.status).toBe(200)
  return { tokens: (await token.json()) as { access_token: string; refresh_token?: string }, clientId }
}

describe('connector sign-in with an emailed code', () => {
  it('publishes where to sign in', async () => {
    const prm = (await (await app.request(`${BASE}/.well-known/oauth-protected-resource/mcp`)).json()) as any
    expect(prm.resource).toBe(`${BASE}/mcp`)
    const asUrl = `${prm.authorization_servers[0].replace(BASE, `${BASE}/.well-known/oauth-authorization-server`)}`
    const as = (await (await app.request(asUrl)).json()) as any
    expect(as.code_challenge_methods_supported).toContain('S256')
    expect(as.client_id_metadata_document_supported).toBe(true)
  })

  it("a client signs in with the code we email them and gets their own client's access", async () => {
    const { client } = await seedClient(db)
    const rachel = await addContact(db, OWNER, 'GMA', { name: 'Rachel Castro', email: 'Rachel@GMA.example', role: 'owner' })
    const out = await connect('rachel@gma.example')
    expect(sent).toEqual([{ email: 'rachel@gma.example', code: expect.stringMatching(/^\d{6}$/) }])
    const user = await deskUserForToken(db, out.tokens!.access_token)
    expect(user?.principal).toEqual({ kind: 'client', clientId: client.id, contactId: rachel!.id, label: 'oauth:Rachel Castro' })

    // Change the contact's email and the token stops working.
    await db.update(contacts).set({ email: 'rachel@elsewhere.example' }).where(eq(contacts.id, rachel!.id))
    expect(await deskUserForToken(db, out.tokens!.access_token)).toBeNull()
  })

  it('the owner signs in to the admin tools', async () => {
    const out = await connect('owner@otaku.example')
    expect((await deskUserForToken(db, out.tokens!.access_token))?.principal).toEqual({ kind: 'admin', label: 'owner@otaku.example' })
  })

  it("an email the desk doesn't know gets no code and can't sign in", async () => {
    await seedClient(db)
    const out = await connect('stranger@example.com')
    expect(out.refused).toBeTruthy()
    expect(sent).toEqual([])
  })

  it('a wrong code does not sign in', async () => {
    await seedClient(db)
    await addContact(db, OWNER, 'GMA', { name: 'Cass', email: 'cass@gma.example' })
    const out = await connect('cass@gma.example', { typo: true })
    expect(out.refused).toBeTruthy()
  })

  it('the sign-in page refuses a tampered or missing request', async () => {
    expect((await app.request(`${BASE}/sign-in?client_id=x&sig=nope`)).status).toBe(400)
    expect((await app.request(`${BASE}/consent`)).status).toBe(400)
  })
})

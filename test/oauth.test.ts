import { createHash, randomBytes } from 'node:crypto'
import { eq } from 'drizzle-orm'
import { Hono } from 'hono'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { type Db, setDb } from '../src/db/client'
import { contacts } from '../src/db/schema'
import { addContact } from '../src/domain/clients'
import { OWNER } from '../src/domain/principal'
import { deskUserForToken } from '../src/mastra/auth/key-auth'
import { redirectMatches, redirectUriOk, resolveOAuthClient } from '../src/oauth/clients'
import { oauthRoutes } from '../src/oauth/routes'
import { seal, unseal } from '../src/oauth/seal'
import { seedClient, testDb } from './helpers'

const BASE = 'https://desk.test'
const CALLBACK = 'https://claude.ai/api/mcp/auth_callback'

let db: Db
let app: Hono
const realFetch = globalThis.fetch

beforeEach(async () => {
  vi.stubEnv('DESK_OAUTH_SECRET', 'test-secret-that-is-long-enough-123')
  vi.stubEnv('DESK_PUBLIC_URL', BASE)
  vi.stubEnv('DESK_OWNER_EMAILS', 'owner@otaku.example')
  vi.stubEnv('GOOGLE_CLIENT_ID', 'google-app')
  vi.stubEnv('GOOGLE_CLIENT_SECRET', 'google-secret')
  vi.stubEnv('MICROSOFT_CLIENT_ID', 'ms-app')
  vi.stubEnv('MICROSOFT_CLIENT_SECRET', 'ms-secret')
  db = await testDb()
  setDb(db)
  app = new Hono()
  for (const r of oauthRoutes) app.on(r.method, r.path, (r as any).handler)
})

afterEach(() => {
  vi.unstubAllEnvs()
  globalThis.fetch = realFetch
})

const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url')
const fakeIdToken = (claims: object) => `${b64({ alg: 'RS256' })}.${b64(claims)}.sig`

/** The provider's token endpoint answers with an id_token carrying these claims (nonce filled in). */
function provider(claims: (nonce: string) => object) {
  let nonce = ''
  globalThis.fetch = vi.fn(async (url: any, init?: any) => {
    const body = new URLSearchParams(init?.body?.toString())
    expect(body.get('client_secret')).toMatch(/secret/)
    return new Response(JSON.stringify({ id_token: fakeIdToken(claims(nonce)) }), { status: 200 })
  }) as any
  return { setNonce: (n: string) => (nonce = n) }
}

const googleClaims = (email: string, extra: object = {}) => (nonce: string) => ({
  iss: 'https://accounts.google.com',
  aud: 'google-app',
  exp: Math.floor(Date.now() / 1000) + 600,
  nonce,
  email,
  email_verified: true,
  ...extra,
})

async function registerClaude() {
  const res = await app.request('/oauth/register', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ redirect_uris: [CALLBACK], client_name: 'Claude' }),
  })
  expect(res.status).toBe(201)
  return ((await res.json()) as { client_id: string }).client_id
}

/** Run the browser part of a sign-in: authorize page, button, provider, callback. */
async function signIn(opts: { email: string; via?: 'google' | 'microsoft'; claims?: (n: string) => object; clientId?: string }) {
  const clientId = opts.clientId ?? (await registerClaude())
  const verifier = randomBytes(32).toString('base64url')
  const challenge = createHash('sha256').update(verifier).digest('base64url')
  const q = new URLSearchParams({
    response_type: 'code',
    client_id: clientId,
    redirect_uri: CALLBACK,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    state: 'claude-state',
    resource: `${BASE}/mcp`,
  })
  const pageRes = await app.request(`/oauth/authorize?${q}`)
  expect(pageRes.status).toBe(200)
  const html = await pageRes.text()
  expect(html).toContain('Connect Claude to Otaku Solutions')
  const cookie = pageRes.headers.get('set-cookie')!.split(';')[0]!
  const request = /name="request" value="([^"]+)"/.exec(html)![1]!
  const csrf = /name="csrf" value="([^"]+)"/.exec(html)![1]!

  const via = opts.via ?? 'google'
  const login = await app.request(`/oauth/login/${via}`, {
    method: 'POST',
    headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ request, csrf }),
  })
  expect(login.status).toBe(302)
  const to = new URL(login.headers.get('location')!)
  expect(to.searchParams.get('redirect_uri')).toBe(`${BASE}/oauth/callback/${via}`)

  const idp = provider(opts.claims ?? googleClaims(opts.email))
  idp.setNonce(to.searchParams.get('nonce')!)
  const cb = await app.request(`/oauth/callback/${via}?code=provider-code&state=${encodeURIComponent(to.searchParams.get('state')!)}`, {
    headers: { cookie },
  })
  return { cb, verifier, clientId, cookie }
}

async function exchange(form: Record<string, string>) {
  const res = await app.request('/oauth/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(form),
  })
  return { status: res.status, body: (await res.json()) as any }
}

describe('desk sign-in for MCP connectors', () => {
  it('publishes where and how to sign in', async () => {
    const prm = (await (await app.request('/.well-known/oauth-protected-resource/mcp')).json()) as any
    expect(prm).toMatchObject({ resource: `${BASE}/mcp`, authorization_servers: [BASE] })
    const as = (await (await app.request('/.well-known/oauth-authorization-server')).json()) as any
    expect(as).toMatchObject({
      issuer: BASE,
      code_challenge_methods_supported: ['S256'],
      client_id_metadata_document_supported: true,
      registration_endpoint: `${BASE}/oauth/register`,
    })
  })

  it("a client signs in with their work email and gets their own client's access", async () => {
    const { client } = await seedClient(db)
    const rachel = await addContact(db, OWNER, 'GMA', { name: 'Rachel Castro', email: 'Rachel@GMA.example', role: 'owner' })
    const { cb, verifier, clientId } = await signIn({ email: 'rachel@gma.example' })
    expect(cb.status).toBe(302)
    const back = new URL(cb.headers.get('location')!)
    expect(back.origin + back.pathname).toBe(CALLBACK)
    expect(back.searchParams.get('state')).toBe('claude-state')
    expect(back.searchParams.get('iss')).toBe(BASE)
    const code = back.searchParams.get('code')!

    const wrong = await exchange({ grant_type: 'authorization_code', code, code_verifier: 'nope', client_id: clientId, redirect_uri: CALLBACK })
    expect(wrong.body.error).toBe('invalid_grant')

    const ok = await exchange({ grant_type: 'authorization_code', code, code_verifier: verifier, client_id: clientId, redirect_uri: CALLBACK })
    expect(ok.status).toBe(200)
    expect(ok.body).toMatchObject({ token_type: 'Bearer', expires_in: 3600 })
    const user = await deskUserForToken(db, ok.body.access_token)
    expect(user?.principal).toEqual({ kind: 'client', clientId: client.id, contactId: rachel!.id, label: 'oauth:Rachel Castro' })

    const again = await exchange({ grant_type: 'authorization_code', code, code_verifier: verifier, client_id: clientId, redirect_uri: CALLBACK })
    expect(again.body.error).toBe('invalid_grant')

    const refreshed = await exchange({ grant_type: 'refresh_token', refresh_token: ok.body.refresh_token, client_id: clientId })
    expect(refreshed.status).toBe(200)
    expect((await deskUserForToken(db, refreshed.body.access_token))?.principal.kind).toBe('client')

    // Removing the contact (or changing their email) cuts off their tokens at once.
    await db.update(contacts).set({ email: 'rachel@elsewhere.example' }).where(eq(contacts.id, rachel!.id))
    expect(await deskUserForToken(db, ok.body.access_token)).toBeNull()
    const denied = await exchange({ grant_type: 'refresh_token', refresh_token: ok.body.refresh_token, client_id: clientId })
    expect(denied.body.error).toBe('invalid_grant')
  })

  it('the owner signs in to the admin tools', async () => {
    const { cb, verifier, clientId } = await signIn({ email: 'owner@otaku.example' })
    const code = new URL(cb.headers.get('location')!).searchParams.get('code')!
    const ok = await exchange({ grant_type: 'authorization_code', code, code_verifier: verifier, client_id: clientId, redirect_uri: CALLBACK })
    expect((await deskUserForToken(db, ok.body.access_token))?.principal).toEqual({ kind: 'admin', label: 'owner@otaku.example' })
  })

  it("an email the desk doesn't know gets a friendly refusal, not a code", async () => {
    await seedClient(db)
    const { cb } = await signIn({ email: 'stranger@example.com' })
    expect(cb.status).toBe(403)
    expect(await cb.text()).toContain("isn&#39;t on an Otaku Solutions account")
  })

  it('refuses emails the provider has not verified', async () => {
    await seedClient(db)
    await addContact(db, OWNER, 'GMA', { name: 'Cass', email: 'cass@gma.example' })
    const google = await signIn({ email: 'cass@gma.example', claims: googleClaims('cass@gma.example', { email_verified: false }) })
    expect(google.cb.status).toBe(403)

    const msClaims = (edov: unknown) => (nonce: string) => ({
      iss: 'https://login.microsoftonline.com/tenant-1/v2.0',
      tid: 'tenant-1',
      aud: 'ms-app',
      exp: Math.floor(Date.now() / 1000) + 600,
      nonce,
      email: 'cass@gma.example',
      ...(edov !== undefined && { xms_edov: edov }),
    })
    expect((await signIn({ email: 'cass@gma.example', via: 'microsoft', claims: msClaims(undefined) })).cb.status).toBe(403)
    expect((await signIn({ email: 'cass@gma.example', via: 'microsoft', claims: msClaims(true) })).cb.status).toBe(302)
  })

  it('a provider callback needs the browser that pressed the button, and a matching nonce', async () => {
    await seedClient(db)
    await addContact(db, OWNER, 'GMA', { name: 'Cass', email: 'cass@gma.example' })
    const clientId = await registerClaude()
    const q = new URLSearchParams({ response_type: 'code', client_id: clientId, redirect_uri: CALLBACK, code_challenge: 'x', code_challenge_method: 'S256' })
    const html = await (await app.request(`/oauth/authorize?${q}`)).text()
    const request = /name="request" value="([^"]+)"/.exec(html)![1]!
    const csrf = /name="csrf" value="([^"]+)"/.exec(html)![1]!
    // A crafted link that skips the page (no cookie in the victim's browser) goes nowhere.
    const forged = await app.request('/oauth/login/google', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ request, csrf }),
    })
    expect(forged.status).toBe(400)

    const badNonce = await signIn({ email: 'cass@gma.example', clientId, claims: (_n) => googleClaims('cass@gma.example')('other-nonce') })
    expect(badNonce.cb.status).toBe(403)
  })

  it('checks the app, its redirect and PKCE before showing the page', async () => {
    const clientId = await registerClaude()
    const base = { response_type: 'code', client_id: clientId, code_challenge: 'x', code_challenge_method: 'S256' }
    const evil = await app.request(`/oauth/authorize?${new URLSearchParams({ ...base, redirect_uri: 'https://evil.example/cb' })}`)
    expect(evil.status).toBe(400)
    expect(evil.headers.get('location')).toBeNull()
    const unknown = await app.request(`/oauth/authorize?${new URLSearchParams({ ...base, client_id: 'made-up', redirect_uri: CALLBACK })}`)
    expect(unknown.status).toBe(400)
    const plain = await app.request(`/oauth/authorize?${new URLSearchParams({ ...base, redirect_uri: CALLBACK, code_challenge_method: 'plain' })}`)
    expect(new URL(plain.headers.get('location')!).searchParams.get('error')).toBe('invalid_request')
    const bad = await app.request('/oauth/register', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ redirect_uris: ['http://evil.example/cb'] }),
    })
    expect(bad.status).toBe(400)
  })
})

describe('OAuth building blocks', () => {
  beforeEach(() => vi.stubEnv('DESK_OAUTH_SECRET', 'test-secret-that-is-long-enough-123'))

  it('sealed values only open as their own kind, untampered and in time', () => {
    const s = seal('cd', { a: 1, exp: Math.floor(Date.now() / 1000) + 60 })
    expect(unseal('cd', s)).toMatchObject({ a: 1 })
    expect(unseal('at', s.replace(/^cd_/, 'at_'))).toBeNull()
    expect(unseal('cd', s.slice(0, -2) + (s.endsWith('A') ? 'BB' : 'AA'))).toBeNull()
    expect(unseal('cd', seal('cd', { exp: 1 }))).toBeNull()
  })

  it('redirect rules', () => {
    expect(redirectUriOk('https://claude.ai/api/mcp/auth_callback')).toBe(true)
    expect(redirectUriOk('http://localhost:3333/callback')).toBe(true)
    expect(redirectUriOk('http://evil.example/cb')).toBe(false)
    expect(redirectUriOk('javascript:alert(1)')).toBe(false)
    expect(redirectMatches(['http://localhost/callback'], 'http://localhost:51234/callback')).toBe(true)
    expect(redirectMatches(['https://claude.ai/cb'], 'https://claude.ai/cb2')).toBe(false)
  })

  it('client ID metadata documents: fetched from public https only, and must name themselves', async () => {
    const id = 'https://claude.ai/oauth/claude-code-client-metadata'
    const doc = { client_id: id, client_name: 'Claude Code', redirect_uris: ['http://localhost/callback'] }
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify(doc))) as any
    expect(await resolveOAuthClient(id, fetchImpl)).toEqual({ id, name: 'Claude Code', redirectUris: ['http://localhost/callback'] })
    expect(await resolveOAuthClient('https://127.0.0.1/meta', fetchImpl)).toBeNull()
    const liar = vi.fn(async () => new Response(JSON.stringify({ ...doc, client_id: 'https://other.example/x' }))) as any
    expect(await resolveOAuthClient('https://other.example/y', liar)).toBeNull()
  })
})

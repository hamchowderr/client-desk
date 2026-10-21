import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { registerApiRoute } from '@mastra/core/server'
import type { ApiRoute } from '@mastra/core/server'
import type { Context } from 'hono'
import { getDb } from '../db/client'
import { redirectMatches, register, resolveOAuthClient } from './clients'
import { ACCESS_TTL_S, REFRESH_TTL_S, type Who, principalForWho, whoForEmail } from './identity'
import { provider, providers, verifiedEmail } from './providers'
import { seal, sealingAvailable, unseal } from './seal'

/**
 * The desk's own OAuth 2.1 authorization server, so a client adds the
 * connector with one address and signs in with their work account. Nothing
 * to copy or paste: the email they sign in with picks their contact record.
 *
 *   /.well-known/oauth-protected-resource[/mcp]  where to sign in (RFC 9728)
 *   /.well-known/oauth-authorization-server       how (RFC 8414)
 *   /oauth/register                               dynamic registration (RFC 7591)
 *   /oauth/authorize                              sign-in page (PKCE S256 only)
 *   /oauth/login/:provider, /oauth/callback/:provider   Microsoft or Google
 *   /oauth/token                                  codes and refresh tokens
 */
export const publicUrl = () => (process.env.DESK_PUBLIC_URL ?? 'https://desk.otakusolutions.io').replace(/\/$/, '')
export const mcpResource = () => `${publicUrl()}/mcp`
export const resourceMetadataUrl = () => `${publicUrl()}/.well-known/oauth-protected-resource/mcp`

const SCOPE = 'desk'
const CSRF_COOKIE = 'desk_oauth'
const now = () => Math.floor(Date.now() / 1000)
const b64sha256 = (s: string) => createHash('sha256').update(s).digest('base64url')

type SignInRequest = { cid: string; ru: string; cc: string; st?: string; exp: number }
type ProviderState = { rq: string; p: string; n: string; x: string; exp: number }
type Code = { who: Who; cid: string; ru: string; cc: string; j: string; exp: number }
type Refresh = { who: Who; cid: string; exp: number }

// Codes live two minutes and are single use; one desk instance runs, so memory is enough.
const usedCodes = new Map<string, number>()
function spendCode(j: string, exp: number): boolean {
  const t = now()
  for (const [k, e] of usedCodes) if (e < t) usedCodes.delete(k)
  if (usedCodes.has(j)) return false
  usedCodes.set(j, exp)
  return true
}

function protectedResource() {
  return {
    resource: mcpResource(),
    authorization_servers: [publicUrl()],
    bearer_methods_supported: ['header'],
    scopes_supported: [SCOPE],
    resource_name: 'Otaku Solutions',
  }
}

function authorizationServer() {
  const base = publicUrl()
  return {
    issuer: base,
    authorization_endpoint: `${base}/oauth/authorize`,
    token_endpoint: `${base}/oauth/token`,
    registration_endpoint: `${base}/oauth/register`,
    response_types_supported: ['code'],
    response_modes_supported: ['query'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: ['none'],
    scopes_supported: [SCOPE],
    client_id_metadata_document_supported: true,
    authorization_response_iss_parameter_supported: true,
  }
}

const esc = (s: string) =>
  s.replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]!)

function page(c: Context, title: string, body: string, status = 200) {
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)} · Otaku Solutions</title><meta name="referrer" content="no-referrer">
<style>
:root{--bg:#f6f5f2;--card:#fff;--text:#1d1b19;--muted:#6b6560;--line:#e4e0da;--btn:#1d1b19;--btnText:#fff}
@media (prefers-color-scheme:dark){:root{--bg:#141312;--card:#1d1c1a;--text:#f1eee9;--muted:#a59f97;--line:#33302c;--btn:#f1eee9;--btnText:#141312}}
*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;background:var(--bg);color:var(--text);font:16px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif;padding:16px}
main{width:100%;max-width:400px;background:var(--card);border:1px solid var(--line);border-radius:14px;padding:28px}
.brand{font-size:13px;letter-spacing:.06em;text-transform:uppercase;color:var(--muted);margin:0 0 18px}
h1{font-size:21px;line-height:1.3;margin:0 0 10px}p{margin:0 0 14px;color:var(--muted)}
form{margin:0}button{width:100%;margin-top:10px;padding:12px 14px;border-radius:10px;border:1px solid var(--btn);background:var(--btn);color:var(--btnText);font:inherit;font-weight:600;cursor:pointer}
button.alt{background:transparent;color:var(--text);border-color:var(--line)}.fine{font-size:13px;margin-top:18px}
</style></head><body><main><p class="brand">Otaku Solutions</p>${body}</main></body></html>`
  c.header('Cache-Control', 'no-store')
  c.header('X-Frame-Options', 'DENY')
  c.header('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; form-action 'self' https:; frame-ancestors 'none'")
  return c.html(html, status as 200)
}

const problem = (c: Context, title: string, message: string, status = 400) =>
  page(c, title, `<h1>${esc(title)}</h1><p>${esc(message)}</p>`, status)

function readCookie(c: Context, name: string): string | undefined {
  const header = c.req.header('cookie') ?? ''
  for (const part of header.split(';')) {
    const [k, ...v] = part.trim().split('=')
    if (k === name) return decodeURIComponent(v.join('='))
  }
  return undefined
}

const sameSecret = (a: string | undefined, b: string | undefined) =>
  !!a && !!b && a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b))

function backTo(redirectUri: string, params: Record<string, string | undefined>) {
  const u = new URL(redirectUri)
  for (const [k, v] of Object.entries(params)) if (v !== undefined) u.searchParams.set(k, v)
  return u.toString()
}

const hostOf = (uri: string) => {
  try {
    return new URL(uri).host || uri
  } catch {
    return uri
  }
}

/** GET /oauth/authorize: check the app's request, then show the sign-in buttons. */
async function authorize(c: Context) {
  if (!sealingAvailable()) return problem(c, 'Sign-in is not set up', 'Please let Otaku Solutions know.', 503)
  const q = c.req.query()
  const client = await resolveOAuthClient(q.client_id)
  if (!client) return problem(c, "This app isn't recognised", 'The app that sent you here did not identify itself. Try connecting again.')
  const redirectUri = q.redirect_uri ?? (client.redirectUris.length === 1 ? client.redirectUris[0] : undefined)
  if (!redirectUri || !redirectMatches(client.redirectUris, redirectUri)) {
    return problem(c, "This app isn't recognised", 'The app asked to send you somewhere it did not register. Try connecting again.')
  }
  const fail = (error: string, description: string) =>
    c.redirect(backTo(redirectUri, { error, error_description: description, state: q.state, iss: publicUrl() }), 302)
  if (q.response_type !== 'code') return fail('unsupported_response_type', 'Only the code flow is supported')
  if (!q.code_challenge || q.code_challenge_method !== 'S256') return fail('invalid_request', 'PKCE with S256 is required')
  if (q.resource && q.resource.replace(/\/$/, '') !== mcpResource()) return fail('invalid_target', 'Unknown resource')

  const choices = providers()
  if (choices.length === 0) return problem(c, 'Sign-in is not set up', 'Please let Otaku Solutions know.', 503)
  const request = seal('rq', { cid: client.id, ru: redirectUri, cc: q.code_challenge, st: q.state, exp: now() + 15 * 60 } satisfies SignInRequest)
  // Ties the button press to this browser, so nobody can skip this page with a crafted link.
  const csrf = randomBytes(18).toString('base64url')
  c.header('Set-Cookie', `${CSRF_COOKIE}=${csrf}; Path=/oauth; HttpOnly; Secure; SameSite=Lax; Max-Age=900`)
  const buttons = choices
    .map(
      (p, i) =>
        `<form method="post" action="/oauth/login/${p.id}"><input type="hidden" name="request" value="${esc(request)}"><input type="hidden" name="csrf" value="${csrf}"><button${i ? ' class="alt"' : ''}>${esc(p.label)}</button></form>`,
    )
    .join('')
  return page(
    c,
    'Sign in',
    `<h1>Connect ${esc(client.name)} to Otaku Solutions</h1>
<p>Sign in with the work email Otaku Solutions has for you. ${esc(client.name)} can then see and send your requests.</p>
${buttons}
<p class="fine">You'll return to ${esc(hostOf(redirectUri))}.</p>`,
  )
}

/** POST /oauth/login/:provider: off to Microsoft or Google. */
async function login(c: Context) {
  const p = provider(c.req.param('provider') ?? '')
  if (!p) return problem(c, 'Unknown sign-in option', 'Go back and pick one of the buttons.', 404)
  const form = await c.req.parseBody()
  const request = typeof form.request === 'string' ? form.request : undefined
  const csrf = typeof form.csrf === 'string' ? form.csrf : undefined
  if (!unseal<SignInRequest>('rq', request) || !sameSecret(csrf, readCookie(c, CSRF_COOKIE))) {
    return problem(c, 'This sign-in expired', 'Go back to the app and connect again.')
  }
  const nonce = randomBytes(18).toString('base64url')
  const state = seal('st', { rq: request!, p: p.id, n: nonce, x: csrf!, exp: now() + 15 * 60 } satisfies ProviderState)
  const url = new URL(p.authorizeUrl)
  url.search = new URLSearchParams({
    client_id: p.clientId,
    response_type: 'code',
    response_mode: 'query',
    redirect_uri: `${publicUrl()}/oauth/callback/${p.id}`,
    scope: 'openid email profile',
    state,
    nonce,
    prompt: 'select_account',
  }).toString()
  return c.redirect(url.toString(), 302)
}

/** GET /oauth/callback/:provider: match the verified email to a contact and hand the app its code. */
async function callback(c: Context) {
  const p = provider(c.req.param('provider') ?? '')
  const q = c.req.query()
  const st = unseal<ProviderState>('st', q.state)
  const request = st && unseal<SignInRequest>('rq', st.rq)
  if (!p || !st || !request || st.p !== p.id || !sameSecret(st.x, readCookie(c, CSRF_COOKIE))) {
    return problem(c, 'This sign-in expired', 'Go back to the app and connect again.')
  }
  c.header('Set-Cookie', `${CSRF_COOKIE}=; Path=/oauth; HttpOnly; Secure; SameSite=Lax; Max-Age=0`)
  if (q.error || !q.code) return problem(c, 'Sign-in was cancelled', 'Go back to the app and connect again when you are ready.')
  const result = await verifiedEmail(p, { code: q.code, redirectUri: `${publicUrl()}/oauth/callback/${p.id}`, nonce: st.n })
  if ('refused' in result) return problem(c, "We couldn't sign you in", result.refused, 403)
  const who = await whoForEmail(getDb(), result.email)
  if (!who) {
    return problem(
      c,
      "We don't have this email yet",
      `${result.email} isn't on an Otaku Solutions account. Ask Otaku Solutions to add it, or sign in with the email they have for you.`,
      403,
    )
  }
  const code = seal('cd', {
    who,
    cid: request.cid,
    ru: request.ru,
    cc: request.cc,
    j: randomBytes(12).toString('base64url'),
    exp: now() + 120,
  } satisfies Code)
  return c.redirect(backTo(request.ru, { code, state: request.st, iss: publicUrl() }), 302)
}

function tokenError(c: Context, error: string, description: string, status = 400) {
  c.header('Cache-Control', 'no-store')
  return c.json({ error, error_description: description }, status as 400)
}

function issueTokens(c: Context, who: Who, cid: string) {
  c.header('Cache-Control', 'no-store')
  c.header('Pragma', 'no-cache')
  return c.json({
    access_token: seal('at', { who, cid, exp: now() + ACCESS_TTL_S }),
    token_type: 'Bearer',
    expires_in: ACCESS_TTL_S,
    refresh_token: seal('rt', { who, cid, exp: now() + REFRESH_TTL_S } satisfies Refresh),
    scope: SCOPE,
  })
}

/** POST /oauth/token */
async function token(c: Context) {
  if (!sealingAvailable()) return tokenError(c, 'temporarily_unavailable', 'OAuth is not configured', 503)
  const form = (await c.req.parseBody().catch(() => ({}))) as Record<string, string>
  const get = (k: string) => (typeof form[k] === 'string' ? form[k] : undefined)
  const resource = get('resource')
  if (resource && resource.replace(/\/$/, '') !== mcpResource()) return tokenError(c, 'invalid_target', 'Unknown resource')
  const db = getDb()

  if (get('grant_type') === 'authorization_code') {
    const code = unseal<Code>('cd', get('code'))
    const verifier = get('code_verifier')
    if (!code || !verifier) return tokenError(c, 'invalid_grant', 'The code is invalid or expired')
    if (get('client_id') && get('client_id') !== code.cid) return tokenError(c, 'invalid_grant', 'The code belongs to another app')
    if (get('redirect_uri') !== code.ru) return tokenError(c, 'invalid_grant', 'redirect_uri does not match')
    if (!sameSecret(b64sha256(verifier), code.cc)) return tokenError(c, 'invalid_grant', 'PKCE verification failed')
    if (!spendCode(code.j, code.exp)) return tokenError(c, 'invalid_grant', 'The code was already used')
    if (!(await principalForWho(db, code.who))) return tokenError(c, 'invalid_grant', 'This account no longer has access')
    return issueTokens(c, code.who, code.cid)
  }

  if (get('grant_type') === 'refresh_token') {
    const refresh = unseal<Refresh>('rt', get('refresh_token'))
    if (!refresh) return tokenError(c, 'invalid_grant', 'The refresh token is invalid or expired')
    if (get('client_id') && get('client_id') !== refresh.cid) return tokenError(c, 'invalid_grant', 'The token belongs to another app')
    if (!(await principalForWho(db, refresh.who))) return tokenError(c, 'invalid_grant', 'This account no longer has access')
    return issueTokens(c, refresh.who, refresh.cid)
  }

  return tokenError(c, 'unsupported_grant_type', 'Use authorization_code or refresh_token')
}

/** POST /oauth/register */
async function registerClient(c: Context) {
  if (!sealingAvailable()) return tokenError(c, 'temporarily_unavailable', 'OAuth is not configured', 503)
  const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null
  if (!body || typeof body !== 'object') return tokenError(c, 'invalid_client_metadata', 'Send the registration as JSON')
  const out = register(body)
  if ('error' in out) return tokenError(c, 'invalid_redirect_uri', out.error)
  c.header('Cache-Control', 'no-store')
  return c.json(
    {
      client_id: out.client.id,
      client_id_issued_at: now(),
      client_name: out.client.name,
      redirect_uris: out.client.redirectUris,
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
      scope: SCOPE,
    },
    201,
  )
}

const json = (doc: () => object) => async (c: Context) => {
  c.header('Cache-Control', 'public, max-age=3600')
  return c.json(doc())
}

const open = { requiresAuth: false } as const

export const oauthRoutes: ApiRoute[] = [
  registerApiRoute('/.well-known/oauth-protected-resource', { method: 'GET', ...open, handler: json(protectedResource) }),
  registerApiRoute('/.well-known/oauth-protected-resource/mcp', { method: 'GET', ...open, handler: json(protectedResource) }),
  registerApiRoute('/.well-known/oauth-authorization-server', { method: 'GET', ...open, handler: json(authorizationServer) }),
  registerApiRoute('/oauth/register', { method: 'POST', ...open, handler: registerClient }),
  registerApiRoute('/oauth/authorize', { method: 'GET', ...open, handler: authorize }),
  registerApiRoute('/oauth/login/:provider', { method: 'POST', ...open, handler: login }),
  registerApiRoute('/oauth/callback/:provider', { method: 'GET', ...open, handler: callback }),
  registerApiRoute('/oauth/token', { method: 'POST', ...open, handler: token }),
]

import { randomBytes } from 'node:crypto'
import { verifyOAuthQueryParams } from '@better-auth/oauth-provider'
import { registerApiRoute } from '@mastra/core/server'
import type { ApiRoute } from '@mastra/core/server'
import type { Context } from 'hono'
import { getAuth } from '.'

/**
 * Better Auth's endpoints (under /auth, plus its /.well-known discovery
 * documents) and the two pages it sends people to: /sign-in for the email
 * code, /consent to let the app in.
 */
const esc = (s: string) =>
  s.replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]!)

function page(c: Context, title: string, body: string, script = '', status = 200) {
  const nonce = randomBytes(16).toString('base64')
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)} · Otaku Solutions</title><meta name="referrer" content="no-referrer">
<style>
:root{--bg:#f6f5f2;--card:#fff;--text:#1d1b19;--muted:#6b6560;--line:#e4e0da;--btn:#1d1b19;--btnText:#fff;--err:#b42318}
@media (prefers-color-scheme:dark){:root{--bg:#141312;--card:#1d1c1a;--text:#f1eee9;--muted:#a59f97;--line:#33302c;--btn:#f1eee9;--btnText:#141312;--err:#f97066}}
*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;background:var(--bg);color:var(--text);font:16px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif;padding:16px}
main{width:100%;max-width:400px;background:var(--card);border:1px solid var(--line);border-radius:14px;padding:28px}
.brand{font-size:13px;letter-spacing:.06em;text-transform:uppercase;color:var(--muted);margin:0 0 18px}
h1{font-size:21px;line-height:1.3;margin:0 0 10px}p{margin:0 0 14px;color:var(--muted)}
label{display:block;font-size:14px;font-weight:600;margin:0 0 6px}
input{width:100%;padding:11px 12px;border-radius:10px;border:1px solid var(--line);background:transparent;color:var(--text);font:inherit}
input.code{font-size:24px;letter-spacing:6px;text-align:center}
button{width:100%;margin-top:12px;padding:12px 14px;border-radius:10px;border:1px solid var(--btn);background:var(--btn);color:var(--btnText);font:inherit;font-weight:600;cursor:pointer}
button.alt{background:transparent;color:var(--text);border-color:var(--line)}button:disabled{opacity:.6;cursor:default}
.err{color:var(--err);font-size:14px;margin:10px 0 0;min-height:1em}[hidden]{display:none}
</style></head><body><main><p class="brand">Otaku Solutions</p>${body}</main>${script ? `<script nonce="${nonce}">${script}</script>` : ''}</body></html>`
  c.header('Cache-Control', 'no-store')
  c.header('X-Frame-Options', 'DENY')
  c.header(
    'Content-Security-Policy',
    `default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}'; connect-src 'self'; form-action 'self'; frame-ancestors 'none'`,
  )
  return c.html(html, status as 200)
}

const problem = (c: Context, title: string, message: string, status = 400) =>
  page(c, title, `<h1>${esc(title)}</h1><p>${esc(message)}</p>`, '', status)

/** Posts JSON to Better Auth and follows the redirect it answers with. */
const CLIENT_JS = `
const q = location.search.slice(1);
async function post(path, body) {
  const res = await fetch('/auth' + path, {
    method: 'POST', credentials: 'same-origin',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({ ...body, oauth_query: q }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.message || data.error_description || 'Something went wrong. Please try again.');
  return data;
}
function go(data) { const url = data && (data.url || data.redirect_uri); if (url) location.assign(url); return !!url; }
function busy(btn, on) { btn.disabled = on; }
`

const SIGN_IN_JS = `${CLIENT_JS}
const emailForm = document.getElementById('email-form'), codeForm = document.getElementById('code-form');
const err = document.getElementById('err'); let email = '';
emailForm.addEventListener('submit', async (e) => {
  e.preventDefault(); err.textContent = ''; const btn = emailForm.querySelector('button'); busy(btn, true);
  email = document.getElementById('email').value.trim();
  try {
    await post('/email-otp/send-verification-otp', { email, type: 'sign-in' });
    document.getElementById('sent-to').textContent = email;
    emailForm.hidden = true; codeForm.hidden = false; document.getElementById('code').focus();
  } catch (x) { err.textContent = x.message; } finally { busy(btn, false); }
});
codeForm.addEventListener('submit', async (e) => {
  e.preventDefault(); err.textContent = ''; const btn = codeForm.querySelector('button'); busy(btn, true);
  try {
    const data = await post('/sign-in/email-otp', { email, otp: document.getElementById('code').value.replace(/\\s/g, '') });
    if (!go(data)) err.textContent = 'Signed in. You can close this tab and return to the app.';
  } catch (x) { err.textContent = x.message; busy(btn, false); }
});
document.getElementById('restart').addEventListener('click', () => { codeForm.hidden = true; emailForm.hidden = false; err.textContent = ''; });
`

const CONSENT_JS = `${CLIENT_JS}
const err = document.getElementById('err');
for (const [id, accept] of [['allow', true], ['deny', false]]) {
  document.getElementById(id).addEventListener('click', async (e) => {
    err.textContent = ''; busy(e.target, true);
    try { const data = await post('/oauth2/consent', { accept }); if (!go(data)) err.textContent = 'Done. You can close this tab.'; }
    catch (x) { err.textContent = x.message; busy(e.target, false); }
  });
}
`

async function signIn(c: Context) {
  const auth = getAuth()
  const query = new URL(c.req.url).search.slice(1)
  if (!(await verifyOAuthQueryParams(query, (await auth.$context).secret))) {
    return problem(c, 'This sign-in expired', 'Go back to the app and connect again.')
  }
  return page(
    c,
    'Sign in',
    `<h1>Sign in to Otaku Solutions</h1>
<form id="email-form"><p>Enter the email Otaku Solutions has for you. We'll email you a code.</p>
<label for="email">Email</label><input id="email" type="email" autocomplete="email" required autofocus>
<button>Email me a code</button></form>
<form id="code-form" hidden><p>If <strong id="sent-to"></strong> is the email Otaku Solutions has for you, a 6-digit code is on its way. Nothing after a few minutes? Check the address, or ask Otaku Solutions which email they have.</p>
<label for="code">Code</label><input id="code" class="code" inputmode="numeric" autocomplete="one-time-code" maxlength="8" required>
<button>Sign in</button><button type="button" id="restart" class="alt">Use a different email</button></form>
<p class="err" id="err" role="alert"></p>`,
    SIGN_IN_JS,
  )
}

async function consent(c: Context) {
  const auth = getAuth()
  const query = new URL(c.req.url).search.slice(1)
  if (!(await verifyOAuthQueryParams(query, (await auth.$context).secret))) {
    return problem(c, 'This sign-in expired', 'Go back to the app and connect again.')
  }
  const clientId = new URLSearchParams(query).get('client_id') ?? ''
  const client = (await auth.api
    .getOAuthClientPublic({ query: { client_id: clientId }, headers: c.req.raw.headers })
    .catch(() => null)) as { client_name?: string } | null
  if (!client) return problem(c, 'This sign-in expired', 'Go back to the app and connect again.')
  let name = client.client_name
  if (!name) {
    try {
      name = new URL(clientId).hostname
    } catch {
      name = 'This app'
    }
  }
  return page(
    c,
    'Allow access',
    `<h1>Let ${esc(name)} use your Otaku Solutions account?</h1>
<p>${esc(name)} will be able to see your requests and their status, and send new requests for you.</p>
<button id="allow">Allow</button><button id="deny" class="alt">Cancel</button>
<p class="err" id="err" role="alert"></p>`,
    CONSENT_JS,
  )
}

const toAuth = async (c: Context) => getAuth().handler(c.req.raw)
const open = { requiresAuth: false } as const

export const authRoutes: ApiRoute[] = [
  registerApiRoute('/auth/*', { method: 'ALL', ...open, handler: toAuth }),
  registerApiRoute('/.well-known/*', { method: 'GET', ...open, handler: toAuth }),
  registerApiRoute('/sign-in', { method: 'GET', ...open, handler: signIn }),
  registerApiRoute('/consent', { method: 'GET', ...open, handler: consent }),
]

/**
 * The sign-in buttons on the desk's login page. Each is a plain OpenID Connect
 * code flow against the provider; the desk only needs a verified email from it.
 *
 * The id_token comes straight from the provider's token endpoint over TLS, in
 * exchange for our client secret, so its claims are trusted without checking
 * the signature (OpenID Connect Core 3.1.3.7); issuer, audience, nonce and
 * expiry are still checked.
 */
export type ProviderId = 'microsoft' | 'google'

export type Provider = {
  id: ProviderId
  label: string
  clientId: string
  clientSecret: string
  authorizeUrl: string
  tokenUrl: string
  /** The verified email in the id_token's claims, or a reason it can't be trusted. */
  emailFrom: (claims: Record<string, unknown>) => { email: string } | { refused: string }
  issuerOk: (claims: Record<string, unknown>) => boolean
}

const str = (v: unknown) => (typeof v === 'string' ? v : undefined)

function microsoft(): Provider | null {
  const clientId = process.env.MICROSOFT_CLIENT_ID
  const clientSecret = process.env.MICROSOFT_CLIENT_SECRET
  if (!clientId || !clientSecret) return null
  return {
    id: 'microsoft',
    label: 'Continue with Microsoft',
    clientId,
    clientSecret,
    // Any work or school account, plus personal Microsoft accounts.
    authorizeUrl: 'https://login.microsoftonline.com/common/oauth2/v2.0/authorize',
    tokenUrl: 'https://login.microsoftonline.com/common/oauth2/v2.0/token',
    issuerOk: (c) => str(c.iss) === `https://login.microsoftonline.com/${str(c.tid)}/v2.0`,
    // A tenant admin can set any address on an account, so the email only counts
    // when Microsoft says the tenant owns its domain (the xms_edov optional claim).
    emailFrom: (c) => {
      const email = str(c.email)
      if (!email) return { refused: 'Microsoft did not share an email address for this account.' }
      if (c.xms_edov !== true && c.xms_edov !== 'true' && c.xms_edov !== 1) {
        return { refused: "Microsoft couldn't confirm this account owns its email address." }
      }
      return { email }
    },
  }
}

function google(): Provider | null {
  const clientId = process.env.GOOGLE_CLIENT_ID
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET
  if (!clientId || !clientSecret) return null
  return {
    id: 'google',
    label: 'Continue with Google',
    clientId,
    clientSecret,
    authorizeUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
    tokenUrl: 'https://oauth2.googleapis.com/token',
    issuerOk: (c) => c.iss === 'https://accounts.google.com' || c.iss === 'accounts.google.com',
    emailFrom: (c) => {
      const email = str(c.email)
      if (!email) return { refused: 'Google did not share an email address for this account.' }
      if (c.email_verified !== true && c.email_verified !== 'true') {
        return { refused: "Google hasn't verified this account's email address." }
      }
      return { email }
    },
  }
}

export function providers(): Provider[] {
  return [microsoft(), google()].filter((p): p is Provider => p !== null)
}

export const provider = (id: string) => providers().find((p) => p.id === id) ?? null

/** The id_token's claims, decoded without a signature check (see the note at the top). */
export function idTokenClaims(idToken: string): Record<string, unknown> | null {
  const part = idToken.split('.')[1]
  if (!part) return null
  try {
    return JSON.parse(Buffer.from(part, 'base64url').toString('utf8'))
  } catch {
    return null
  }
}

/** Trade the provider's code for its id_token and return the verified email. */
export async function verifiedEmail(
  p: Provider,
  input: { code: string; redirectUri: string; nonce: string },
  fetchImpl: typeof fetch = fetch,
  now = Date.now(),
): Promise<{ email: string } | { refused: string }> {
  const res = await fetchImpl(p.tokenUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code: input.code,
      redirect_uri: input.redirectUri,
      client_id: p.clientId,
      client_secret: p.clientSecret,
    }),
  })
  const body = (await res.json().catch(() => ({}))) as { id_token?: string }
  if (!res.ok || !body.id_token) return { refused: 'The sign-in did not complete. Please try again.' }
  const claims = idTokenClaims(body.id_token)
  const aud = claims?.aud
  if (
    !claims ||
    !p.issuerOk(claims) ||
    !(aud === p.clientId || (Array.isArray(aud) && aud.includes(p.clientId))) ||
    claims.nonce !== input.nonce ||
    typeof claims.exp !== 'number' ||
    claims.exp * 1000 < now
  ) {
    return { refused: 'The sign-in could not be verified. Please try again.' }
  }
  const out = p.emailFrom(claims)
  return 'email' in out ? { email: out.email.trim().toLowerCase() } : out
}

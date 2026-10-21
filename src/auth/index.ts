import { hkdfSync } from 'node:crypto'
import { cimd } from '@better-auth/cimd'
import { fetchClientMetadataResource } from '@better-auth/cimd/node'
import { mcp } from '@better-auth/mcp'
import { verifyAccessTokenRequest, verifyJwsAccessToken } from '@better-auth/core/oauth2'
import { betterAuth } from 'better-auth'
import type { BetterAuthOptions } from 'better-auth'
import { APIError } from 'better-auth/api'
import { emailOTP, jwt } from 'better-auth/plugins'
import { Pool } from 'pg'
import { getDb } from '../db/client'
import { type Who, whoForEmail } from './identity'
import { sendSignInCode } from './email'

/**
 * Sign-in for the /mcp connector, on Better Auth. A client adds
 * https://desk.otakusolutions.io/mcp in Claude, types their email, and gets a
 * code from Otaku Solutions (sent by FluentCRM on the hub). Better Auth's MCP
 * plugin is the OAuth 2.1 server: discovery, Client ID Metadata Documents,
 * dynamic registration, PKCE, consent and tokens.
 *
 * Only emails the desk knows (a client contact, or DESK_OWNER_EMAILS) can get a
 * code or an account. Better Auth's tables live in Mastra's Postgres (Supabase),
 * schema desk_auth, so sign-ins stay out of the versioned desk data.
 */
export const publicUrl = () => (process.env.DESK_PUBLIC_URL ?? 'https://desk.otakusolutions.io').replace(/\/$/, '')
export const mcpResource = () => `${publicUrl()}/mcp`
export const issuer = () => `${publicUrl()}/auth`
export const AUTH_SCHEMA = 'desk_auth'

/** The desk email claim on access tokens, so /mcp can find the contact without a lookup. */
export const EMAIL_CLAIM = 'https://desk.otakusolutions.io/email'

const NOT_ON_FILE =
  "This email isn't on an Otaku Solutions account. Use the email Otaku Solutions has for you, or ask them to add this one."

function secret(): string {
  if (process.env.DESK_AUTH_SECRET) return process.env.DESK_AUTH_SECRET
  const admin = process.env.DESK_ADMIN_KEY
  if (!admin || admin.length < 24) throw new Error('Sign-in needs DESK_AUTH_SECRET or DESK_ADMIN_KEY')
  return Buffer.from(hkdfSync('sha256', admin, 'client-desk', 'better-auth-v1', 32)).toString('hex')
}

async function knownEmail(email: string): Promise<Who> {
  const who = await whoForEmail(getDb(), email)
  if (!who) throw new APIError('FORBIDDEN', { message: NOT_ON_FILE })
  return who
}

export type DeskAuthOptions = {
  database: BetterAuthOptions['database']
  sendCode?: (email: string, code: string) => Promise<void>
}

export function deskAuthConfig(opts: DeskAuthOptions) {
  const send = opts.sendCode ?? sendSignInCode
  return {
    appName: 'Otaku Solutions',
    baseURL: publicUrl(),
    basePath: '/auth',
    secret: secret(),
    database: opts.database,
    // Accounts only come from email codes, and only for known emails.
    emailAndPassword: { enabled: false },
    databaseHooks: {
      user: {
        create: {
          before: async (user) => {
            await knownEmail(user.email)
            return { data: user }
          },
        },
      },
    },
    plugins: [
      jwt(),
      emailOTP({
        otpLength: 6,
        expiresIn: 10 * 60,
        allowedAttempts: 5,
        async sendVerificationOTP({ email, otp, type }) {
          // Better Auth answers the same either way, so the page never reveals whether an email is on file.
          if (type !== 'sign-in' || !(await whoForEmail(getDb(), email))) return
          await send(email, otp)
        },
      }),
      mcp({
        loginPage: '/sign-in',
        consentPage: '/consent',
        resource: mcpResource(),
        scopes: ['openid', 'profile', 'email', 'offline_access'],
        // Claude uses Client ID Metadata Documents; registration stays for older hosts.
        allowDynamicClientRegistration: true,
        allowUnauthenticatedClientRegistration: true,
        customAccessTokenClaims: ({ user }) => (user?.email ? { [EMAIL_CLAIM]: user.email.toLowerCase() } : {}),
      }),
      cimd({ fetchClientMetadataResource, metadataProfile: 'mcp-2026-07-28' }),
    ],
  } satisfies BetterAuthOptions
}

export type DeskAuth = ReturnType<typeof makeAuth>
const makeAuth = (opts: DeskAuthOptions) => betterAuth(deskAuthConfig(opts))

let cached: DeskAuth | undefined
let pool: Pool | undefined

function authPool(): Pool {
  const url = process.env.MASTRA_DATABASE_URL
  if (!url) throw new Error('Sign-in needs MASTRA_DATABASE_URL')
  pool ??= new Pool({ connectionString: url, max: 5, options: `-c search_path=${AUTH_SCHEMA}` })
  return pool
}

/** The desk's Better Auth, on Mastra's Postgres. */
export function getAuth(): DeskAuth {
  cached ??= makeAuth({ database: authPool() })
  return cached
}

/** Tests swap in an auth on the memory adapter. */
export function setAuth(auth: DeskAuth | undefined, options?: DeskAuthOptions) {
  cached = auth ?? (options ? makeAuth(options) : undefined)
  return cached
}

export function createDeskAuth(opts: DeskAuthOptions) {
  return makeAuth(opts)
}

/** Create the desk_auth schema and Better Auth's tables if they are missing. */
export async function migrateAuth() {
  const { getMigrations } = await import('better-auth/db/migration')
  const p = authPool()
  await p.query(`create schema if not exists ${AUTH_SCHEMA}`)
  const { runMigrations } = await getMigrations(deskAuthConfig({ database: p }))
  await runMigrations()
}

export type TokenOwner = { email: string; clientId: string; expiresAt?: number }

function ownerFromClaims(claims: Record<string, unknown>): TokenOwner | null {
  const email = claims[EMAIL_CLAIM]
  if (typeof email !== 'string') return null
  return { email, clientId: String(claims.azp ?? claims.client_id ?? 'oauth'), expiresAt: claims.exp as number | undefined }
}

/** The verified email on a plain bearer access token Better Auth issued for /mcp, or null. */
export async function emailForAccessToken(token: string): Promise<TokenOwner | null> {
  if (token.split('.').length !== 3) return null
  const auth = getAuth()
  try {
    const claims = await verifyJwsAccessToken(token, {
      jwksFetch: async () => (await auth.api.getJwks()) as any,
      jwksCacheKey: auth,
      verifyOptions: { issuer: issuer(), audience: mcpResource() },
    })
    // A DPoP-bound token is only good with its proof, which only /mcp checks.
    if (claims.cnf) return null
    return ownerFromClaims(claims)
  } catch {
    return null
  }
}

/**
 * The verified email on a request to /mcp, bearer or DPoP-bound (Better Auth
 * advertises DPoP, so a host may use it). The proof is checked against the
 * public URL, since the request arrives here through Coolify's proxy.
 */
export async function emailForMcpRequest(request: Request): Promise<TokenOwner | null> {
  const url = new URL(request.url)
  try {
    const claims = await verifyAccessTokenRequest(
      {
        authorizationHeader: request.headers.get('authorization'),
        dpopProofJwt: request.headers.get('dpop'),
        method: request.method,
        url: `${publicUrl()}${url.pathname}${url.search}`,
      },
      { verifyOptions: { issuer: issuer(), audience: mcpResource() }, jwksUrl: `${issuer()}/jwks` },
    )
    return ownerFromClaims(claims)
  } catch {
    return null
  }
}

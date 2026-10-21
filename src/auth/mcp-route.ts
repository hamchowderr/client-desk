import { registerApiRoute } from '@mastra/core/server'
import { getDb } from '../db/client'
import { deskUserForToken } from '../mastra/auth/key-auth'
import { clientMcp, deskMcp, serveMcp } from '../mastra/mcp'
import { emailForMcpRequest, mcpResource, publicUrl } from '.'
import { principalForEmail } from './identity'

/**
 * https://desk.otakusolutions.io/mcp, the one address anyone adds. A client
 * who signs in gets their own client tools; the owner gets the admin server.
 * Without a token it answers 401 with where to sign in, which is what makes
 * Claude open the sign-in page.
 */
/** A desk key, or a sign-in token (with its DPoP proof when it has one). */
async function userFor(request: Request, token: string) {
  const db = getDb()
  if (/^Bearer\s/i.test(request.headers.get('authorization') ?? '')) {
    const keyed = await deskUserForToken(db, token)
    if (keyed) return keyed
  }
  const owner = await emailForMcpRequest(request)
  const principal = owner && (await principalForEmail(db, owner.email))
  if (!owner || !principal) return null
  return {
    id: principal.kind === 'admin' ? `admin:${principal.label}` : `client:${principal.clientId}:${principal.label}`,
    principal,
    scopes: [principal.kind],
    clientId: owner.clientId,
    expiresAt: owner.expiresAt,
  }
}

export const mcpRoute = registerApiRoute('/mcp', {
  method: 'ALL',
  requiresAuth: false,
  handler: async (c) => {
    const header = c.req.header('authorization') ?? ''
    const token = /^(?:Bearer|DPoP)\s+(.+)$/i.exec(header)?.[1]?.trim()
    const user = token ? await userFor(c.req.raw, token) : null
    if (!token || !user) {
      const challenge = [
        `Bearer resource_metadata="${`${publicUrl()}/.well-known/oauth-protected-resource/mcp`}"`,
        ...(token ? ['error="invalid_token"', 'error_description="Sign in again"'] : []),
      ].join(', ')
      c.header('WWW-Authenticate', challenge)
      return c.json({ error: token ? 'invalid_token' : 'unauthorized', message: 'Sign in to use Client Desk' }, 401)
    }
    const server = user.principal.kind === 'admin' ? deskMcp : clientMcp
    return serveMcp(server, c.req.raw, {
      token: token!,
      clientId: user.clientId,
      scopes: user.scopes,
      ...(user.expiresAt && { expiresAt: user.expiresAt }),
      resource: new URL(mcpResource()),
      extra: { user: { id: user.id, principal: user.principal, scopes: user.scopes } },
    })
  },
})

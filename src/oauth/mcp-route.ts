import { registerApiRoute } from '@mastra/core/server'
import { getDb } from '../db/client'
import { deskUserForToken } from '../mastra/auth/key-auth'
import { clientMcp, deskMcp, serveMcp } from '../mastra/mcp'
import { mcpResource, resourceMetadataUrl } from './routes'

/**
 * https://desk.otakusolutions.io/mcp, the one address anyone adds. A client
 * who signs in gets their own client tools; the owner gets the admin server.
 * Without a token it answers 401 with where to sign in, which is what makes
 * Claude open the sign-in page.
 */
export const mcpRoute = registerApiRoute('/mcp', {
  method: 'ALL',
  requiresAuth: false,
  handler: async (c) => {
    const header = c.req.header('authorization') ?? ''
    const token = /^Bearer\s+(.+)$/i.exec(header)?.[1]?.trim()
    const user = token ? await deskUserForToken(getDb(), token) : null
    if (!token || !user) {
      const challenge = [
        `Bearer resource_metadata="${resourceMetadataUrl()}"`,
        'scope="desk"',
        ...(token ? ['error="invalid_token"', 'error_description="Sign in again"'] : []),
      ].join(', ')
      c.header('WWW-Authenticate', challenge)
      return c.json({ error: token ? 'invalid_token' : 'unauthorized', message: 'Sign in to use Client Desk' }, 401)
    }
    const server = user.principal.kind === 'admin' ? deskMcp : clientMcp
    return serveMcp(server, c.req.raw, {
      token: token!,
      clientId: user.clientId,
      scopes: ['desk'],
      ...(user.expiresAt && { expiresAt: user.expiresAt }),
      resource: new URL(mcpResource()),
      extra: { user: { id: user.id, principal: user.principal, scopes: user.scopes } },
    })
  },
})

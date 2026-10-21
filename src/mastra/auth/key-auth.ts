import { MastraAuthProvider } from '@mastra/core/server'
import type { MastraAuthRequest } from '@mastra/core/server'
import { getDb } from '../../db/client'
import type { DbOrTx } from '../../db/client'
import { principalForKey } from '../../domain/keys'
import { principalForAccessToken } from '../../oauth/identity'
import type { Principal } from '../../domain/principal'

/** What Mastra stores as the request's `user`; MCP tools see it as authInfo.extra.user. */
export type DeskUser = {
  id: string
  principal: Principal
  scopes: string[]
}

/** A desk API key or an OAuth access token from the desk's own sign-in, as the caller. */
export async function deskUserForToken(db: DbOrTx, token: string): Promise<(DeskUser & { clientId: string; expiresAt?: number }) | null> {
  if (!token) return null
  const keyed = await principalForKey(db, token)
  const oauth = keyed ? null : await principalForAccessToken(db, token)
  const principal = keyed ?? oauth?.principal
  if (!principal) return null
  return {
    id: principal.kind === 'admin' ? `admin:${principal.label}` : `client:${principal.clientId}:${principal.label}`,
    principal,
    scopes: [principal.kind],
    clientId: oauth?.clientId ?? 'desk-key',
    ...(oauth && { expiresAt: oauth.expiresAt }),
  }
}

/** Bearer API keys (an admin key for Chowderr's own tools, a client key per client agent) and OAuth tokens. */
export class DeskKeyAuth extends MastraAuthProvider<DeskUser> {
  constructor() {
    super({ name: 'desk-keys' })
    // Webhooks prove themselves instead of using a key: Stripe with its
    // signature, chat platforms with their own verification (Teams: a Microsoft JWT).
    this.registerOptions({
      public: [
        '/health',
        ['/health', 'GET'],
        ['/desk/webhooks/stripe', 'POST'],
        ['/api/agents/client-agent/channels/*', 'POST'],
        // OAuth sign-in, and /mcp, which checks its own bearer so it can answer
        // a missing one with where to sign in.
        '/.well-known/*',
        '/oauth/*',
        '/mcp',
      ],
    })
  }

  async authenticateToken(token: string, _request: MastraAuthRequest): Promise<DeskUser | null> {
    const user = await deskUserForToken(getDb(), token)
    return user && { id: user.id, principal: user.principal, scopes: user.scopes }
  }

  async authorizeUser(user: DeskUser): Promise<boolean> {
    return Boolean(user?.principal)
  }
}

import { MastraAuthProvider } from '@mastra/core/server'
import type { MastraAuthRequest } from '@mastra/core/server'
import { getDb } from '../../db/client'
import { principalForKey } from '../../domain/keys'
import type { Principal } from '../../domain/principal'

/** What Mastra stores as the request's `user`; MCP tools see it as authInfo.extra.user. */
export type DeskUser = {
  id: string
  principal: Principal
  scopes: string[]
}

/** Bearer API keys: an admin key for Chowderr's own tools, a client key per client agent. */
export class DeskKeyAuth extends MastraAuthProvider<DeskUser> {
  constructor() {
    super({ name: 'desk-keys' })
    this.registerOptions({ public: ['/health', ['/health', 'GET']] })
  }

  async authenticateToken(token: string, _request: MastraAuthRequest): Promise<DeskUser | null> {
    if (!token) return null
    const principal = await principalForKey(getDb(), token)
    if (!principal) return null
    return {
      id: principal.kind === 'admin' ? `admin:${principal.label}` : `client:${principal.clientId}:${principal.label}`,
      principal,
      scopes: [principal.kind],
    }
  }

  async authorizeUser(user: DeskUser): Promise<boolean> {
    return Boolean(user?.principal)
  }
}

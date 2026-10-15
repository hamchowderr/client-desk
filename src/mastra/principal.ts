import type { RequestContext } from '@mastra/core/request-context'
import { DeskError } from '../domain/errors'
import type { Principal } from '../domain/principal'
import type { DeskUser } from './auth/key-auth'

/** The authenticated caller, from Mastra's request context (routes, MCP tools and agents alike). */
export function principalFrom(ctx: RequestContext | undefined): Principal {
  const direct = ctx?.get('user') as DeskUser | undefined
  const viaMcp = (ctx?.get('authInfo') as { extra?: { user?: DeskUser } } | undefined)?.extra?.user
  const user = direct?.principal ? direct : viaMcp
  if (!user?.principal) throw new DeskError('forbidden', 'Missing or invalid API key')
  return user.principal
}

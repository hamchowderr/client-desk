import { DeskError } from './errors'

/**
 * Who is calling. Admin is Chowderr (and agents he runs with an admin key);
 * a client principal is a client's agent or portal, limited to one client.
 */
export type Principal =
  | { kind: 'admin'; label: string }
  | { kind: 'client'; clientId: string; label: string; contactId?: string }

export const OWNER: Principal = { kind: 'admin', label: 'owner' }

export function requireAdmin(p: Principal): asserts p is Extract<Principal, { kind: 'admin' }> {
  if (p.kind !== 'admin') throw new DeskError('forbidden', 'This needs an admin key')
}

export function assertCanSeeClient(p: Principal, clientId: string) {
  if (p.kind === 'client' && p.clientId !== clientId) {
    // Same answer as a missing client so a client key can't probe for others.
    throw new DeskError('not_found', 'Client not found')
  }
}

/** The author string recorded on updates. */
export function authorOf(p: Principal): string {
  if (p.kind === 'admin') return p.label === 'owner' ? 'owner' : `agent:${p.label}`
  return p.contactId ? `contact:${p.contactId}` : `client-agent:${p.label}`
}

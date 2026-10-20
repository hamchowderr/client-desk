import { crmFromEnv } from '../crm'
import { getDb } from '../db/client'
import { commitVersion, isDolt, isWriteConflict } from '../db/dolt'
import { resolveClient } from '../domain/clients'
import { syncClientToCrm } from '../domain/crm'
import { OWNER, type Principal, authorOf } from '../domain/principal'
import type { Op } from './ops'

const ATTEMPTS = 3

/**
 * Run a desk operation as the caller. On Doltgres every change becomes its own
 * commit (who did what, to which client or request), so the desk can be diffed
 * and rolled back; a transaction that lost a write race is retried.
 */
export async function runOp(op: Op, principal: Principal, input: any) {
  const result = await runVersioned(op, principal, input)
  if (CRM_OPS.has(op.id)) void mirrorToCrm(principal, input)
  return result
}

/** Actions that change who a client's people are or where their retainer stands. */
const CRM_OPS = new Set([
  'create_client',
  'update_client',
  'add_contact',
  'start_retainer',
  'log_kickoff',
  'pause_month',
  'unpause_month',
  'cancel_retainer',
  'request_pause',
])

/** Best effort, after the change is saved: a CRM outage never fails a desk action. */
async function mirrorToCrm(principal: Principal, input: Record<string, unknown>) {
  const crm = crmFromEnv()
  if (!crm) return
  try {
    const db = getDb()
    const clientId =
      principal.kind === 'client'
        ? principal.clientId
        : typeof input?.client === 'string'
          ? (await resolveClient(db, OWNER, input.client)).id
          : typeof input?.code === 'string'
            ? (await resolveClient(db, OWNER, input.code)).id
            : null
    if (clientId) await syncClientToCrm(db, crm, clientId)
  } catch (e) {
    console.error('crm sync failed', e)
  }
}

async function runVersioned(op: Op, principal: Principal, input: any) {
  const db = getDb()
  if (op.http.method === 'GET' || op.versioning === 'manual' || !(await isDolt(db))) {
    return op.run(db, principal, input)
  }
  let result: unknown
  for (let attempt = 1; ; attempt++) {
    try {
      result = await op.run(db, principal, input)
      break
    } catch (e) {
      if (attempt >= ATTEMPTS || !isWriteConflict(e)) throw e
    }
  }
  // The change is already saved; a failed commit only means the next commit
  // carries it too, so it must not fail (or re-run) the operation.
  await commitVersion(db, commitMessage(op, input), authorOf(principal)).catch((e) =>
    console.error('dolt commit failed', e),
  )
  return result
}

function commitMessage(op: Op, input: Record<string, unknown>) {
  const target = [input?.request, input?.client, input?.code].find((x) => typeof x === 'string')
  const title = typeof input?.title === 'string' ? `: ${input.title}` : ''
  return `${op.id}${target ? ` ${target}` : ''}${title}`
}

import { getDb } from '../db/client'
import { commitVersion, isDolt, isWriteConflict } from '../db/dolt'
import { type Principal, authorOf } from '../domain/principal'
import type { Op } from './ops'

const ATTEMPTS = 3

/**
 * Run a desk operation as the caller. On Doltgres every change becomes its own
 * commit (who did what, to which client or request), so the desk can be diffed
 * and rolled back; a transaction that lost a write race is retried.
 */
export async function runOp(op: Op, principal: Principal, input: any) {
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

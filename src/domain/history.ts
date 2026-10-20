import { sql } from 'drizzle-orm'
import type { Db } from '../db/client'
import { isDolt } from '../db/dolt'
import { DeskError } from './errors'
import { type Principal, authorOf, requireAdmin } from './principal'

/** Desk tables whose rows show up in a diff (api_keys stays out: it holds key hashes). */
const DIFF_TABLES = ['clients', 'contacts', 'retainers', 'pauses', 'requests', 'updates', 'channels'] as const

const COMMIT = /^[0-9a-v]{32}$/

async function requireDolt(db: Db) {
  if (!(await isDolt(db))) throw new DeskError('invalid', 'History needs the desk to run on Doltgres')
}

function commitRef(ref: string) {
  if (!COMMIT.test(ref)) throw new DeskError('invalid', 'Use a commit hash from history')
  return ref
}

const rowsOf = (r: unknown) => (Array.isArray(r) ? r : ((r as { rows?: unknown[] })?.rows ?? [])) as Record<string, any>[]

/** Every change to the desk, newest first: who, when, and what. */
export async function listHistory(db: Db, p: Principal, limit = 50) {
  requireAdmin(p)
  await requireDolt(db)
  const rows = rowsOf(
    await db.execute(
      sql`select commit_hash, author, date, message from dolt_log order by commit_order desc limit ${Math.min(Math.max(limit, 1), 500)}`,
    ),
  )
  return rows.map((r) => ({ commit: r.commit_hash, by: r.author, at: r.date, what: r.message }))
}

/**
 * What one commit changed (or everything between two commits): per table, the
 * rows added, removed or modified, with their before and after values.
 */
export async function diffHistory(db: Db, p: Principal, input: { commit: string; to?: string }) {
  requireAdmin(p)
  await requireDolt(db)
  const from = input.to ? commitRef(input.commit) : `${commitRef(input.commit)}~1`
  const to = input.to ? commitRef(input.to) : commitRef(input.commit)
  const changes: Record<string, unknown[]> = {}
  for (const table of DIFF_TABLES) {
    // dolt_diff takes literals only; every value here is a checked hash or a fixed table name.
    const rows = rowsOf(await db.execute(sql.raw(`select * from dolt_diff('${from}', '${to}', '${table}')`)))
    if (!rows.length) continue
    changes[table] = rows.map((r) => {
      const before: Record<string, unknown> = {}
      const after: Record<string, unknown> = {}
      for (const [k, v] of Object.entries(r)) {
        if (k.startsWith('from_') && !['from_commit', 'from_commit_date'].includes(k)) before[k.slice(5)] = v
        if (k.startsWith('to_') && !['to_commit', 'to_commit_date'].includes(k)) after[k.slice(3)] = v
      }
      return { change: r.diff_type, before: r.diff_type === 'added' ? null : before, after: r.diff_type === 'removed' ? null : after }
    })
  }
  return { from, to, changes }
}

/**
 * Put the whole desk back the way it was at a commit. The current state is kept
 * on a branch first, so a restore can itself be undone.
 */
export async function restoreTo(db: Db, p: Principal, commit: string) {
  requireAdmin(p)
  await requireDolt(db)
  const target = commitRef(commit)
  const keptAs = `before-restore-${new Date().toISOString().replace(/[^0-9]/g, '').slice(0, 14)}`
  await db.execute(sql`select dolt_branch(${keptAs})`)
  await db.execute(sql`select dolt_reset('--hard', ${target})`)
  return { restoredTo: target, previousStateKeptOn: keptAs, by: authorOf(p) }
}

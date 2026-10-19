import { sql } from 'drizzle-orm'
import type { Db } from './client'

const probes = new WeakMap<object, Promise<boolean>>()

/**
 * Whether the desk runs on Doltgres (version-controlled Postgres). Production
 * does; tests run on PGlite, which has no Dolt functions.
 */
export function isDolt(db: Db): Promise<boolean> {
  let probe = probes.get(db)
  if (!probe) {
    probe = db.execute(sql`select dolt_version()`).then(
      () => true,
      () => false,
    )
    probes.set(db, probe)
  }
  return probe
}

/**
 * Doltgres 1.4 has no row locks (SELECT ... FOR UPDATE). It rejects the second of
 * two conflicting transactions at commit instead, with a misleading message
 * ("table not found"), so those are safe to retry from the top.
 */
export function isWriteConflict(e: unknown): boolean {
  const err = e as { code?: string; message?: string; cause?: { code?: string; message?: string } }
  const codes = [err?.code, err?.cause?.code]
  const text = `${err?.message ?? ''} ${err?.cause?.message ?? ''}`
  return codes.includes('40001') || /table not found|conflict|serializ/i.test(text)
}

/** Record everything written since the last commit as one Dolt commit. */
export async function commitVersion(db: Db, message: string, author: string) {
  try {
    await db.execute(sql`select dolt_commit('-A', '-m', ${message}, '--author', ${`${author} <desk@otakusolutions.io>`})`)
  } catch (e) {
    if (!/nothing to commit/i.test(String((e as Error)?.message) + String((e as any)?.cause?.message))) throw e
  }
}

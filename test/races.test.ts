import { describe, expect, it } from 'vitest'
import { requests } from '../src/db/schema'
import { OWNER } from '../src/domain/principal'
import { createRequest, queueRequest, startRequest } from '../src/domain/requests'
import { scoped, secondConnection, seedClient, testDb } from './helpers'

// Two callers at once only happen against a real server (TEST_DATABASE_URL);
// PGlite has a single connection.
describe.skipIf(!process.env.TEST_DATABASE_URL)('two callers at once', () => {
  it('two starts never push a client past the active limit', async () => {
    const db = await testDb()
    const other = secondConnection(db)
    await seedClient(db, { activeLimit: 1 })
    for (const title of ['One', 'Two']) {
      const r = await createRequest(db, OWNER, { client: 'GMA', title, ...scoped })
      await queueRequest(db, OWNER, r.id)
    }
    await Promise.allSettled([startRequest(db, OWNER, 'GMA-001'), startRequest(other, OWNER, 'GMA-002')])
    const rows = await db.select().from(requests)
    expect(rows.filter((r) => r.status === 'active')).toHaveLength(1)
  })

  it('two new requests never get the same id', async () => {
    const db = await testDb()
    const other = secondConnection(db)
    await seedClient(db)
    const results = await Promise.allSettled([
      createRequest(db, OWNER, { client: 'GMA', title: 'A' }),
      createRequest(other, OWNER, { client: 'GMA', title: 'B' }),
    ])
    const rows = await db.select().from(requests)
    const numbers = rows.map((r) => r.number)
    expect(new Set(numbers).size).toBe(numbers.length)
    expect(rows.length).toBe(results.filter((r) => r.status === 'fulfilled').length)
  })
})

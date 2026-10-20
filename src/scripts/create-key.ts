// npm run key:create -- admin "claude-desktop"
// npm run key:create -- client GMA "gma-telegram"
// Prints the key once. Store it in Infisical; only its hash is kept.
import { getDb } from '../db/client'
import { createApiKey } from '../domain/keys'

const [scope, a, b] = process.argv.slice(2)
const db = getDb()
const created =
  scope === 'admin'
    ? await createApiKey(db, { scope: 'admin', label: a ?? 'admin' })
    : scope === 'client' && a
      ? await createApiKey(db, { scope: 'client', client: a, label: b ?? `${a.toLowerCase()}-agent` })
      : null
if (!created) {
  console.error('Usage: key:create admin <label> | key:create client <CLIENT_CODE> <label>')
  process.exit(1)
}
console.log(`${created.scope} key "${created.label}":\n${created.key}`)
process.exit(0)

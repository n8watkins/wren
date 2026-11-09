// Prints the newest sign-in link from the local outbox (EMAIL_TRANSPORT=outbox
// in .dev.vars), for signing in to `npm run preview` without real email.
// Usage: npm run magic-link [-- you@example.com]
import { DatabaseSync } from 'node:sqlite'
import { localD1File } from './local-d1.mjs'

const file = localD1File('.wrangler/state')
if (!file) {
  console.error('No local database yet: run `npm run preview` and ask for a sign-in link first.')
  process.exit(1)
}
const db = new DatabaseSync(file, { readOnly: true })
const email = process.argv[2]
const row = email
  ? db.prepare('SELECT email, url FROM test_outbox WHERE email = ? ORDER BY id DESC LIMIT 1').get(email)
  : db.prepare('SELECT email, url FROM test_outbox ORDER BY id DESC LIMIT 1').get()
if (!row) {
  console.error('No sign-in link in the outbox yet.')
  process.exit(1)
}
console.log(`${row.email}\n${row.url}`)

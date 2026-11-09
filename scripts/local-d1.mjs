// Finds the local D1 database file wrangler keeps for `wren` under a state
// directory, for reading the sign-in outbox without any route in the app.
import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

export function localD1File(stateDir) {
  const dir = join(stateDir, 'v3', 'd1', 'miniflare-D1DatabaseObject')
  if (!existsSync(dir)) return null
  const file = readdirSync(dir).find((name) => name.endsWith('.sqlite') && name !== 'metadata.sqlite')
  return file ? join(dir, file) : null
}

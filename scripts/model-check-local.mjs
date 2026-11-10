// Runs the daily model check once, for real, from this machine: the Worker
// (built by `npm run build:worker`) under wrangler dev on 127.0.0.1:3123 with
// its own local state, real Gemini and Tavily, then prints what /api/health
// reports and stops. The keys come from the environment, never a file:
//
//   pass-env run -e GEMINI_API_KEY=wren/GEMINI_API_KEY -e TAVILY_API_KEY=wren/TAVILY_API_KEY -- npm run model-check:local
//
// wrangler dev reads them from the process env as hidden secrets because the
// config below names them (empty) and keeps a "secrets" block; they are never
// put on a command line or printed.
import { execFileSync, spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'

const port = process.env.MODEL_CHECK_PORT ?? '3123'
const base = `http://127.0.0.1:${port}`
const dir = '.wrangler/model-check-local'

if (!process.env.GEMINI_API_KEY) {
  console.error('GEMINI_API_KEY is not set: run this through pass-env (see the top of this file).')
  process.exit(1)
}

const config = JSON.parse(
  readFileSync('wrangler.jsonc', 'utf8')
    .split('\n')
    .filter((line) => !line.trim().startsWith('//'))
    .join('\n')
)
config.main = '../../worker/index.ts'
config.assets.directory = '../../.open-next/assets'
config.d1_databases[0].migrations_dir = '../../migrations'
// The custom domain would make wrangler dev rewrite every request to it; Vectorize has no local mode.
delete config.routes
delete config.vectorize
config.vars = {
  ...config.vars,
  APP_ENV: 'development',
  PUBLIC_URL: base,
  EMAIL_TRANSPORT: 'outbox',
  MEMORY_VECTORS: 'local',
  // Filled from the process env by wrangler dev, as hidden secrets.
  GEMINI_API_KEY: '',
  TAVILY_API_KEY: '',
  BETTER_AUTH_SECRET: randomBytes(24).toString('hex'),
}
config.secrets = { required: [] }
mkdirSync(dir, { recursive: true })
writeFileSync(`${dir}/wrangler.jsonc`, JSON.stringify(config, null, 2))
execFileSync('npx', ['wrangler', 'd1', 'migrations', 'apply', 'wren', '--local', '-c', `${dir}/wrangler.jsonc`, '--persist-to', `${dir}/state`], {
  stdio: 'ignore',
})

const server = spawn(
  'npx',
  ['wrangler', 'dev', '-c', `${dir}/wrangler.jsonc`, '--ip', '127.0.0.1', '--port', port, '--inspector-port', '9323', '--persist-to', `${dir}/state`, '--test-scheduled', '--log-level', 'warn'],
  { stdio: ['ignore', 'ignore', 'inherit'], detached: true }
)
const stop = () => {
  try {
    process.kill(-server.pid, 'SIGTERM')
  } catch {
    // Already gone.
  }
}

try {
  for (let i = 0; ; i++) {
    if (i > 120) throw new Error(`the Worker did not start on ${base}`)
    if (await fetch(`${base}/api/health`).then(() => true, () => false)) break
    await new Promise((resolve) => setTimeout(resolve, 1000))
  }
  const started = Date.now()
  const scheduled = await fetch(`${base}/__scheduled?cron=0+14+*+*+*`)
  console.log(`scheduled handler: ${scheduled.status} in ${Date.now() - started} ms`)
  const health = await (await fetch(`${base}/api/health`)).json()
  console.log(JSON.stringify({ status: health.status, check: health.checks.models, models: health.models }, null, 2))
} finally {
  stop()
}

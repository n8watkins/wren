// Serves the production Worker build for the E2E tests (playwright.config.ts):
// its own wrangler config and local state under .wrangler/e2e, so it never
// touches `npm run preview`'s data or .dev.vars. Test settings: sign-in links
// go to the local outbox, Gemini is the mock in tests/mocks/gemini.mjs, Tavily
// the one in tests/mocks/tavily.mjs, and
// Turnstile uses Cloudflare's test keys with siteverify mocked, the site-wide
// guest cap is low, and the burst limits are raised so parallel tests from one
// IP aren't throttled
// (the limits themselves are Cloudflare's; the daily meter is tested as is).
// E2E_SKIP_BUILD=1 reuses the last build; E2E_INSPECTOR_PORT picks wrangler's
// inspector port, so test servers running side by side don't fight over 9229.
import { execFileSync, spawn } from 'node:child_process'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'

const host = process.env.E2E_HOST ?? '127.0.0.2'
const port = process.env.E2E_PORT ?? '3121'
const mockPort = process.env.MOCK_GEMINI_PORT ?? '3127'
const tavilyPort = process.env.MOCK_TAVILY_PORT ?? '3128'
const dir = '.wrangler/e2e'
const state = `${dir}/state`

const config = JSON.parse(
  readFileSync('wrangler.jsonc', 'utf8')
    .split('\n')
    .filter((line) => !line.trim().startsWith('//'))
    .join('\n')
)
config.main = '../../worker/index.ts'
config.assets.directory = '../../.open-next/assets'
config.d1_databases[0].migrations_dir = '../../migrations'
for (const limiter of config.ratelimits) limiter.simple.limit = 10_000
// The custom domain would make wrangler dev rewrite every request to it.
delete config.routes
// Vectorize has no local mode: memory keeps its vectors in the agent's SQLite.
delete config.vectorize
config.vars = {
  ...config.vars,
  APP_ENV: 'test',
  PUBLIC_URL: `http://${host}:${port}`,
  EMAIL_TRANSPORT: 'outbox',
  GEMINI_BASE_URL: `http://${host}:${mockPort}`,
  GEMINI_API_KEY: 'test-demo-key',
  MEMORY_VECTORS: 'local',
  // Research searches go to the Tavily mock (tests/mocks/tavily.mjs).
  TAVILY_API_KEY: 'test-tavily-key',
  TAVILY_BASE_URL: `http://${host}:${tavilyPort}`,
  BETTER_AUTH_SECRET: 'e2e-only-secret-not-used-anywhere-else-0123456789',
  // Cloudflare's always-pass Turnstile test keys; siteverify is the mock.
  TURNSTILE_SITE_KEY: '1x00000000000000000000AA',
  TURNSTILE_SECRET_KEY: '1x0000000000000000000000000000000AA',
  TURNSTILE_VERIFY_URL: `http://${host}:${mockPort}/siteverify`,
  // Low enough for tests/e2e/guest-cap.spec.ts to reach after the other tests.
  GUEST_SITE_DAILY_CAP: '120',
}
delete config.secrets
mkdirSync(dir, { recursive: true })
writeFileSync(`${dir}/wrangler.jsonc`, JSON.stringify(config, null, 2))
rmSync(state, { recursive: true, force: true })

const run = (cmd, args) => execFileSync(cmd, args, { stdio: 'inherit' })
if (!process.env.E2E_SKIP_BUILD) run('npx', ['opennextjs-cloudflare', 'build'])
run('npx', ['wrangler', 'd1', 'migrations', 'apply', 'wren', '--local', '-c', `${dir}/wrangler.jsonc`, '--persist-to', state])

const inspector = process.env.E2E_INSPECTOR_PORT ? ['--inspector-port', process.env.E2E_INSPECTOR_PORT] : []
const server = spawn(
  'npx',
  ['wrangler', 'dev', '-c', `${dir}/wrangler.jsonc`, '--ip', host, '--port', port, '--persist-to', state, '--log-level', 'warn', ...inspector],
  { stdio: 'inherit' }
)
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => server.kill(signal))
server.on('exit', (code) => process.exit(code ?? 0))

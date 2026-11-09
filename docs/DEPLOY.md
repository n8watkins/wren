# Deploying

Wren is one Cloudflare Worker named `wren` (`wrangler.jsonc`): the Next.js app built by OpenNext plus the `WrenAgent` and `DailyCounter` Durable Objects.

## Resources

- D1 database `wren` (accounts, sessions), migrations in `migrations/`.
- Durable Objects: created by the `v1` migration in `wrangler.jsonc` on the first deploy.
- Rate limiting namespaces 3101 to 3103.
- `send_email` binding, sending from `wren@n8builds.dev`.

## Secrets

Set with `npx wrangler secret put NAME` (never on the command line):

| Secret | Needed for | Without it |
|---|---|---|
| `BETTER_AUTH_SECRET` | signing session cookies | the Worker can't start sessions (required) |
| `GEMINI_API_KEY` | the shared demo key | chat works only with a visitor's own key; `/api/health` says so |
| `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET` | GitHub sign-in | the GitHub button is disabled and says it isn't set up |

The GitHub OAuth app's callback URL is `<PUBLIC_URL>/api/auth/callback/github`.

## Deploy

```bash
npm run db:migrate   # D1 migrations, remote
npm run deploy       # OpenNext build, then wrangler deploy
curl -s https://wren.nathancwatkins23.workers.dev/api/health
```

`PUBLIC_URL` in `wrangler.jsonc` must be the address people use: sign-in callbacks and email links are built from it.

## Local

- `npm run preview`: the production build on `http://localhost:3120` with local D1 and Durable Objects (copy `.dev.vars.example` to `.dev.vars` first).
  Sign-in links stay in a local outbox: `npm run magic-link` prints the newest.
- `npm run dev`: `next dev` for UI work; chat needs the Workers runtime, so use `preview` for it.
- `npm run test:e2e`: builds, then serves an isolated test Worker on 3121 with a mock Gemini on 3127.

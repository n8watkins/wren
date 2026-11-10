# Deploying

Wren is one Cloudflare Worker named `wren` (`wrangler.jsonc`): the Next.js app built by OpenNext plus the `WrenAgent`, `DailyCounter` and `ModelCheck` Durable Objects, and a daily Cron Trigger.

## Resources

- D1 database `wren` (accounts, sessions), migrations in `migrations/`.
- Durable Objects: created by the migrations in `wrangler.jsonc` on deploy (`v1`: `WrenAgent`, `DailyCounter`; `v2`: `ModelCheck`).
- Cron Trigger `0 14 * * *`: the daily model check (`agent/model-check.ts`), deployed with the Worker.
  It needs a free cron slot on the account: 12 of 250 were in use on 2026-11-10 (12 is more than the Free plan allows, so the account is on Workers Paid), so Wren's makes 13.
- Rate limiting namespaces 3101 to 3103.
- `send_email` binding, sending from `wren@n8builds.dev`.

## Secrets

Set with `npx wrangler secret put NAME` (never on the command line):

| Secret | Needed for | Without it |
|---|---|---|
| `BETTER_AUTH_SECRET` | signing session cookies | the Worker can't start sessions (required) |
| `GEMINI_API_KEY` | the shared demo key (chat, voice, research, memory) | chat and voice work only with a visitor's own key; `/api/health` says so |
| `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET` | GitHub sign-in | the GitHub button is disabled and says it isn't set up |
| `TAVILY_API_KEY` | research search (and its daily check) | research searches with Gemini's Google Search; the daily check skips Tavily |

The GitHub OAuth app's callback URL is `<PUBLIC_URL>/api/auth/callback/github`.

## Deploy

```bash
npm run db:migrate   # D1 migrations, remote
npm run deploy       # OpenNext build, then wrangler deploy
curl -s https://wren.n8builds.dev/api/health
```

`PUBLIC_URL` in `wrangler.jsonc` must be the address people use (`https://wren.n8builds.dev`): sign-in callbacks, trusted origins and email links are built from it.
`wren.n8builds.dev` is a Workers custom domain (`routes` in `wrangler.jsonc`); `wrangler deploy` creates its DNS record and certificate.
The `workers.dev` address forwards to it.

## The daily model check

Once a day at 14:00 UTC the Worker calls each model and search service once (`agent/model-check.ts`) and saves the result; `/api/health` reports it under `checks.models` and `models`, without calling anything itself.
Right after the first deploy `checks.models` says the check hasn't run yet (`ok: null`, status unchanged); it turns not ok if no run lands within 26 h.
Production has no route that runs it, by design; `wrangler deploy` sets the cron from `wrangler.jsonc`.
To run it once for real from your machine, against the real models and Tavily, after `npm run build:worker`:

```bash
pass-env run -e GEMINI_API_KEY=wren/GEMINI_API_KEY -e TAVILY_API_KEY=wren/TAVILY_API_KEY -- npm run model-check:local
```

It serves the Worker on 127.0.0.1:3123 with its own local state (`scripts/model-check-local.mjs`), calls the scheduled handler, prints what `/api/health` then reports, and stops; the keys stay in the environment as hidden secrets.
`npm run preview` also passes `--test-scheduled`, so `curl "http://localhost:3120/__scheduled?cron=0+14+*+*+*"` runs it there, with whatever keys preview has.

The first deploy needs the required secret up front, because a Worker that doesn't exist yet can't take `wrangler secret put`: write `BETTER_AUTH_SECRET=<random>` to a file outside the repo, run `npx wrangler deploy --secrets-file <file>` after `npm run build:worker`, then delete the file.

If the `workers.dev` address answers `error code: 1042` after a deploy (it did once on 2026-11-09, after an upload hit a Cloudflare 504), the route isn't attached at the edge although the API says it is enabled: set `"workers_dev": false`, run `npx wrangler triggers deploy`, set it back to `true` and run it again.

## Local

- `npm run preview`: the production build on `http://localhost:3120` with local D1 and Durable Objects (copy `.dev.vars.example` to `.dev.vars` first).
  It sets Cloudflare's always-pass Turnstile test keys for guest chat (the real site key only works on wren.n8builds.dev); optional secrets go in with `--var`, because `wrangler dev` loads only the `secrets.required` ones from `.dev.vars`.
  It passes `--local-upstream localhost:3120 --upstream-protocol http`, because with a custom domain in `routes` wrangler dev would otherwise present every request as `https://wren.n8builds.dev`, and sign-in would reject the origin.
  Sign-in links stay in a local outbox: `npm run magic-link` prints the newest.
- `npm run dev`: `next dev` for UI work; chat needs the Workers runtime, so use `preview` for it.
- `npm run test:e2e`: builds, then serves an isolated test Worker on 3121 with a mock Gemini on 3127.

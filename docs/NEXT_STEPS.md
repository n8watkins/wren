# Next steps

## Owner

1. **Gemini demo key**: create a key in Google AI Studio for the demo (a dedicated project with a spending cap), then `npx wrangler secret put GEMINI_API_KEY`.
   Until then, chat on the live site works with a visitor's own key.
2. **GitHub OAuth app**: on github.com, Settings, Developer settings, OAuth Apps, New.
   Homepage `https://wren.n8builds.dev`, callback `https://wren.n8builds.dev/api/auth/callback/github`.
   Then `npx wrangler secret put GITHUB_CLIENT_ID` and `GITHUB_CLIENT_SECRET`.
   Make a second app for local runs (callback `http://localhost:3120/api/auth/callback/github`) if you want GitHub sign-in there.
3. **Review**, then say go for phase 2 (voice).

Settled: sign-in emails come from `wren@n8builds.dev`, and Wren lives at `wren.n8builds.dev` (2026-11-09).

## Agents

- Phase 2, voice: Gemini Live through the person's agent (WebSocket relay), metered by the minute; chat moves onto the agent's WebSocket with resumable streams.
- Phase 3, research: the plan, search, read and cite loop with hardened fetching and untrusted-content handling.
- Phase 4, memory: notes, files and links in Vectorize, R2 and D1, quoted with links back.
- Launch: portfolio card, build page on n8builds.dev, OpenPing watching `/api/health`.

## Done

- 2026-11-09: release-kit and CI checks (#1); phase 1, foundation and chat (#4).
- 2026-11-09: preview deployed to https://wren.nathancwatkins23.workers.dev (D1 `wren` migrated, Durable Objects created, `BETTER_AUTH_SECRET` set). Email sign-in works there; chat needs a visitor's own key until the demo key is set.

# Next steps

## Owner

1. **Gemini demo key**: create a key in Google AI Studio for the demo (a dedicated project with a spending cap), then `npx wrangler secret put GEMINI_API_KEY`.
   Until then, chat on the live site works with a visitor's own key.
2. **GitHub OAuth app**: on github.com, Settings, Developer settings, OAuth Apps, New.
   Homepage `https://wren.n8builds.dev`, callback `https://wren.n8builds.dev/api/auth/callback/github`.
   Then `npx wrangler secret put GITHUB_CLIENT_ID` and `GITHUB_CLIENT_SECRET`.
   Make a second app for local runs (callback `http://localhost:3120/api/auth/callback/github`) if you want GitHub sign-in there.
3. **Review**, then say go for phase 2 (memory).
4. **Tavily key** for research, before its live check: `pass-env set wren/TAVILY_API_KEY` in your own terminal, then `pass-env pipe wren/TAVILY_API_KEY -- npx wrangler secret put TAVILY_API_KEY`.
   Until then research searches with Gemini's Google Search, which needs the Gemini demo key.

Settled: sign-in emails come from `wren@n8builds.dev`, and Wren lives at `wren.n8builds.dev` (2026-11-09).

## Agents

- Phase 3, research in chat (next): a "Research this" action in the composer, the run as a progress card in the chat, the report landing in the chat, and "Save findings to Memory". The engine and the Runs page are done.
- Typed chat onto the agent's WebSocket, with resumable streams (split out of phase 4 on 2026-11-10; voice already has its own socket).
- Voice, once live: check a real session on wren.n8builds.dev (the mic needs https), and watch Gemini Live's per-minute cost against the 10-minute allowance.
- Launch: portfolio card, build page on n8builds.dev, OpenPing watching `/api/health` with a JSON assertion that `status` is `"ok"` (a failed daily model check is `degraded` with HTTP 200, not a 503).
- After the daily model check's first deploy: the next day, check that `/api/health` shows `models` with a `ranAt` from 14:00 UTC.
- What the first real runs of the daily model check found (2026-11-10, local, on the demo key), to fix or decide on before it pages every day:
  Google Search grounding answers 429 (`demo_busy`) on both `gemini-3.5-flash-lite` and `gemini-3.1-flash-lite`, every time, while plain calls to the same models work, so research's search backup is likely broken on the demo key (a grounding quota of zero on its tier); check the key's quota in AI Studio, or decide the grounding probe should go.
  The lite models are slow and flaky: a one-word reply took 2 to 9 s from `gemini-3.5-flash-lite` (one 503 after 15 s) and 1 to 20 s from `gemini-3.1-flash-lite` (one 20 s timeout, one 503 on both tries), against chat's 20 s first-text window.
  `gemini-embedding-2` (768 values), `gemini-3.8-live` (setup in under 0.6 s) and Tavily answered every time.

## Done

- 2026-11-10: daily real-model check (lane E): a Cron Trigger calls each model and search service once a day and `/api/health` reports the result, so OpenPing alerts when a model stops answering without spending model calls.
- 2026-11-10: memory in chat (phase 2): Wren's facts with every message and recall by meaning, "From your Memory" chips, "Saved to Memory" with Undo, "Save to Memory" on messages, and meaning thresholds tuned on real gemini-embedding-2 searches.
- 2026-11-10: voice (phase 4, lane A): Gemini Live (`gemini-3.8-live`) relayed by each person's agent over its own WebSocket, barge-in, transcripts saved in the chat, 10 minutes a day metered in seconds, your own key with no limit.
- 2026-11-09: research engine and the Runs page (phase 3, lane B): runs in each person's agent, Tavily with Gemini Google Search as backup, safe fetching, cited reports.
- 2026-11-09: release-kit and CI checks (#1); phase 1, foundation and chat (#4).
- 2026-11-09: memory engine and the Memory page (lane A of phases 2 and 3): storage in each person's agent, search by meaning (Vectorize index and R2 bucket `wren-memory` created), files, the fact extractor (not yet called from chat), and the page.
- 2026-11-09: preview deployed to https://wren.nathancwatkins23.workers.dev (D1 `wren` migrated, Durable Objects created, `BETTER_AUTH_SECRET` set). Email sign-in works there; chat needs a visitor's own key until the demo key is set.

## Keys

Checked 2026-11-09 against the secret names on the Worker and in GitHub Actions (names only, no values).
New values go into the owner's pass-env store and are sent with `pass-env pipe <entry> -- <command>`; never commit or paste a value.

- [ ] `GEMINI_API_KEY` (missing): guests cannot chat until it is a Worker secret. Make a Wren-only key in Google AI Studio, then `pass-env pipe wren/GEMINI_API_KEY -- npx wrangler secret put GEMINI_API_KEY`.
- [ ] `TAVILY_API_KEY` (missing, optional): research searches with Gemini's Google Search until it is set; see Owner step 4.
- [x] `BETTER_AUTH_SECRET`, `TURNSTILE_SECRET_KEY`: set on the Worker.

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

- Phase 2, memory in chat: recall the most relevant memories before answering, with "From your Memory" chips; call `rememberFromChat` after an answer and show "Saved to Memory · Undo"; a "Save to Memory" button on messages.
  Tune `MEANING_MIN_SCORE` and `DUPLICATE_SCORE` in `agent/memory.ts` against real gemini-embedding-2 searches (they were set without a live run).
- Phase 3, research in chat: a "Research this" action in the composer, the run as a progress card in the chat, the report landing in the chat, and "Save findings to Memory". The engine and the Runs page are done.
- Phase 4, voice: Gemini Live through the person's agent (WebSocket relay), metered by the minute; chat moves onto the agent's WebSocket with resumable streams.
- Launch: portfolio card, build page on n8builds.dev, OpenPing watching `/api/health`.

## Done

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

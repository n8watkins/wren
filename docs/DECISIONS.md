# Decisions

The owner's standing decisions and the technical choices made with them.
Read this before changing product, design or workflow, and add every new decision here, with its date, in the same change.

## Product

- **Wren is a new product** (owner, 2026-11-08 and 2026-11-09).
  It is a portfolio demo that shows a ChatGPT-like assistant done well: one chat where typing and talking are always both available, Research as an action from chat, and Memory as a library that Wren adds to on its own and you add to with a button, browse and edit.
  Public copy presents it as its own product; it is never described as a merge of earlier projects.
- **Name and mark**: Wren, with a small animated wren as the icon (owner, 2026-11-09).
  The mark moves only to say what Wren is doing: idle, thinking, listening, talking (`components/WrenMark.tsx`).
- **Look**: warm paper and ink, with ember for voice and primary actions, saffron for research and sage for memory, from the approved mockups (owner, "go for it", 2026-11-09).
  Fonts: Bricolage Grotesque (display), Inter (interface), Newsreader (long reading), JetBrains Mono (labels and numbers), self-hosted through `next/font`.
- **No landing page**: the app is the first screen, with a "How Wren works" modal on the first visit that "?" reopens, and in-context tips.
- **Tips are a short guided tour** (owner, 2026-11-09): a toolbar with Skip tour, Previous (←), a "2 of 4" counter and Next (→), which reads Done on the last step; X, Esc and Skip tour end the whole tour; the arrow keys move back and forward and Enter is Next; on phones the buttons are at least 44 px and the tip stays on screen. "Show me around" in the "?" dialog starts it again.
- **Phases** (owner, 2026-11-09; reordered from voice, research, memory): 1 foundation and chat (done), 2 memory, 3 research, 4 voice, then launch.
  Memory and research cores are built in parallel lanes; each is wired into chat one at a time, memory first.
  Voice goes last and alone because it moves chat onto the agent's WebSocket, the code both other phases plug into.
- **Research searches with Tavily, with Gemini's Google Search as the backup** (owner, 2026-11-09).
  Tavily returns results and page text, so a run can show what it searched, read and cited; the backup covers Tavily being down or out of credits.
  Wren has its own key (`TAVILY_API_KEY`), never one shared with another project.
- **Memory saves both ways** (owner, 2026-11-09): Wren saves short, lasting facts from a conversation on its own (preferences, projects, recurring topics), and a "Save to Memory" button saves anything you choose.
  Every save Wren makes on its own shows a "Saved to Memory · Undo" line in the chat, so nothing is saved silently, and the Memory library lists, edits and deletes everything.
  Guests get no memory, as nothing of theirs is saved past the tab.
  Controls for later phases are visible now and say "coming in the next update"; none of them pretend to work.

## Sign-in

- **GitHub and email magic link only** (owner, 2026-11-08), in a sign-in modal rather than a login page (owner preference).
- **Library: Better Auth** (2026-11-09).
  It is actively maintained, runs on Workers, and its Kysely adapter talks to the D1 binding directly (no ORM or extra driver), with GitHub and a magic-link plugin built in.
  Sessions are rows in D1 behind a signed cookie and are checked on the server for every API call.
  Alternatives considered: Auth.js (its D1 adapter and Workers story are weaker and its magic link needs a separate email provider adapter), Lucia (deprecated as a library in 2025), a hand-rolled OAuth and token flow (more code to get wrong for no gain).
  Better Auth's in-memory rate limiter is off, because Workers don't share memory; the auth route applies durable limits instead.
- **Two tiers: guest and signed in** (owner, 2026-11-09; replaces the earlier "guests must sign in").
  A guest (no account) gets typed chat only, 5 messages a day, and nothing is saved past the tab: the chat lives in the tab's sessionStorage and comes with each message, size-capped, and the server stores only the counts.
  Signed in: 50 messages, 10 voice minutes and 3 research runs a day, with chats saved.
  The UI says what signing in unlocks: "Sign in for 10x more messages, voice, research and memory".
  Protection: a Cloudflare Turnstile check (managed, interaction-only) before a guest's first message; a signed, HttpOnly guest cookie (HMAC over a random id and its expiry); limits keyed on the cookie and on CF-Connecting-IP (15 guest messages per network a day, so many cookies can't multiply it); and a site-wide cap of 500 guest messages a day (`GUEST_SITE_DAILY_CAP`) in a Durable Object counter, past which guests are told "Guest messages are used up for today; sign in to keep going".
  Turnstile tokens are checked server-side in Wren's own Worker (siteverify), so no separate verify Worker is needed.
  The widget "Wren guest chat" (managed, wren.n8builds.dev) was created through the API; its secret is a Worker secret and was never written to disk.
- **Sign-in emails** go through Cloudflare Email Service from `wren@n8builds.dev` (owner confirmed, 2026-11-09), the domain already onboarded for sending (no API key).
  Links expire after 10 minutes, work once, and are stored hashed.

## Architecture

- **Address: `wren.n8builds.dev`** (owner, 2026-11-09), a Workers custom domain on the n8builds.dev zone.
  It is `PUBLIC_URL`, so Better Auth's base URL, trusted origin and email links use it.
  The `workers.dev` address stays on and forwards there with a 308, keeping the path (`lib/security/canonical.ts`).

- **Next.js 16 App Router on Cloudflare Workers through OpenNext**, the stack of the owner's other sites, Turbopack everywhere.
- **One Durable Object agent per signed-in person** (Cloudflare Agents SDK, `agent/wren-agent.ts`), named by the verified user id.
  It holds that person's chats and daily meter in its own SQLite database, so one person's data can't be reached through another's id.
  The Next.js API routes call it over Durable Object RPC after checking the session.
- **One Worker** holds both the app and the Durable Objects (`worker/index.ts`), because Durable Object RPC from `next dev` would need a second Worker in a separate process.
  `npm run preview` runs the real thing locally; `npm run dev` is for UI work and has no chat.
- **Streaming**: the chat answer streams as newline-delimited JSON from the agent through the route to the browser.
  Closing the tab or pressing Stop ends the answer and keeps what was written.
  Resumable streams arrive with voice, which moves chat onto the agent's WebSocket.
- **Gemini** through `@google/genai`: `gemini-3.5-flash-lite`, with `gemini-3.1-flash-lite` as the backup (owner, 2026-11-09), set in `wrangler.jsonc` (`GEMINI_MODEL`, `GEMINI_FALLBACK_MODEL`).
  The backup is tried once when the first model fails or sends no text within 20 s; a rejected key is never retried, and an answer that already started is never restarted (`agent/gemini.ts`).
  It replaced `gemini-3.8-flash`, which stopped answering on the live site (no response within 40 s) while both lite models answered in about a second.
- **The demo budget**: 50 messages, 10 voice minutes and 3 research runs per person per day, reset at midnight UTC (owner placeholders, 2026-11-09), counted in the person's agent, plus 150 messages per IP per day (`lib/limits.ts`).
  Burst limits per user and per IP use Workers rate limiting.
- **Bring your own key**: kept only in the browser and sent per request in a header; never stored or logged.
  A personal key that Gemini rejects is an error the person sees; Wren never switches to the demo key.
- **Memory lives in each person's own agent, not D1** (2026-11-09, from the approved memory and research plan).
  The `memories` table sits in the person's Durable Object SQLite beside their chats (`agent/memory-store.ts`), so one person's request can never read another's memory, the same way chats work.
  Search by meaning uses `gemini-embedding-2` at 768 dimensions (Vectorize takes at most 1536; 768 is one of Google's recommended sizes) in the `wren-memory` Vectorize index, with the agent's id as the namespace on every write and query; files go to the `wren-memory` R2 bucket under the same id (`agent/memory.ts`).
  Vectorize has no local mode, so local and test runs set `MEMORY_VECTORS=local` and keep vectors in the agent's SQLite; `/api/health` fails if production ever has it.
  Caps: 500 memories and 25 MB of files per person (5 MB a file; text, Markdown and PDF, a PDF read by Gemini rather than a PDF library), enforced in the agent and shown on the Memory page (`lib/memory.ts`).
  Memory's Gemini calls (embeddings, reading a PDF, picking facts) use the person's own key when they have one, otherwise 200 calls a day on the demo key; saving never waits on Gemini: a memory that can't be embedded yet is found by its words and embedded on a later save.
  The extractor reads only the person's own recent messages, saves at most 3 lasting facts, and updates a near-duplicate (cosine 0.9 or more) instead of adding one; chat wiring calls it in the next step.
- **Research runs** (2026-11-09, phase 3 engine and the Runs page; starting a run from chat comes next).
  A run lives in the person's own agent (`agent/research.ts`, tables in `agent/research-store.ts`): plan 3 to 5 searches with the chat model, search each one, read up to 8 pages (at most 2 per site, 12 tries), then write a Markdown report where every `[n]` is a page the run read.
  It is a small state machine saved in SQLite, and each step is its own scheduled callback (the Agents SDK's `schedule`) doing one bounded piece of work: one model call, one search or one page.
  The SDK keeps a callback until it finishes, so a restart in the middle of a step runs that step again from the saved state, and a step writes only if the run is still where it found it, so nothing is saved twice; a run that stops moving for 90 s gets its next step scheduled again when it is looked at, and one still going after 10 minutes is stopped.
  Pages to read are picked by search rank, never by a model.
  The Runs page watches a run through one NDJSON stream (`GET /api/runs/:id/stream`) rather than polling, because polling every second or two would use up the per-person burst limit (12 requests a minute); the stream sends the whole run after every step and reconnects if it drops.
  Budget: one run at a time and the existing 3 a day, signed in only, never counted against messages; a run that ends without a report is given back, a cancelled one is not (its searches were already paid for).
  Research always uses the demo Gemini key: a person's own key lives only in their browser, and a run carries on after the tab closes.
- **Search: Tavily, then Gemini's Google Search** (`agent/web-search.ts`).
  Tavily is asked for each result's page text, which the run uses instead of fetching when there is enough of it; the backup takes over when there is no `TAVILY_API_KEY` (optional, read through `lib/secrets.ts`), Tavily is out of credits (432, 433, 429), rejects the key, or fails.
  Which one served each search is logged (`provider`) and shown in the run.
- **Safe fetching** (`lib/web/fetch-page.ts`, reusable by Memory for links): http and https only, on the usual ports, with no user:password; never localhost, `.local`, `.internal` and similar names, single-label names, or private, loopback, link-local, shared, test, multicast or reserved IPv4 and IPv6 addresses (IPv4 in any notation, and IPv4 inside IPv6); at most 4 redirects, each one checked again; 10 s for the whole fetch; 2 MB, counted as the body arrives; HTML, plain text and PDF only.
  HTML is reduced to readable text with scripts, styles, forms and page furniture removed; a PDF is turned into text by Gemini as data.
  A hostname that resolves to a private address can't be checked before the fetch in a Worker; Cloudflare's network doesn't route Worker fetches to private addresses, which covers it in production.
- **Page text is untrusted data** (`agent/research-text.ts`).
  It reaches the model only between markers carrying a random id the page can't know, with anything marker-like in it defused, under instructions that it is data and never instructions.
  The plan is made from the question alone before any page is read, the report call has no tools, and the finished report keeps only citations of pages that were read and links to them: other links become plain text, bare addresses are code-quoted, reference definitions, images and HTML are removed.
- **Plain CSS with design tokens** (`app/globals.css`) rather than a component kit, to match the mockups exactly.
- **No incremental cache**: every page depends on who is signed in and carries a fresh CSP nonce, so OpenNext needs no R2 cache.

## Engineering

- Release-kit from the first commit: Conventional Commits, a weekly release train gated on CI and the commit check, pre-push guard.
- Every rule in `docs/LESSONS.md` has a lint rule or a test.
- The repo is private while it is built; CI runs on GitHub-hosted runners.

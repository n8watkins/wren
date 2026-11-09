# Decisions

The owner's standing decisions and the technical choices made with them.
Read this before changing product, design or workflow, and add every new decision here, with its date, in the same change.

## Product

- **Wren is a new product** (owner, 2026-11-08 and 2026-11-09).
  It is a portfolio demo that shows a ChatGPT-like assistant done well: one chat where typing and talking are always both available, Research as an action from chat, and Memory as a library you add to and browse.
  Public copy presents it as its own product; it is never described as a merge of earlier projects.
- **Name and mark**: Wren, with a small animated wren as the icon (owner, 2026-11-09).
  The mark moves only to say what Wren is doing: idle, thinking, listening, talking (`components/WrenMark.tsx`).
- **Look**: warm paper and ink, with ember for voice and primary actions, saffron for research and sage for memory, from the approved mockups (owner, "go for it", 2026-11-09).
  Fonts: Bricolage Grotesque (display), Inter (interface), Newsreader (long reading), JetBrains Mono (labels and numbers), self-hosted through `next/font`.
- **No landing page**: the app is the first screen, with a "How Wren works" modal on the first visit that "?" reopens, and in-context tips.
- **Tips are a short guided tour** (owner, 2026-11-09): a toolbar with Skip tour, Previous (←), a "2 of 4" counter and Next (→), which reads Done on the last step; X, Esc and Skip tour end the whole tour; the arrow keys move back and forward and Enter is Next; on phones the buttons are at least 44 px and the tip stays on screen. "Show me around" in the "?" dialog starts it again.
- **Phases**: 1 foundation and chat (this), 2 voice, 3 research, 4 memory, then launch.
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
- **Sign-in emails** go through Cloudflare Email Service from `wren@n8builds.dev`, the domain already onboarded for sending (no API key).
  The owner may prefer another sender once Wren has its own domain.
  Links expire after 10 minutes, work once, and are stored hashed.

## Architecture

- **Next.js 16 App Router on Cloudflare Workers through OpenNext**, the stack of the owner's other sites, Turbopack everywhere.
- **One Durable Object agent per signed-in person** (Cloudflare Agents SDK, `agent/wren-agent.ts`), named by the verified user id.
  It holds that person's chats and daily meter in its own SQLite database, so one person's data can't be reached through another's id.
  The Next.js API routes call it over Durable Object RPC after checking the session.
- **One Worker** holds both the app and the Durable Objects (`worker/index.ts`), because Durable Object RPC from `next dev` would need a second Worker in a separate process.
  `npm run preview` runs the real thing locally; `npm run dev` is for UI work and has no chat.
- **Streaming**: the chat answer streams as newline-delimited JSON from the agent through the route to the browser.
  Closing the tab or pressing Stop ends the answer and keeps what was written.
  Resumable streams arrive with voice, which moves chat onto the agent's WebSocket.
- **Gemini** through `@google/genai`, model `gemini-3.8-flash` (Google's recommended default for everyday apps as of November 2026), set in `wrangler.jsonc`.
- **The demo budget**: 50 messages, 10 voice minutes and 3 research runs per person per day, reset at midnight UTC (owner placeholders, 2026-11-09), counted in the person's agent, plus 150 messages per IP per day (`lib/limits.ts`).
  Burst limits per user and per IP use Workers rate limiting.
- **Bring your own key**: kept only in the browser and sent per request in a header; never stored or logged.
  A personal key that Gemini rejects is an error the person sees; Wren never switches to the demo key.
- **Plain CSS with design tokens** (`app/globals.css`) rather than a component kit, to match the mockups exactly.
- **No incremental cache**: every page depends on who is signed in and carries a fresh CSP nonce, so OpenNext needs no R2 cache.

## Engineering

- Release-kit from the first commit: Conventional Commits, a weekly release train gated on CI and the commit check, pre-push guard.
- Every rule in `docs/LESSONS.md` has a lint rule or a test.
- The repo is private while it is built; CI runs on GitHub-hosted runners.

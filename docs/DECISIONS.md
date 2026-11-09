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
- **Phases**: 1 foundation and chat (this), 2 voice, 3 research, 4 memory, then launch.
  Controls for later phases are visible now and say "coming in the next update"; none of them pretend to work.

## Sign-in

- **GitHub and email magic link only** (owner, 2026-11-08), in a sign-in modal rather than a login page (owner preference).
- **Library: Better Auth** (2026-11-09).
  It is actively maintained, runs on Workers, and its Kysely adapter talks to the D1 binding directly (no ORM or extra driver), with GitHub and a magic-link plugin built in.
  Sessions are rows in D1 behind a signed cookie and are checked on the server for every API call.
  Alternatives considered: Auth.js (its D1 adapter and Workers story are weaker and its magic link needs a separate email provider adapter), Lucia (deprecated as a library in 2025), a hand-rolled OAuth and token flow (more code to get wrong for no gain).
  Better Auth's in-memory rate limiter is off, because Workers don't share memory; the auth route applies durable limits instead.
- **Guests can look around but must sign in to chat** (2026-11-09).
  A guest quota would need an anonymous identity, and the only one a visitor can't reset is the IP address, which many people share; that is not trivially safe, so the first message opens the sign-in modal.
  The mockups' "No account is needed to try it" line was changed to match.
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

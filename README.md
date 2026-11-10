# Wren

An AI assistant you can type or talk to, that researches the web for you and remembers what you save.
A portfolio project by Nathan Watkins, live at https://wren.n8builds.dev.

Phase 1 is live in this repo: the app shell, sign-in with GitHub or an email link, streaming chat with Gemini, a daily usage meter, and your own Gemini key.
The Memory library is in: save notes, links and files and find them by meaning.
Research runs work from the Runs page: Wren plans searches, reads the pages and writes a report that cites only what it read.
Voice is in: tap the mic and talk with Wren through Gemini Live, interrupt it by talking, and every spoken turn lands in the same chat as text.
Memory and research in chat come next.

## Stack

- Next.js 16 (App Router, Turbopack) on Cloudflare Workers through OpenNext.
- One Durable Object agent per person (Cloudflare Agents SDK) holding their chats, memory and usage meter.
- Vectorize (search by meaning, a namespace per person) and R2 (saved files) for Memory.
- Better Auth on D1 for accounts and sessions.
- Gemini through `@google/genai`; voice through Gemini Live (a WebSocket relayed by each person's agent); research searches with Tavily, with Gemini's Google Search as the backup.

## Run it

```bash
npm ci
cp .dev.vars.example .dev.vars   # then fill in BETTER_AUTH_SECRET
npm run preview                  # http://localhost:3120
npm run magic-link               # the sign-in link for the address you entered
```

Tests: `npm run test:unit` and `npm run test:e2e` (desktop and phone widths, against mocks of Gemini, Gemini Live and Tavily).

More: `docs/DECISIONS.md` (why things are the way they are), `docs/LESSONS.md` (the security rules and what enforces them), `docs/DEPLOY.md`, `docs/NEXT_STEPS.md`, `RELEASING.md`.

## License

MIT, see [LICENSE](LICENSE).

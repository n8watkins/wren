# Wren

An AI assistant you can type or talk to, that researches the web for you and remembers what you save.
A portfolio project by Nathan Watkins, live at https://wren.n8builds.dev.

Phase 1 is live in this repo: the app shell, sign-in with GitHub or an email link, streaming chat with Gemini, a daily usage meter, and your own Gemini key.
Voice, Research and Memory come next.

## Stack

- Next.js 16 (App Router, Turbopack) on Cloudflare Workers through OpenNext.
- One Durable Object agent per person (Cloudflare Agents SDK) holding their chats and usage meter.
- Better Auth on D1 for accounts and sessions.
- Gemini through `@google/genai`.

## Run it

```bash
npm ci
cp .dev.vars.example .dev.vars   # then fill in BETTER_AUTH_SECRET
npm run preview                  # http://localhost:3120
npm run magic-link               # the sign-in link for the address you entered
```

Tests: `npm run test:unit` and `npm run test:e2e` (desktop and phone widths, against a mock Gemini).

More: `docs/DECISIONS.md` (why things are the way they are), `docs/LESSONS.md` (the security rules and what enforces them), `docs/DEPLOY.md`, `docs/NEXT_STEPS.md`, `RELEASING.md`.

## License

MIT, see [LICENSE](LICENSE).

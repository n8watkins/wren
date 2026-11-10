<!-- BEGIN:nextjs-agent-rules -->

## This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

<!-- release-kit -->
## Commits and releases

- Write every commit message as a Conventional Commit: `type(scope): subject`, with type one of feat, fix, perf, security, refactor, docs, test, build, ci, chore, style, revert. A hook and a CI check reject anything else; see RELEASING.md.
- Use `feat` and `fix` only for changes a user would notice: they become the release notes and the public build log.
- Write those subjects as patch notes, for users: what they can now do or what works better, not the file, library or test you touched. When the subject must stay technical, add a `Release-note: <plain sentence>` line to the body, or `Release-note: skip` for a change no user would notice.
- Don't bump versions, edit CHANGELOG.md or create tags by hand: `npm run release` does all three.
- Land changes through pull requests: a pre-push hook blocks pushing straight to main or a release branch, force pushes and moving release tags. Don't get around it with `--no-verify` or `RELEASE_KIT_ALLOW_DIRECT_PUSH=1` (that is for emergencies the owner asks for, and a Direct push alarm reports it either way).
<!-- /release-kit -->

## Wren

Wren is a ChatGPT-style AI assistant, built as a portfolio demo: typed and spoken chat, research and memory.
Present it as its own product; never describe it publicly as a merge of earlier projects.

- **Decisions**: `docs/DECISIONS.md` holds the owner's standing decisions and the technical choices. Read it before changing product, design or workflow, and add every new decision there with its date.
- **Lessons**: `docs/LESSONS.md` lists the security rules and what enforces each. Never weaken a rule to make a change pass; add the check that proves the new code follows it.
- **Owner steps and what's next**: `docs/NEXT_STEPS.md`.

### How it fits together

- `app/(app)/layout.tsx` renders the whole client shell (`components/app/WrenApp.tsx`) for every page route; routes are `/`, `/chat/:id`, `/runs`, `/memory`.
- `app/api/*`: every person-scoped route is wrapped in `authed()` (`lib/server/route.ts`): verified session, then burst limits. Identity only ever comes from the session.
- `agent/wren-agent.ts`: one Durable Object per person (Agents SDK), named by the verified user id: chats, the daily meter, and the only caller of Gemini (`agent/gemini.ts`).
- `worker/index.ts`: the Worker entry; wraps OpenNext, sets the nonce CSP and security headers, takes the voice socket (`worker/voice.ts`, before OpenNext), exports the Durable Objects, and runs the daily model check from its `scheduled` handler (cron only, `agent/model-check.ts`; `/api/health` reports the result).
- Voice: `POST /api/voice/ticket` (authed) signs a short ticket, `GET /api/voice` opens the socket, and the person's agent relays it to Gemini Live (`agent/voice.ts`).
- `lib/limits.ts`: every limit and size cap. `lib/log.ts`: the only logger (counts and codes, never content).

### Running it

- `npm run preview` (port 3120) runs the real Worker with local D1 and Durable Objects; `npm run magic-link` prints the local sign-in link. `npm run dev` is UI only: Durable Objects need the Workers runtime.
- `npm run test:e2e` builds and serves an isolated test Worker on 127.0.0.2:3121 with a mock Gemini on 3127. It binds 127.0.0.2 because WSL's mirrored networking makes a closed port on 127.0.0.1 hang instead of refusing.
- Dev servers and tests run on Turbopack; never add `--webpack` or cap the heap.
- Ports 3120 to 3129 are Wren's; stop servers you start.
- After changing `wrangler.jsonc`, run `npm run cf-typegen`.

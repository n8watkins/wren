# Lessons

Wren replaces three earlier demo apps.
A security review of them in November 2026 found the mistakes below.
Each one has a rule here, and each rule has a check that fails CI if the mistake comes back.

| Mistake | Rule in Wren | Enforced by |
|---|---|---|
| Trusting a user id the browser sent | Identity comes only from the verified session, or for a guest from a signed HttpOnly cookie issued after a Turnstile check; agents are named by them | `authed()` on every person-scoped route (`tests/unit/lessons.test.ts`); lint rule against reading `userId` from a request; strict schemas reject a `userId` field; E2E: one person can't read, delete or post into another's chat (`tests/e2e/api.spec.ts`) |
| Public debug and admin routes | No debug, admin, log or test routes at all | Every route is listed with who may call it, and a name check (`tests/unit/lessons.test.ts`); E2E: every person-scoped route answers 401 without a session |
| Database filters built from strings | Parameterized queries only | Lint rules against template strings and concatenation in SQL calls, themselves tested (`tests/unit/lint-rules.test.ts`); unit tests store SQL-shaped text as data |
| Silent fallback to the demo key | A rejected personal key is an error the person sees | `chooseKey()` and error classification unit tests; E2E: a bad personal key ends in `user_key_invalid` and leaves the meter untouched |
| Limits keyed on client-controlled values | Limits key on the verified user id (or signed guest id) and CF-Connecting-IP, plus a site-wide guest cap | `clientIp()` unit tests with spoofed headers; lint rule against `X-Forwarded-For` and friends; E2E: a guest's 5, a network's 15 across several guest cookies, the site cap, forged and tampered guest cookies |
| Paid calls that skip the meter | Every Gemini call goes through the person's agent after the meter | Only `agent/gemini.ts` may import the SDK (lint rule and a source scan); E2E: messages count, upstream failures give the unit back |
| Counters in memory | Durable counters in Durable Object SQLite | `agent/meter.ts` unit tests on SQLite |
| The client choosing the system prompt | Prompts live on the server (`agent/persona.ts`); a guest's history may only hold user and model turns | Strict schemas reject `systemPrompt`, `model` and a `system` role (unit and E2E) |
| Unbounded request sizes | Size caps on every field and body | `readJson()` cuts off a body over 32 KB whatever Content-Length says; message, title, history and key caps in `lib/limits.ts`; unit and E2E tests |
| Fetching URLs unsafely, web pages steering the agent | Phase 3 (research) adds fetch hardening and untrusted-content handling | Tests land with that phase |
| Model output rendered as HTML | Markdown without raw HTML, sanitized, no images, safe links | `tests/unit/markdown.test.tsx` XSS strings; E2E renders a hostile answer and checks nothing ran; lint rule against `dangerouslySetInnerHTML` outside two reviewed static uses |
| Prompts, emails and ids in logs | Logs hold event names, counts and codes | `lib/log.ts` keeps a closed field list (unit test); `no-console` lint rule everywhere else |
| No security headers | Strict headers and a per-request nonce CSP on every response | Unit tests of the policy; E2E checks the headers on pages, APIs and 404s and that the nonce changes |
| Features that silently don't work | Each feature has an E2E test and a health check | `/api/health` reports database, Durable Objects, configuration, chat, both sign-in methods, and the features still to come |
| Dead code and stale dependencies | One implementation of each thing; dependencies kept current | `knip` in CI; Dependabot and the weekly OSV scan from release-kit |

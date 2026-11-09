# Next steps

## Owner

1. **Gemini demo key**: create a key in Google AI Studio for the demo (a dedicated project with a spending cap), then `npx wrangler secret put GEMINI_API_KEY`.
   Until then, chat on the preview works with a visitor's own key.
2. **GitHub OAuth app**: on github.com, Settings, Developer settings, OAuth Apps, New.
   Homepage `https://wren.nathancwatkins23.workers.dev`, callback `https://wren.nathancwatkins23.workers.dev/api/auth/callback/github`.
   Then `npx wrangler secret put GITHUB_CLIENT_ID` and `GITHUB_CLIENT_SECRET`.
   Make a second app for local runs (callback `http://localhost:3120/api/auth/callback/github`) if you want GitHub sign-in there.
3. **Email sender**: sign-in links go from `wren@n8builds.dev` through Cloudflare Email Service.
   Confirm that address is fine, or pick another once Wren has its own domain.
4. **Domain**: choose Wren's address (the mockups used `wren.n8builds.dev`); then add it as a custom domain in `wrangler.jsonc`, update `PUBLIC_URL` and the OAuth callback.
5. **Review phase 1**, then say go for phase 2 (voice).

## Agents

- Phase 2, voice: Gemini Live through the person's agent (WebSocket relay), metered by the minute; chat moves onto the agent's WebSocket with resumable streams.
- Phase 3, research: the plan, search, read and cite loop with hardened fetching and untrusted-content handling.
- Phase 4, memory: notes, files and links in Vectorize, R2 and D1, quoted with links back.
- Launch: portfolio card, build page on n8builds.dev, OpenPing watching `/api/health`.

## Done

- Phase 1, foundation and chat: see the pull requests on the repo.

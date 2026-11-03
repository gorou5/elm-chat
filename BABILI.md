# babili.datumoj.com — deployment notes

This directory is a standalone deployment of upstream elm-chat, kept
separate from the gorou5/datumoj repository and from every other
datumoj Worker.

- Upstream: https://github.com/shawnbure/elm-chat
- Upstream commit: 4c3c46c (Merge pull request #143, 2026-11-03 import)
- License: AGPL-3.0 (see LICENSE). The app keeps its upstream
  "elm.chat" branding; the landing footer links to this fork, which
  is the public source for the modified version running here.
- Cloudflare account: Datumoj (credentials in ~/.cloudflare-2.env,
  never commit them)
- Worker name: `babili` (independent Worker, `workers_dev` disabled)
- Domain: `babili.datumoj.com` (Worker custom domain, zone datumoj.com)
- Runtime: one Worker + one SQLite Durable Object per room
  (`RoomDurableObject`, migration tag v1). No D1, no R2, no KV.
  The root wrangler.jsonc is the deploy entry point; it intentionally
  has no GROWTH Analytics Engine binding, so this instance sends no
  growth events to elm.chat.

Local changes vs upstream (branch `babili`):

1. `wrangler.jsonc` + `workers/api/wrangler.jsonc` — Worker renamed
   `elm-chat` -> `babili`, `workers_dev: false`, custom-domain route
   for babili.datumoj.com added to both (the repo's
   check-wrangler-configs script requires the two files to stay in
   sync).
2. `apps/web/public/robots.txt` — sitemap URL points at
   babili.datumoj.com.
3. Build-time only: `SITE_ORIGIN=https://babili.datumoj.com` so the
   generated sitemap / RSS feed / prerendered pages use this origin
   instead of elm.chat.
4. Chinese edition (2026-11-03): full Simplified Chinese catalog in
   `apps/web/src/localization.ts` (`chinese`, locale `zh`); this
   instance falls back to Chinese when the browser states no
   supported preference (upstream fallback was English — the two
   assertions in `scripts/check-message-protocol.mjs` were updated
   to match, plus zh assertions added). The interactive UI (landing
   + room) is localized; the long English marketing articles under
   MarketingPage are not translated yet. `apps/web/index.html`
   carries the Chinese title/meta and babili.datumoj.com canonical
   URLs.
5. AGPL source link: the landing footer links to this fork
   (`SOURCE_URL` in `apps/web/src/App.tsx`,
   https://github.com/gorou5/elm-chat) because AGPL-3.0 section 13
   requires offering the source of the modified version actually
   running.
6. Short room URLs (2026-11-03): `ROOM_ID_BYTES` 16 -> 6, so room
   IDs are exactly 8 base64url characters and room/invite URLs are
   root-level (`babili.datumoj.com/xxxxxxxx`) instead of
   `/c/{22-char id}`. The client still routes legacy `/c/{id}`
   links. Access control is unchanged: the 32-byte room secret in
   the URL fragment and single-use invite tokens are the
   credentials; the shorter ID only names the room.
7. Landing page restyled after shadcn/ui (2026-11-03): zinc
   tokens, flat cards, small radius, zinc-900 primary button —
   implemented as a scoped override section at the end of
   `apps/web/src/styles.css` (`.landing-shell ...`) without adding
   Tailwind/Radix, so upstream merges stay manageable and the room
   UI keeps the upstream theme.
8. Minimal information architecture (2026-11-03): the landing
   keeps only information that changes the visitor's decision —
   what the service is, the two retention controls, the security
   warning and limitations link, creation errors, and the source
   link. Removed: the explanatory lede and brand gloss, promotional
   / article / press links, the Freshcode arrival card, the GitHub
   community feed, duplicated policy metrics, star/fork counts,
   and the room-secret explainer. The GitHub source link sits
   alone at the bottom-left of the page footer.

Redeploy (automatic, since 2026-11-03):

This Worker is connected to GitHub via Cloudflare Workers Builds.
Repository of record: https://github.com/gorou5/elm-chat (public fork
of shawnbure/elm-chat), production branch `babili`. Pushing to
`babili` builds and deploys automatically:

- Build command: `npm run build`
- Deploy command: `npx wrangler deploy -c wrangler.jsonc`
- Build variable: `SITE_ORIGIN=https://babili.datumoj.com`
- Preview builds: disabled (the `main` branch keeps the upstream
  Worker name `elm-chat` and must never be built by this trigger;
  `main` is a pure upstream mirror for syncing only)

Manual fallback deploy (same result, from a local checkout):

```sh
set -a; . ~/.cloudflare-2.env; set +a
export ELM_CHAT_CLOUDFLARE_ACCOUNT_ID="$CLOUDFLARE_ACCOUNT_ID"
export SITE_ORIGIN=https://babili.datumoj.com
npm install
npm run deploy
```

`npm run deploy` rebuilds apps/web/dist and deploys with the root
wrangler.jsonc. Do NOT use `npm run deploy:production` — that selects
the workspace config with the upstream GROWTH dataset.

Deployed 2026-11-03: Worker version a615baaa-dd94-456c-b2ad-e915c0084e14.
Verified live the same day: homepage 200, sitemap/robots on the
babili origin, POST /api/rooms created a Durable Object room,
GET room returned status open, creator destroy returned status
destroyed (test room cleaned up), /api/stars and /api/community
returned the upstream GitHub data. Two-browser encrypted messaging
was not re-tested here; it is covered by the upstream test suite
(npm test) and the live room lifecycle above.

Optional abuse protection (not enabled at launch): Cloudflare
Turnstile stays inert until a site key is baked into the web build
(`VITE_TURNSTILE_SITE_KEY`) and `TURNSTILE_SECRET` is set on the
Worker.

# babili.datumoj.com — deployment notes

This directory is a standalone deployment of upstream elm-chat, kept
separate from the gorou5/datumoj repository and from every other
datumoj Worker.

- Upstream: https://github.com/shawnbure/elm-chat
- Upstream commit: 4c3c46c (Merge pull request #143, 2026-11-03 import)
- License: AGPL-3.0 (see LICENSE). The app keeps its upstream
  "elm.chat" branding and links to the upstream source, which is the
  public source for this instance.
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

Redeploy:

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

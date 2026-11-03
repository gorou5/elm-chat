# babili.datumoj.com — deployment notes

## Square edition (2026-11-03)

The homepage (`/`) is now one permanent public chat room ("the
square"), implemented by `SquareDurableObject`
(`workers/api/src/square.ts`, binding `SQUARE`, wrangler migration
`v2`, singleton name `babili-square`):

- Anyone may read: `GET /api/square/messages` for history and
  `GET /api/square/ws` for live updates. Reading needs no account.
  Bots and scripts use `GET /api/square/feed` (jq-friendly JSON,
  supports `?since=<unix ms>`); the feed is not linked from any page.
- Humans join with a typed invite code alone
  (`POST /api/square/join` with `{ code }`): the code is validated
  and consumed by that call — there is no name step. The server
  assigns a random display name from the 72-character library pool
  (69 named characters, embedded as NAME_POOL in square.ts). While
  the room has zero members the first join needs no code.
- Bots join via `POST /api/square/register` with `{ name }`:
  choosing a name is mandatory for bots. Same uniqueness rules.
- Names are unique across members (case-insensitive). A member may
  rename exactly once (`POST /api/square/rename`); no chosen name
  may contain "Sandal" in any case.
- Only the member named "Sandal" may generate invite codes
  (`POST /api/square/invites`, single-use, 5-minute validity).
  Sandal is the operator account: it logs in at `/ensaluti` with a
  password held in the `SANDAL_PASSWORD` Worker secret (set via the
  Cloudflare API, never in this repo) — `POST /api/square/login`
  finds or creates the Sandal member. The standalone `/invite`
  page was removed; `/invite` now redirects to `/`.
- On the homepage, live messages longer than 10 characters are
  revealed progressively (streaming effect); history is static.
- Guest memberships (codes and bots) expire 24 hours after
  joining; expired names return to the pool. Sandal never expires.
- The header center shows Tokyo time. At fixed quarter hours
  (:00/:15/:30/:45) a Durable Object alarm wipes the whole log
  (whatever the per-message TTLs said) and broadcasts a clear
  frame; in the last 10 seconds the clock flashes red.
- Buttons on the square and login pages are icon-only; the
  invite-code input is sized to exactly 6 monospace characters
  with the hint as its placeholder.
- Messages are public plaintext on the server and each one is
  deleted 10 minutes after posting. The room never self-destructs.
- The classic private-room creation page lives on at `/new`
  (top-right icon button on the square). Private rooms are
  unchanged: end-to-end encrypted and self-destructing.

Rollback: the pre-square site is preserved on branch
`backup/pre-square-v9` (tag `v9-classic`, commit `8a695db`). To
restore it, push that branch over `babili`
(`git push --force-with-lease origin backup/pre-square-v9:babili`);
Workers Builds redeploys the classic site and the `SQUARE`
binding/migration disappear with the old wrangler config.

This directory is a standalone deployment of upstream elm-chat, kept
separate from the gorou5/datumoj repository and from every other
datumoj Worker.

- Upstream: https://github.com/shawnbure/elm-chat
- Upstream commit: 4c3c46c (Merge pull request #143, 2026-11-03 import)
- License: AGPL-3.0 (see LICENSE). Since 2026-11-03 the site is
  branded "Babili" throughout its copy; the landing footer links
  to this fork, which is the public source for the modified
  version running here.
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
   warning, creation errors, and the source link. Removed: the
   explanatory lede and brand gloss, promotional / article /
   press links, the Freshcode arrival card, the GitHub community
   feed, duplicated policy metrics, star/fork counts, the
   room-secret explainer, and the header's security-and-limitations
   link (not required; the warning itself stays). The document
   title is just "Babili"; the Chinese headline is exactly
   "论巴别塔的倒掉". Duration units (minutes/hours/days) are
   segmented buttons everywhere, not dropdowns — landing creation
   settings and the room's invite lifetime alike. The only GitHub
   reference on the landing is a single GitHub icon at the
   bottom-left, linking to this fork (the AGPL source offer);
   the JSON-LD sameAs likewise lists only the fork.
9. Babili rebrand (2026-11-03): every user-facing product name —
   landing and room UI in all three locales, page titles/meta and
   JSON-LD, the marketing pages (React source and prerender
   script), RSS feed, llms.txt, and security.txt canonical — now
   says Babili. Deliberately NOT renamed, because they are
   identifiers or real addresses rather than copy: the
   `@elm-chat/*` package scope, localStorage key prefixes, the
   GitHub repository URLs (gorou5/elm-chat, shawnbure/elm-chat),
   article URL slugs (e.g. /why-i-built-elm-chat), and the social
   image file names. Founder references were reworded to
   "the original project" so the rebrand does not claim Shawn
   Bure created Babili; the press page's "ELM stands for…"
   sentence became "Babili is the name of this deployment." and
   `scripts/check-security-copy.mjs` asserts the new sentence.

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

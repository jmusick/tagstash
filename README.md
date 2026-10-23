# Tagstash

Tagstash is a tag-first bookmarking app built with React, Cloudflare Pages Functions, and D1. It includes user accounts, email verification, Stripe-powered Pro subscriptions, import tooling, and a companion browser extension.

The official hosted version is available at https://tagsta.sh/

## Project Status

Tagstash is active and in real-world use.

Current status at a glance:

- User registration, login, and JWT-backed sessions are working
- Email verification and resend flows are live
- Free and Pro tiers are implemented
- Stripe Checkout and Stripe Billing Portal are integrated
- Admin controls exist for managing user roles and membership tiers
- Bookmark CRUD, tag cloud filtering, import flow, and search are in place
- Opt-in public profiles let users share a read-only, tag-filterable view of their bookmarks
- Browser extension support exists in the companion [tagstash-extension repository](https://github.com/jmusick/tagstash-extension)
- Manual and background refresh keep the bookmark list in sync with saves made via the browser extension
- A dedicated Tag Management page supports merging, renaming and deleting tags

## Features

- Tag-first bookmark organization
- Export your entire library from Settings → Import / Export as Netscape HTML, CSV, or JSON, including private bookmarks. JSON preserves dates, tags, favorites, and privacy settings; HTML/CSV support migration to other tools. HTML imports also read exported tags and descriptions.
- Bookmark title, URL, description, and tag management
- Base URL keeps the site root with a trailing slash (for example, `https://www.google.com/`); Trim URL removes queries and fragments
- Search, sorting, and tag query filtering (click any tag on a bookmark or in the tag panel to filter by it; combine tags to narrow results), plus a "Without tags" filter in your own library for finding and tidying up untagged bookmarks
- In your own library, filter by site domain or month saved, with counts for the whole library. Related and the Domain filter group subdomains together (for example, `www.reddit.com` and `old.reddit.com` under `reddit.com`, or `old.reddit.co.uk` under `reddit.co.uk`). Months include the year and use your local time zone. Combine these with search, tags, favorites and "Without tags"; Related resets the filters to the selected bookmark's site.
- Free tier with a 50-bookmark limit
- Pro tier with unlimited bookmarks
- Stripe Checkout for upgrades ($3/month or $36/year — same rate either way)
- Stripe Billing Portal for subscription management
- Email verification via Cloudflare Email Sending
- Opt-in public profiles (`/u/:username`) for sharing your bookmarks via a link, with per-bookmark privacy control and tag filtering
- Public JSON API (`/api/profiles/:username`, optionally tag-filtered) for embedding your bookmarks on other sites, with ready-to-copy URLs in Settings
- Super admin controls for managing users, roles, and tiers, plus moderation (suspend an account, force a profile private)
- Three theme options (Slate, Midnight, Light), with your pick synced to your account when logged in
- Preference for opening bookmark links in a new tab or the same tab (Settings → Preferences), synced to your account
- Responsive UI for desktop and mobile
- Firefox/browser extension companion for saving the current tab quickly
- Refresh button plus a quiet 5-minute background poll so bookmarks saved elsewhere (e.g. the browser extension) show up without a page reload
- Random button for jumping straight to a random bookmark in edit mode
- Tag Management page (`/tags`) for merging two tags into one, renaming a tag on every bookmark that uses it (renaming onto an existing tag merges them), and deleting a tag from all of your bookmarks, with a confirmation step for anything that can't be undone
- Self-service username, email, and password changes, plus a forgot-password email flow
- Personal API keys (Settings) can be generated and revoked; they are not yet accepted as an authentication method by the API. Keys are stored only as a SHA-256 hash plus a short display hint (`tsk_ab12...wxyz`), so the full key is shown once at creation and can never be retrieved again
- Password policy for new passwords (sign-up, change, reset): at least 8 characters and at most 72 UTF-8 bytes (bcrypt's limit), and passwords found in known breaches are refused via a Have I Been Pwned k-anonymity lookup (only a 5-character hash prefix is sent; the check fails open if the service is unreachable). Existing passwords keep working.
- Account-enumeration resistance: sign-up, password reset and verification resend give the same answer (and timing, with the email sent after the response) whether or not an address has an account; signing up with a registered address emails its owner instead. Usernames are public, so "username taken" is reported.
- Brute-force protection: 8 failed logins lock an account for 15 minutes, with per-IP/per-email throttling of login, sign-up, verification resends and password-reset requests; auth events are logged for super admins in Settings → Admin
- Security response headers (CSP, HSTS, `nosniff`, `X-Frame-Options`, `Referrer-Policy`, `Permissions-Policy`) and immutable caching for hashed assets, served via `public/_headers`
- Reset and verification links are stored as SHA-256 digests, and unverified-account guidance is shown only after a correct password. Keyboard focus outlines, skip links, and reduced-motion support cover the main app and public pages.
- Dynamic XML sitemap (`/sitemap.xml`) listing static pages and public profiles that meet a quality bar (verified email, account at least 14 days old, 5+ public bookmarks; profiles below it are served with `noindex`), plus `robots.txt` and `llms.txt`, for search engine and AI crawler discovery

## Hosted Version

The commercial hosted version of Tagstash is available at https://tagsta.sh/

That hosted service is the official paid offering run by Stone Dragon Media LLC. This repository is source-available primarily so people can study the codebase; see [LICENSE.md](./LICENSE.md) for what else is permitted.

## Tech Stack

### Frontend

- React 18
- React Router
- Vite
- Axios
- Context API
- lucide-react

The public `/features` page is prerendered during `npm run build` from the same
React component used in the app. `scripts/prerender-features.mjs` writes complete
HTML and page metadata to `dist/features.html`, including the styles needed
before JavaScript loads. Feature copy lives in `src/components/FeaturesPage.jsx`.
Cloudflare Pages serves the file at `/features`; the middleware must also list that
path as an indexable page. `/features/` and `/features.html` redirect to `/features`.
`/privacy` and `/support` get the same treatment for their `<head>` only (`dist/privacy.html`,
`dist/support.html`), so crawlers see each page's own title, description and canonical
without running JavaScript; their titles/descriptions live in `src/utils/pageMeta.js`.
Homepage feature/FAQ copy and page-specific structured data are shared between
React and Pages Functions in `src/content/` to keep crawler and browser content aligned.

Feature demonstrations continuously capture the local interface during real
interactions, exported as silent looping MP4s in `public/feature-demos/`.
An animated pointer and click highlight follow the recorded control coordinates.
Each section loads its selected clip when visible;
visitors can pause playback, switch clips, open a larger view, or read the text
walkthrough. Reduced-motion preferences default to paused playback.

Set `TAGSTASH_DEMO_WORK_DIR` to a working directory outside the source checkout
for import fixtures, SQL, capture manifests, raw frames, and render intermediates.
To prepare a local demo collection after applying migrations, run
`node scripts/seed-feature-demo.mjs`. It uses **only local D1** and creates the
verified `features-demo@example.test` account (password `TagstashDemo2026!`) with
overlapping tags, favorites, and private bookmarks. Use `http://localhost:3000`
for login: that origin is allowed by the local web-session checks. An HTML import
fixture is written to `import.html` in that working directory.

`scripts/capture-feature-demo.mjs` accepts an authorized @Browser tab handle and
captures frames while that tab is driven through the demonstrations. Its `start`,
`action`, `hold`, and `stop` helpers write `recordings.json` in the directory passed
to `createDemoRecorder(tab, directory)` (use the same working directory), with
frame timestamps, captions, and click target coordinates. Use `stop` in a `finally`
block so failures do not leave capture running. Keep the default 1280 × 720 viewport
and bring each target into view before recording its coordinates.

`node scripts/render-feature-demos.mjs` renders that capture manifest with FFmpeg;
set `FFMPEG_PATH` to a local executable, or install `ffmpeg-static` in
the working directory's `tools` folder. Output is H.264 at 24 fps, 1120 × 704, with captions
below the app. Pointer motion is an editorial overlay between real click targets,
rather than an operating-system cursor track. The extension clip
shows install options, and the merge clip previews tag selection before confirmation.

### Backend

- Cloudflare Pages Functions
- Cloudflare D1
- bcryptjs
- jose
- Cloudflare Email Sending
- Stripe REST API

## Local Development

### Prerequisites

- Node.js 22.13+ (the regression suite uses built-in SQLite)
- npm 11.19+ (supply-chain install policy; see [dependency safeguards](docs/supply-chain.md))
- Wrangler / Cloudflare account for deployment workflows

### Install

```bash
git clone https://github.com/jmusick/tagstash.git
cd tagstash
npm ci
```

### Configure local secrets

Create `.dev.vars` for local Cloudflare Functions development.

Required or commonly used values:

- `JWT_SECRET`
- `SUPER_ADMIN_EMAIL`
- `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` for email sending (Cloudflare Email Sending), needed for registration/verification/password-reset emails and the support form
- `EMAIL_FROM`, `EMAIL_FROM_VERIFICATION`, `EMAIL_FROM_PASSWORD_RESET`, `EMAIL_FROM_CONTACT`, `EMAIL_REPLY_TO`, `SUPPORT_EMAIL` — per-purpose sender/reply addresses for Cloudflare Email Sending; each falls back to `EMAIL_FROM`, then a `tagsta.sh` default
- `TURNSTILE_SECRET_KEY` for validating the support form's Cloudflare Turnstile CAPTCHA
- `STRIPE_SECRET_KEY`
- `STRIPE_WEBHOOK_SECRET`
- `STRIPE_MONTHLY_PRICE_ID`
- `STRIPE_ANNUAL_PRICE_ID`
- `APP_URL` for hosted redirect URLs

For the frontend, optionally create `.env` and set:

- `VITE_API_URL` if you do not want to use the default local proxy
- `VITE_TURNSTILE_SITE_KEY` for the support form's Turnstile widget

### Database setup

```bash
npm run setup:db
```

### Run locally

Run frontend and API together:

```bash
npm run dev:all
```

Or run them separately:

```bash
npm run dev
npm run dev:api
```

Default local URLs:

- Frontend: http://localhost:3000
- API: http://localhost:5000/api

## Deployment Notes

Tagstash is designed for Cloudflare Pages + D1.

The GitHub integration deploys `master` from `jmusick/tagstash` to the `tagstash`
Pages project. Its build command is `npm run build`, output directory is `dist`,
and repository root is the build root. See [deployment configuration and checks](docs/deployment.md).

Production setup includes:

- D1 migrations applied locally and remotely
- Cloudflare Pages secrets for Stripe and email
- Stripe webhook endpoint wired to `/api/billing/webhook`
- Security headers come from `public/_headers`; its Content Security Policy allowlists Google Analytics/Tag Manager, Google favicons, and Cloudflare Turnstile (the Archivo font is self-hosted from `src/assets/fonts/`, so no font origin is allowlisted), so a new third-party origin must be added there

### Stripe-related secrets

- `STRIPE_SECRET_KEY`
- `STRIPE_WEBHOOK_SECRET`
- `STRIPE_MONTHLY_PRICE_ID`
- `STRIPE_ANNUAL_PRICE_ID`
- `APP_URL`

## Key API Routes

### Health

- `GET /api/health` — liveness check, works even without D1 configured

### Auth

The web app uses a seven-day JWT session in a host-only `HttpOnly; Secure; SameSite=Lax`
cookie (`__Host-tagstash-session`). It sends `X-Tagstash-Client: web` and credentials on
API requests; session-issuing responses set the cookie and omit the token from JSON.
Web requests require a trusted Origin (or Referer / same-origin Fetch Metadata fallback),
and cookie-authenticated mutations require the custom header as CSRF protection.
Set `APP_URL` to your web app origin when serving the API separately. Cross-site cookie
deployments are not supported by `SameSite=Lax`; use the same origin or same site.
Plain HTTP loopback development uses `tagstash-session` without `Secure`.

The browser extension and other bearer clients retain the existing 60-day JWT flow:
omit the web-client header on login and send the returned token as `Authorization: Bearer`.
Personal API keys are still not an authentication path. Web cookie tokens cannot be used
as bearer credentials, and bearer tokens cannot be used as cookies. Password changes
and resets revoke both types through `token_version`; password changes replace the
current session. Existing web tokens are exchanged for cookies on the next app visit
and removed from localStorage. Previously issued bearer tokens keep their original
expiry unless revoked by a password change/reset.

Auth regression checks: `npm run test:auth` (Node 22.13+ with built-in SQLite).
These use an isolated in-memory database and never access production.

- `POST /api/auth/register` — `201 { pendingVerification: true }` whether or not the email already has an account (its owner is emailed instead); `400` for invalid input, a taken username or a breached password
- `POST /api/auth/login`
- `POST /api/auth/session` — exchange a legacy bearer token for a web cookie session
- `POST /api/auth/logout` — clear the current web session cookie
- `GET /api/auth/me`
- `GET /api/auth/verify-email`
- `POST /api/auth/resend-verification`
- `PUT /api/auth/username`
- `PUT /api/auth/email` — reports an address already in use only after the current password is confirmed
- `PUT /api/auth/password`
- `PUT /api/auth/profile-public`
- `PUT /api/auth/theme`
- `PUT /api/auth/link-target`
- `GET /api/auth/api-keys`
- `POST /api/auth/api-keys` — returns the plaintext key once; `GET` lists metadata only
- `DELETE /api/auth/api-keys/:id`
- `DELETE /api/auth/api-keys/:id/permanent`
- `POST /api/auth/reset-library` — wipe the signed-in owner's library and keep the account (see below)
- `POST /api/auth/delete-account` — self-service deletion of the signed-in account (see below)
- `POST /api/auth/resume-deletion` — finish a deletion that was interrupted (see below)
- `POST /api/auth/forgot-password` — the same `200` for registered and unknown addresses; the reset email is sent after the response
- `POST /api/auth/reset-password`

### Admin

- `GET /api/auth/admin/users`
- `PATCH /api/auth/admin/users/:id`
- `DELETE /api/auth/admin/users/:id`
- `POST /api/auth/admin/users/:id/suspend` — hide the account's public profile everywhere and block re-publishing (the user can still sign in)
- `POST /api/auth/admin/users/:id/unsuspend` — lift a suspension (does not re-publish a profile that was made private)
- `POST /api/auth/admin/users/:id/make-private` — force the profile private
- `GET /api/auth/admin/auth-events` — recent security and moderation events

Account deletion (admin, or the owner's own from Settings → Delete Account) requires
migration `0018_account_deletion.sql`. Once deletion starts, the account cannot sign in
or use existing sessions. Its Stripe customer
is removed first, immediately canceling that customer's active subscriptions;
legacy accounts with only a subscription ID have that subscription canceled.
Accounts without Stripe identifiers need no billing configuration.

Billing failures retain the account data and return `502` (`503` for missing
configuration). Retry to finish a pending deletion (the admin repeats the delete action;
the owner uses the login screen, below). After
billing is stopped, one D1 transaction removes the account, bookmarks, private
tokens, API keys, favorites, and associated security-log records. Tags shared with
other accounts are preserved. If that transaction fails, the data is retained and
deletion stays pending; retry does not resume billing. Stripe retains its own
historical records according to its policies. Account reset, which keeps the account,
is separate (see Account reset below).

**Self-service deletion.** `POST /api/auth/delete-account` takes
`{ "password": "...", "confirmation": "DELETE" }` and needs normal authentication: a web
cookie session (with the usual `X-Tagstash-Client: web` header and trusted `Origin`) or a
bearer token. The password goes through the same lockout counter and per-IP cap as login, and
the typed confirmation is checked by the server too. It runs the same `deleteAccount`
cleanup as the admin route, so billing is stopped first (immediately),
then the data is removed in one transaction, and a success response (`{ deleted: true }`)
also clears the session cookie. Configured super admins get `403`. If the deletion starts
but cannot finish (`502` for a billing failure, `503` for a database failure or missing
Stripe configuration), the answer carries `deletionPending: true` and the session is ended:
the durable marker keeps the account locked and is never cleared automatically.

To resume, a login with the correct password on a pending account answers `403` with
`deletionPending: true` (only after the password is proved, so it reveals nothing about
other addresses). The web app then offers "Finish deleting my account", which calls
`POST /api/auth/resume-deletion` with `{ email, password }`, re-proves the password under the
same lockout and IP caps, and retries the cleanup. It can only complete a deletion that was
already started (`409` otherwise) and never restores access.

**Support recovery for a stuck deletion.** Deletion is stuck when a pending account's owner
cannot finish it from the login screen (for example Stripe keeps failing, or a D1 error
persists). List pending accounts with
`wrangler d1 execute tagstash-db --remote --command "SELECT id, email, deletion_started_at FROM users WHERE deletion_started_at IS NOT NULL"`,
fix the cause (Stripe keys or status, D1 health), then finish the deletion with the admin
delete action in Settings → Admin, which retries the same cleanup. Do not clear
`deletion_started_at` to give the owner their account back unless you have checked in the
Stripe dashboard that the customer and subscription are still in the state the owner wants:
billing may already have stopped even though the request failed. `docs/deployment.md` has
the details.

**Account reset (library only).** `POST /api/auth/reset-library` takes
`{ "password": "...", "confirmation": "RESET" }` (a different word from account deletion's
`DELETE`) with the same authentication as deletion: a web cookie session behind the CSRF/origin gate, or a
bearer token. It validates the body first, then checks the password through
`confirmCurrentPassword` (shared login lockout counter and per-IP cap). Scope:

- **Removed:** every bookmark of the account (private ones too), the links between those
  bookmarks and tags, the account's favorite tags, and any global tag names nothing else
  references (no other account's bookmark link or favorite), the same orphan rule as deleting a tag.
- **Kept:** the account, username, email, password, sessions and extension sign-ins, API keys,
  preferences (theme, link-opening, public profile setting), billing and membership. It never calls
  `deleteAccount` and makes no Stripe or email calls. Other accounts' bookmarks, shared tags and
  favorites are untouched.

Everything commits in one `db.batch()`, so a failure answers `503` and changes nothing. The
public-profile edge cache entries for the account are purged afterwards (best effort, as for other
profile changes). An account whose deletion has started is refused (`403` from the session check,
`409` if deletion starts mid-request). The success body is
`{ reset: true, removed: { bookmarks, tagLinks, favoriteTags } }`. Settings → Reset Library is the UI.

### Billing

- `GET /api/billing/plans`
- `GET /api/billing/status`
- `POST /api/billing/checkout-session`
- `POST /api/billing/portal-session`
- `POST /api/billing/webhook`

### Support

- `POST /api/support` — contact form submission (email + message), gated by Cloudflare Turnstile

### Bookmarks

- `GET /api/bookmarks`
- `GET /api/bookmarks/:id`
- `POST /api/bookmarks`
- `PUT /api/bookmarks/:id`
- `DELETE /api/bookmarks/:id`
- `GET /api/bookmarks/by-url` — lookup by exact URL, used to detect duplicates (e.g. from the browser extension)
- `POST /api/bookmarks/meta` — fetch a page's title metadata (public http(s) pages only; rate limited per account)
- `POST /api/bookmarks/meta-description` — fetch a page's description metadata (same rules)
- `POST /api/bookmarks/import` — up to 2000 bookmarks per request; reports `imported`, `skipped`, `duplicates`, `invalid` (with `invalidRows`), `truncated` and `droppedTags`
- `GET /api/bookmarks/tags/all`
- `POST /api/bookmarks/tags/merge`
- `PUT /api/bookmarks/tags/:id` — rename a tag on all of your bookmarks (`{ "name": "..." }`); renaming onto a tag you already use merges them (`merged: true`)
- `DELETE /api/bookmarks/tags/:id` — remove a tag from all of your bookmarks (bookmarks are kept); reports `removedFrom`
- `POST /api/bookmarks/tags/:id/favorite`
- `POST /api/bookmarks/:id/favorite`
- `POST /api/bookmarks/:id/private`

Request bodies must be JSON objects sent as `application/json` (415 otherwise) and are capped in size (413). Fields are type-checked and length-limited — bookmark title 1000 characters, URL 8192, description 10000, tags 100 characters each and 50 per bookmark — and an invalid create or update returns 400 without changing anything.

### Public Profiles

- `GET /api/profiles/:username` — unauthenticated; returns a user's public, non-private bookmarks and tags if they've opted in via `PUT /api/auth/profile-public`. Profiles that aren't public, don't exist, or belong to a suspended account all answer the same `404`.

This is a stable, documented public API meant for third-party consumption (not just internal page-support data) — Settings surfaces ready-to-copy URLs for it. Responses are JSON with CORS enabled for all origins, so it can be fetched directly from another site's frontend or from a server-side build/SSR step. The site's Content Security Policy governs only Tagstash's own pages, not consumers of this API.

Successful responses are cached at the Cloudflare edge for 60 seconds (`Cache-Control: public, max-age=0, s-maxage=60`; browsers always revalidate), keyed on the username and `?tag=` filters only. A change to a profile's bookmarks can therefore take up to a minute to show up, and a profile that is made private or suspended can keep being served for up to a minute from data centers that were not purged. Errors and 404s are never cached.

Optional repeatable `?tag=` query param filters to bookmarks that have *all* of the given tags (AND):

```
GET /api/profiles/alice
GET /api/profiles/alice?tag=poe2
GET /api/profiles/alice?tag=poe2&tag=guides
```

Example response:

```json
{
  "profile": { "username": "alice", "member_since": "2026-01-01T00:00:00.000Z", "indexable": true },
  "bookmarks": [
    {
      "id": 1,
      "title": "PoE2 Leveling Guide",
      "url": "https://example.com/guide",
      "description": "...",
      "favicon_url": "https://...",
      "created_at": "2026-01-01T00:00:00.000Z",
      "updated_at": "2026-01-02T00:00:00.000Z",
      "tags": [{ "id": 1, "name": "poe2" }, { "id": 2, "name": "guides" }]
    }
  ],
  "tags": [{ "name": "poe2", "count": 3 }, { "name": "guides", "count": 1 }],
  "appliedTags": ["poe2", "guides"]
}
```

`tags` always lists the full public tag set for that user, regardless of any `?tag=` filter applied, so a consumer can discover what other tags are available.

`profile.indexable` (added in a backward-compatible way) says whether the profile page at `/u/:username` is open to search engines. It is `false` until the account has a verified email, is at least 14 days old and has 5 or more public bookmarks. Consumers can ignore it.

## Project Structure

```text
tagstash/
├── d1/
│   └── migrations/
├── functions/
│   ├── api/
│   ├── u/                 # per-profile meta injection for /u/:username
│   ├── index.js           # server-rendered homepage content + structured data
│   └── sitemap.xml.js
├── public/                # static assets, robots.txt, llms.txt, _headers
├── src/
│   ├── api/
│   ├── components/
│   ├── context/
│   ├── utils/
│   ├── App.jsx
│   └── main.jsx
├── .dev.vars
├── package.json
├── vite.config.js
└── wrangler.toml
```

## Available Scripts

- `npm run dev` - Run the frontend dev server
- `npm run dev:api` - Run local Cloudflare Pages Functions and D1
- `npm run dev:all` - Run frontend and API together
- `npm run setup:db` - Apply local D1 migrations
- `npm run build` - Create a production build
- `npm run preview` - Preview the production build locally
- `npm run lint` - Run ESLint

## Backlog and documentation

[GitHub Issues](https://github.com/jmusick/tagstash/issues) owns actionable work,
with `category:*` and `priority:P1|P2|P3` labels. The
[October 10 migration record](https://github.com/jmusick/tagstash/issues/1)
preserves the earlier audit scope, dates, and original requirements. Extension
work belongs in [its issue tracker](https://github.com/jmusick/tagstash-extension/issues).

Keep setup, architecture, deployment, and contributor conventions in this
repository. Keep original artwork, social media graphics, raw captures, backups,
and historical audit evidence outside the deployable source tree; only runtime
assets and repeatable development tools belong here.

## License

Tagstash is source-available under the custom **Tagstash Non-Commercial License (TNCL) v1.0**.

In plain English:

- You can run Tagstash yourself for free
- You can modify it for your own non-commercial use
- You cannot sell it
- You cannot charge for hosting it
- You cannot bundle it into a paid product or service
- You cannot make money from it in any way without explicit written permission

Read the full terms in [LICENSE.md](./LICENSE.md).

For commercial licensing inquiries, contact `legal@tagsta.sh`.

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
- A dedicated Tag Management page supports merging tags together

## Features

- Tag-first bookmark organization
- Export your entire library from Settings → Import / Export as Netscape HTML, CSV, or JSON, including private bookmarks. JSON preserves dates, tags, favorites, and privacy settings; HTML/CSV support migration to other tools. HTML imports also read exported tags and descriptions.
- Bookmark title, URL, description, and tag management
- Base URL keeps the site root with a trailing slash (for example, `https://www.google.com/`); Trim URL removes queries and fragments
- Search, sorting, and tag query filtering (click any tag on a bookmark or in the tag panel to filter by it; combine tags to narrow results)
- Free tier with a 50-bookmark limit
- Pro tier with unlimited bookmarks
- Stripe Checkout for upgrades ($3/month or $36/year — same rate either way)
- Stripe Billing Portal for subscription management
- Email verification via Cloudflare Email Sending
- Opt-in public profiles (`/u/:username`) for sharing your bookmarks via a link, with per-bookmark privacy control and tag filtering
- Public JSON API (`/api/profiles/:username`, optionally tag-filtered) for embedding your bookmarks on other sites, with ready-to-copy URLs in Settings
- Super admin controls for managing users, roles, and tiers
- Three theme options (Slate, Midnight, Light), with your pick synced to your account when logged in
- Preference for opening bookmark links in a new tab or the same tab (Settings → Preferences), synced to your account
- Responsive UI for desktop and mobile
- Firefox/browser extension companion for saving the current tab quickly
- Refresh button plus a quiet 5-minute background poll so bookmarks saved elsewhere (e.g. the browser extension) show up without a page reload
- Random button for jumping straight to a random bookmark in edit mode
- Tag Management page (`/tags`) for merging two tags into one, with a confirmation step since it can't be undone
- Self-service username, email, and password changes, plus a forgot-password email flow
- Personal API keys (Settings) can be generated and revoked; they are not yet accepted as an authentication method by the API. Keys are stored only as a SHA-256 hash plus a short display hint (`tsk_ab12...wxyz`), so the full key is shown once at creation and can never be retrieved again
- Brute-force protection: 8 failed logins lock an account for 15 minutes, with per-IP/per-email throttling of login, sign-up, verification resends and password-reset requests; auth events are logged for super admins in Settings → Admin
- Security response headers (CSP, HSTS, `nosniff`, `X-Frame-Options`, `Referrer-Policy`, `Permissions-Policy`) and immutable caching for hashed assets, served via `public/_headers`
- Reset and verification links are stored as SHA-256 digests, and unverified-account guidance is shown only after a correct password. Keyboard focus outlines, skip links, and reduced-motion support cover the main app and public pages.
- Dynamic XML sitemap (`/sitemap.xml`) listing static pages and opted-in public profiles, plus `robots.txt` and `llms.txt`, for search engine and AI crawler discovery

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
- npm
- Wrangler / Cloudflare account for deployment workflows

### Install

```bash
git clone https://github.com/jmusick/tagstash.git
cd tagstash
npm install
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
- Security headers come from `public/_headers`; its Content Security Policy allowlists Google Analytics/Tag Manager, Google favicons, Google Fonts, and Cloudflare Turnstile, so a new third-party origin must be added there

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

- `POST /api/auth/register`
- `POST /api/auth/login`
- `POST /api/auth/session` — exchange a legacy bearer token for a web cookie session
- `POST /api/auth/logout` — clear the current web session cookie
- `GET /api/auth/me`
- `GET /api/auth/verify-email`
- `POST /api/auth/resend-verification`
- `PUT /api/auth/username`
- `PUT /api/auth/email`
- `PUT /api/auth/password`
- `PUT /api/auth/profile-public`
- `PUT /api/auth/theme`
- `PUT /api/auth/link-target`
- `GET /api/auth/api-keys`
- `POST /api/auth/api-keys` — returns the plaintext key once; `GET` lists metadata only
- `DELETE /api/auth/api-keys/:id`
- `DELETE /api/auth/api-keys/:id/permanent`
- `POST /api/auth/forgot-password`
- `POST /api/auth/reset-password`

### Admin

- `GET /api/auth/admin/users`
- `PATCH /api/auth/admin/users/:id`
- `DELETE /api/auth/admin/users/:id`

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
- `POST /api/bookmarks/meta` — fetch a page's title metadata
- `POST /api/bookmarks/meta-description` — fetch a page's description metadata
- `POST /api/bookmarks/import`
- `GET /api/bookmarks/tags/all`
- `POST /api/bookmarks/tags/merge`
- `POST /api/bookmarks/tags/:id/favorite`
- `POST /api/bookmarks/:id/favorite`
- `POST /api/bookmarks/:id/private`

### Public Profiles

- `GET /api/profiles/:username` — unauthenticated; returns a user's public, non-private bookmarks and tags if they've opted in via `PUT /api/auth/profile-public`

This is a stable, documented public API meant for third-party consumption (not just internal page-support data) — Settings surfaces ready-to-copy URLs for it. Responses are JSON with CORS enabled for all origins, so it can be fetched directly from another site's frontend or from a server-side build/SSR step. The site's Content Security Policy governs only Tagstash's own pages, not consumers of this API.

Optional repeatable `?tag=` query param filters to bookmarks that have *all* of the given tags (AND):

```
GET /api/profiles/alice
GET /api/profiles/alice?tag=poe2
GET /api/profiles/alice?tag=poe2&tag=guides
```

Example response:

```json
{
  "profile": { "username": "alice", "member_since": "2026-01-01T00:00:00.000Z" },
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

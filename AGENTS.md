# AGENTS.md

Conventions and gotchas for working in this repo, gathered from hands-on sessions. Read this before making non-trivial changes — several of these aren't obvious from the code alone.

## What this is

Tagstash is a **live SaaS with real users and real Stripe billing** (hosted at tagsta.sh). Treat prod data, migrations, and billing code with care — this isn't a toy project. See `README.md` for the feature/tech overview.

## Backend: single-file dispatcher

All API logic lives in one file: `functions/api/[[path]].js`. There's no router library — `onRequest` splits the URL into `segments` and dispatches by `segments[1]` to a `handleX` function (`handleAuth`, `handleBookmarks`, `handleProfiles`, `handleBilling`, `handleSupport`), each an if-chain branching on `request.method` + further segments. A new route means either a new branch inside an existing `handleX`, or a new top-level `handleX` wired into `onRequest`'s dispatch.

Auth pattern: every protected branch starts with

```js
const auth = await requireAuth(request, env);
if (auth.error) return auth.error;
```

Routes that must be reachable by anonymous visitors (like the public profile endpoint) need their own handler that never calls `requireAuth` — don't add them as a branch inside `handleBookmarks`/`handleAuth`, since those call `requireAuth` unconditionally at the top.

`GET /api/health` is a sixth top-level route, but it's handled inline inside `onRequest` itself (not a `handleX` function), and deliberately checked *before* the `env.DB` binding check — so it works as a liveness probe even without D1 configured.

There's also a Pages Function outside the `/api` dispatcher entirely: `functions/sitemap.xml.js` serves `GET /sitemap.xml`, listing a few hardcoded static pages plus the public profiles that pass the indexing bar (see "Profile moderation and the indexing bar" below).

`GET /api/profiles/:username` (in `handleProfiles`) is a **stable, documented public API** meant for third-party consumption — Settings surfaces ready-to-copy URLs (including per-tag `?tag=` filters) for users to embed on other sites, and it's documented in `README.md`. Treat changes to its response shape as a compatibility concern, not a free internal refactor.

## Security headers and CSP (`public/_headers`)

`public/_headers` sets the CSP, HSTS, `nosniff`, `X-Frame-Options`, `Cross-Origin-Opener-Policy: same-origin`, `Referrer-Policy` and `Permissions-Policy` on every static asset, plus immutable caching on `/assets/*`. Pages applies `_headers` to static assets only, but `functions/index.js` and `functions/u/[username].js` call `next()` and re-wrap the asset response, so the SSR'd `/` and `/u/*` inherit the headers too. COOP is safe only because Stripe Checkout and the billing portal are full-page navigations (`window.location`), Turnstile is an iframe and nothing uses `window.open`/`opener`; a future popup-based flow (OAuth, Stripe popup) would need `same-origin-allow-popups`. HSTS deliberately has no `preload` yet, and `style-src` still allows `'unsafe-inline'`.

`/api/*` responses are built by the Worker and get none of `_headers`. Instead `withApiHeaders` in `functions/api/[[path]].js` stamps every response — success, error, the CSRF 403, the catch-all 500 and `onRequestOptions` preflights — with `Cache-Control: no-store`, `nosniff`, `Referrer-Policy: no-referrer`, `X-Frame-Options: DENY`, a `default-src 'none'; frame-ancestors 'none'` CSP, and HSTS on HTTPS requests, then applies CORS via `withCors`/`corsHeadersFor`. Route new response paths through `onRequest` rather than returning around it. `tests/api-headers.test.mjs` covers the paths. CORS is an allowlist (`ALLOWED_ORIGINS` + `APP_URL` + any `moz-extension://`): the matching `Origin` is echoed back with `Vary: Origin`, and anything else gets no `Access-Control-Allow-Origin`. The browser extension normally bypasses CORS through its `host_permissions`; its Chrome ID and the Firefox scheme are listed only so installs whose site access was revoked keep working. If the extension ships under a new store ID (e.g. Edge), add it.

The CSP is an enforced allowlist built from what the app actually loads: `'self'`, Google Tag Manager/Analytics (loaded only after cookie consent), Google favicons (`www.google.com` redirecting to `*.gstatic.com`), Google Fonts, and Cloudflare Turnstile (script + iframe). There is **no `'unsafe-inline'` for scripts**, only for styles. If you add a third-party script, image host, iframe or `fetch` target, add its origin to the matching directive, and update the Third-Party Services section of `PolicyPage.jsx` if it touches user data. A blocked resource shows up as a CSP error in the browser console, not in the build.

The public profile API is consumed cross-origin by other sites (orboro.net and Hidden Lodge fetch it server-side in Astro SSR/build code, so they aren't subject to CORS or CSP at all). `corsHeadersFor` keeps `Access-Control-Allow-Origin: *` on `/api/profiles/*` while the rest of the API uses the allowlist — that endpoint is public by design.

## Server-rendered pages outside the API

Two Pages Functions rewrite the SPA shell's HTML before it reaches the browser: `functions/index.js` (homepage marketing copy + `SoftwareApplication`/`FAQPage` JSON-LD) and `functions/u/[username].js` (per-profile title/description/OG tags). React hydrates over the result, so the SSR'd DOM and `Home.jsx`/`useDocumentMeta.js` must agree — change copy or titles in both places. Both bail out (returning the untouched response) for non-200 or non-HTML responses. `/u/:username` answers a missing, non-public or suspended profile with a real **404** (SPA shell kept as the body so the app renders its not-found UI, plus `noindex`) and a failed D1 lookup with **503**; a public profile below the indexing bar is a 200 with noindex; canonical, `og:url` and JSON-LD use the *stored* `users.username` casing, not the URL's (`PublicProfile.jsx` does the same client-side).

`/features`, `/privacy` and `/support` are prerendered at build time by `scripts/prerender-features.mjs` into `dist/*.html` (Pages serves them extensionless): `/features` gets full body markup, `/privacy` and `/support` only a rewritten `<head>` (title, description, canonical, OG/Twitter) because their bodies are interactive. Head text lives in `FEATURES_META` (`src/utils/featuresMeta.js`) and `PRIVACY_META`/`SUPPORT_META` (`src/utils/pageMeta.js`), shared with `useDocumentMeta`; the head rewrite is `scripts/page-head.mjs`. A new indexable static page needs an entry there **and** in `functions/_middleware.js`'s `PAGE_PATHS` (everything else gets a 404 + noindex). The sitemap's profile `lastmod` is the newest *public* bookmark's `created_at`/`updated_at` (not `users.updated_at`). `robots.txt`, `llms.txt` and the sitemap are the other crawler-facing surfaces; keep `llms.txt` current when pricing or features change.

## Input limits and request validation

Every write route validates its **whole** payload before touching D1, then commits related writes in one `db.batch()` (D1 runs a batch as a transaction). Invalid input answers 400 and leaves the prior row and its `bookmark_tags` untouched; `tests/input-limits.test.mjs` pins this. Follow the same shape for new routes: validate → build statements → one batch.

- **Bodies:** `parseBody(request, { maxBytes })` streams the body and throws `HttpError` (413 over the cap — 256 KB by default, `MAX_IMPORT_BODY_BYTES` 8 MB for import; 415 unless `application/json`/`+json`; 400 for invalid JSON or a non-object). `routeRequest`'s catch turns `HttpError` into a JSON response. An empty body is still `{}`.
- **Limits** live in `INPUT_LIMITS` in `functions/api/[[path]].js`: title 1000, URL 8192 (after normalization), description 10000, tag 100 chars, 50 tags per bookmark, username 50, email 254, password 256 (set only; login doesn't cap), API key name 100, 2000 rows per import. (The API-key count limit is `MAX_ACTIVE_API_KEYS_PER_USER`, with the API-key helpers — not duplicated here.) The user-facing ones are mirrored in `src/utils/inputLimits.js` for `maxLength` and the tag checks in `App.jsx`; a test fails if the two drift.
- **Types:** fields must be the documented type — a number where a string belongs is a 400, never coerced or silently skipped. Bookmark create/update go through `validateBookmarkInput` (`tags`: omitted = keep, `null` = clear, otherwise an array of single-word strings). Tag writes use `upsertTagNamesStatement`/`linkTagNamesStatement` inside the caller's batch, never per-tag round trips.
- **Per-account budgets** for expensive routes are `USER_RATE_LIMITS`, counted from `auth_events` by `user_id` via `isUserBudgetExhausted` (metadata lookups 60/10 min and 1000/day; imports 20/hour). Same soft-limit and fail-open semantics as `AUTH_RATE_LIMITS`; these rows are pruned after a day and hidden from the admin auth log. `0017_user_budget_index.sql` only adds the index they use.

**Bulk import** (`POST /bookmarks/import`) validates every row first, then writes accepted rows in chunks of 250, each one batch of three statements: upsert the chunk's tag names; insert its bookmarks with the free-plan guard inside the statement (paid, or `key < 50 − current count`, so concurrent imports and saves can't share the same remaining slots), in descending key order so each row's id is `MAX(id) − key`; then link tags for the admitted rows only (`bm.key < changes()`, so the link statement must stay directly after the insert), with the join re-checking owner and URL. Rows are skipped as `invalid` (with `invalidRows` reasons), `duplicates` (already saved, or repeated in the file), or over the free-plan limit (`limitReached`); over-long titles/descriptions are truncated (`truncated`) and bad/surplus tags dropped (`droppedTags`). A chunk lands whole or not at all; if one fails the response is a 500 with the counts so far, and re-importing the same file is safe. The response keeps `imported`/`skipped`/`limitReached`/`membership_tier`/`bookmark_limit` for `Import.jsx`; the rest is additive.

## Scraped page metadata: decode entities, don't trust the regex

`fetchSiteMetadata` only fetches public http(s) destinations: it refuses credentials in the URL, `localhost`/single-label/`.local`/`.internal`-style names and private, loopback, link-local, CGNAT, multicast and IPv4-mapped/NAT64 IP literals; follows at most 5 redirects **by hand** (`redirect: 'manual'`), re-checking each `Location`; requires `text/html` or `application/xhtml+xml`; and streams at most 512 KB, stopping at `</head>`, all under the 8-second deadline. Hostnames are not DNS-resolved (Workers has no resolver and can't reach private networks anyway), so a public name pointing at a private address is only stopped by the platform. Scraped titles/descriptions are clamped to the bookmark limits.


`fetchSiteMetadata` / `extractPageTitle` / `extractMetaDescription` scrape titles and descriptions out of raw HTML with regexes (Workers has no `DOMParser`). Two things bite here:

- **HTML attribute values arrive entity-encoded.** A page serving `theorycraft &amp; simulations ... don&#x27;t` would otherwise persist those escapes into D1 verbatim and show them raw in the edit form. Everything scraped goes through `cleanScrapedText` (decode → collapse whitespace → trim), which uses the local `decodeHtmlEntities` helper + `HTML_NAMED_ENTITIES` table. Add new named entities there rather than decoding ad hoc at a call site, and keep it a **single** decode pass — decoding repeatedly is how `&amp;lt;` turns into a real `<`.
- **The meta-tag patterns capture the opening quote and back-reference it** (`content=(["'])([\s\S]*?)\1`, value in group **2**, not 1). The earlier `[^"']+` form truncated at the first apostrophe, so `Tom's diner & bar` stored as `Tom`. Preserve the back-reference if you add more patterns.

The browser extension's popup reads meta tags from the live page DOM (already decoded) and only falls back to this endpoint, so it inherits fixes here for free. The frontend also has its own `src/utils/decodeHtmlEntities.js` (textarea-based) applied at *display* time and when opening the edit form — that's legacy-data cover for rows saved before the backend decoded, not the primary fix. Such rows self-heal when edited and saved.

## Email sending: Cloudflare Email Sending (not Resend)

All transactional email goes through the **Cloudflare Email Sending REST API** (no SDK, plain `fetch`) via the `sendEmail` helper in `functions/api/[[path]].js`, used by `sendVerificationEmail`, `sendPasswordResetEmail`, and the support-form handler. Config is `CLOUDFLARE_API_TOKEN` / `CLOUDFLARE_ACCOUNT_ID` / `EMAIL_REPLY_TO` / `SUPPORT_EMAIL` (see `.dev.vars.example`). `sendEmail` throws if the token/account ID are unset, and callers turn that into a `503`.

Each email purpose has its own "from" address via `emailFrom(purposeVar, fallback, env)`:

- `EMAIL_FROM_VERIFICATION` (default `welcome@tagsta.sh`)
- `EMAIL_FROM_PASSWORD_RESET` (default `support@tagsta.sh`)
- `EMAIL_FROM_CONTACT` (default `contact@tagsta.sh`) — the support form's outgoing *sender*, not to be confused with `SUPPORT_EMAIL`, the inbox it delivers *to*.

Each falls back to the generic `EMAIL_FROM` before its hardcoded default, so self-hosters on another domain can override with one var instead of three.

## Fixed upstream calls: deadlines, 502/503, idempotency

Email, Turnstile siteverify and Stripe go through `fetchUpstream(service, url, options)`, which adds an `AbortSignal.timeout` deadline from `UPSTREAM_TIMEOUT_MS` (email 10s, Turnstile 5s, Stripe 15s) and turns network failures/timeouts into `UpstreamError`. `sendEmail` and `stripeRequest` also throw `UpstreamError` for provider error responses (Stripe's message is kept, so `isStripeMissingResourceError` still works). The status convention: **503** = not configured (`EmailNotConfiguredError`, missing Stripe/Turnstile keys), **502** = the provider failed or timed out. `routeRequest`'s catch answers any uncaught `UpstreamError` with a 502 and a per-service message; routes that report send failures use `emailFailureStatus(error)`. Don't add a bare `fetch` to a fixed upstream. (`fetchSiteMetadata` fetches arbitrary user URLs and has its own handling.)

Object-creating Stripe POSTs (`/customers`, `/checkout/sessions`) send an `Idempotency-Key` from `stripeIdempotencyKey(purpose, userId, parts)`: user id + hour bucket + a hash of the exact parameters, so a retry after a timeout gets the original object back, while different parameters never reuse a key (Stripe rejects that). Checkout keys also hash `users.updated_at`, which the webhook bumps, so a completed session is never replayed. Recreating a customer Stripe no longer knows passes the stale id into the key so the deleted customer isn't replayed. Customer updates and portal sessions send no key.

## Turnstile: success, hostname and action

`verifyTurnstile(request, env, token, expectedAction)` accepts a token only if siteverify says `success: true`, the `hostname` is the request's own host or `APP_URL`'s (`turnstileHostnames`; covers Pages previews), and `action` matches. The support widget renders with `action: 'support'` (`TURNSTILE_SUPPORT_ACTION`); keep `SupportPage.jsx` and the constant in sync. Local HTTP requests skip only the hostname check, since test sitekeys report a placeholder hostname.

Integration notes ([REST API docs](https://developers.cloudflare.com/email-service/api/send-emails/rest-api/)):

- `POST https://api.cloudflare.com/client/v4/accounts/{account_id}/email/sending/send`, `Authorization: Bearer <token>`, token scoped to `Email Sending: Edit`.
- Reply-to is the **snake_case top-level field `reply_to`** — confirmed by live testing. `replyTo` 400s with `invalid_request_schema`, and a `headers: { 'Reply-To': ... }` object 400s with `email.invalid`; neither is documented clearly, so don't reintroduce them. The support form's "reply goes to the requester" behavior depends on this.
- 5 MiB total message size limit (incl. attachments); rate-limited (error code 10004).
- Beta product — the `from` sending domain must be connected/verified in the Cloudflare dashboard first.
- Migrated from Resend on 2026-08-02; the `resend` npm package is gone from `package.json`.

## D1 migrations: guard new columns, don't assume they exist

Cloudflare Pages deploys the Worker bundle **independently** of `wrangler d1 migrations apply` — there's no auto-migrate-on-deploy hook, so code can reach prod before its migration has been applied there. For any path that references a newly-added column *by name* (filtering, inserting, toggling — not `SELECT *`), guard it:

```js
const hasFoo = await bookmarksTableHasColumn(db, 'foo'); // or usersTableHasColumn
```

and fail closed (404/503) rather than letting an unguarded reference 500 every request that touches that table. `is_favorite`, `is_private`, `profile_public`, `theme`, `link_target`, `last_login_at` and `suspended_at` all follow this pattern — copy it for new boolean/nullable columns on `users` or `bookmarks`. (`0007_password_reset.sql`'s `password_reset_tokens` table is the one deliberate exception — narrow blast radius, only two rarely-hit routes.) Note `is_favorite` on `bookmarks` is guarded via a pre-fetched `PRAGMA table_info` set (`bookmarksColumnNames.has('is_favorite')`) rather than a direct `bookmarksTableHasColumn` call at that site — same pattern, different idiom.

Per-bookmark boolean toggles (favorite, private) share one backend helper, `toggleBookmarkFlag(db, userId, bookmarkId, columnName, messages)`, and one frontend helper, `handleBookmarkToggle(apiCall, id, fallbackErrorMessage)` in `App.jsx` — extend those for the next toggle instead of copy-pasting a route/handler pair. `getTagsByBookmarkId(db, userId, { publicOnly, hasIsPrivateColumn })` is the same idea for the tag-join query.

Migrations are sequential numbered files in `d1/migrations/`, applied via `npm run setup:db` locally.

## Free-plan bookmark limit is enforced in the INSERT

`FREE_BOOKMARK_LIMIT` (50) is enforced by `insertBookmarkWithinPlanStatement`, which does `INSERT … SELECT … WHERE tier = 'paid' OR (SELECT COUNT(*) …) < 50` as one statement inside the create batch (`meta.changes` is 0 once the limit is reached, and the tag-link statement after it is gated on `changes() > 0`). A separate count followed by an insert lets parallel saves overshoot. `POST /bookmarks` keeps a cheap pre-check for the error message, but the conditional insert is the control. `POST /bookmarks/import` applies the same guard per chunk (`importChunkStatements`), so concurrent imports and saves share the limit; `tests/free-plan-limit.test.mjs` and `tests/bookmark-import.test.mjs` cover the races with `queryLatency`.

## The `tags` table is global, not per-user

`tags` (`d1/migrations/0001_initial.sql`) has a single global `UNIQUE` `name` column and **no `user_id`** — it was never made per-user in any later migration. One tag row (e.g. id 15, `gaming`) can be shared by many users' bookmarks simultaneously; per-user scoping exists only one level down, via `bookmark_tags` joined to `bookmarks.user_id`. This matters for any endpoint that mutates or deletes a `tags` row directly (rename, delete, merge — see `POST /bookmarks/tags/merge` for the reference pattern):

- Never trust a client-supplied tag id as "belongs to this user" — verify with `SELECT COUNT(*) FROM bookmark_tags bt JOIN bookmarks b ON bt.bookmark_id = b.id WHERE bt.tag_id = ? AND b.user_id = ?` before acting on it. `POST /bookmarks/tags/:id/favorite` enforces this scope; it also permits removal of the requesting user's stale favorite without disclosing a foreign tag name.
- Only remove the user's *own* `bookmark_tags` rows, never `DELETE FROM tags WHERE id = ?` unconditionally. Delete the `tags` row only when orphaned: `DELETE FROM tags WHERE id = ? AND NOT EXISTS (SELECT 1 FROM bookmark_tags WHERE tag_id = ?)`.
- `favorite_tags` is already per-user (`user_id, tag_id` PK), so clean up the requesting user's row there regardless of whether the global `tags` row gets deleted.

## Token revocation: `requireAuth` re-reads the user

`requireAuth` verifies the JWT and then loads the `users` row on every request, rejecting the token if the account is gone or its `tv` claim doesn't match `users.token_version`. `auth.user` is built from that row, not from the token payload. Call `bumpTokenVersion(db, userId)` to sign a user out everywhere — password change and password reset already do. If the current session should survive (as with password change), sign a fresh token with `signUserToken(user, env, request)` and return it through `sessionResponse(request, data)`; web clients receive a replacement cookie, bearer clients a JSON token. Tokens issued before `0011_token_version.sql` have no `tv` claim and count as version 0.

JWT validation goes beyond the signature: `jwtVerify` pins HS256 and requires `exp` + `iat` (every token ever issued has both), and `hasValidSessionClaims` requires an integer `id`, an integer `tv` if present, `session` absent or `'web'`, `iat` not in the future, and `exp - iat` no longer than the type's lifetime (7 days web, 60 days bearer, plus 60s skew). `signUserToken` has issued `iss: 'tagsta.sh'` / `aud: 'tagstash-api'` since this change, but they are only checked **when present**: bearer tokens without them stay valid for up to 60 days after the deploy that started issuing them. After that window, make them required (`issuer`/`audience` options on `jwtVerify`). Lengthening a session type means raising its cap in `hasValidSessionClaims` too.

The web app sends `X-Tagstash-Client: web` and uses seven-day HttpOnly cookie sessions (`__Host-tagstash-session`, `Secure`, `SameSite=Lax`, no Domain; HTTP loopback uses `tagstash-session` without Secure). The extension still uses 60-day bearer JWTs. `session: 'web'` JWTs are cookie-only; all other JWTs are bearer-only. `onRequest` enforces the custom header and trusted web Origin/Referer/Fetch Metadata on web requests and cookie mutations, exempting the signature-verified Stripe webhook. Do not broaden credentialed CORS to extension or arbitrary origins. The public profile client omits credentials because its stable API keeps wildcard CORS. `POST /auth/session` upgrades legacy web bearer tokens; `POST /auth/logout` clears the cookie. No new session tokens are stored in localStorage.

## Brute-force protection and the `auth_events` log

`0012_login_protection.sql` adds `users.failed_attempts`/`locked_until` (epoch ms) and an `auth_events` table. Login locks an account for 15 minutes after 8 wrong passwords (`recordFailedLogin`, checked via `getLockedUntil` *before* bcrypt), a successful login or password reset clears it, and a locked login answers **429**. Per-IP and per-email caps live in the `AUTH_RATE_LIMITS` table and are counted from `auth_events` by `isAuthRateLimited`; `recordAuthEvent` writes the row, prunes rows older than 30 days, and never throws. Its `console.warn` carries only the event type and internal user id: raw emails and IPs belong in the access-controlled `auth_events` table (disclosed in `PolicyPage.jsx` as the 30-day security log), never in Worker logs. Don't add `console.log` lines that print emails, IPs or whether an account exists; `tests/auth-log-privacy.test.mjs` checks this. Both helpers fail open before the migration is applied, and the lockout helpers read the `SELECT *` user row so absent columns are a no-op — no PRAGMA guard needed on the login path.

The per-account counter is atomic: `recordFailedLogin` increments and locks in one `UPDATE … RETURNING` (never read-modify-write), leaves an already-locked row untouched, and the login handler re-reads `locked_until` after a correct password so a guess in flight during the locking misses is refused. The `AUTH_RATE_LIMITS` event caps are count-then-write **soft limits** that a simultaneous burst can overshoot; the lockout is the hard control. `tests/login-lockout.test.mjs` covers the races.

Routes that re-ask for the current password (`PUT /auth/username|email|password`) must go through `confirmCurrentPassword`, never a bare `bcrypt.compare`: it shares the login counter/lock and the per-IP cap (its failures are logged as `password_confirmation_failed`), and a correct password clears the counter. Call it after cheap input validation so malformed requests don't spend budget. A stolen session guessing therefore also locks the owner's login for 15 minutes; a password reset lifts it.

Throttles are checked **before** the user lookup and count unregistered emails too, so a 429 never reveals whether an account exists — keep it that way when adding limits. Super admins see the log in Settings → Admin (`GET /api/auth/admin/auth-events`, which hides the high-volume `register_attempt`/`verification_resend_requested` rows). `CF-Connecting-IP` is absent in local dev, so per-IP limits don't apply there unless you send the header yourself.

A Cloudflare rate-limiting rule on `/api/auth/login` sits in front of this as a supplement; its block page is HTML, not JSON, which is why `describeAuthError` in `AuthContext.jsx` has a 429 fallback message.

## Personal API keys are not (yet) an auth path

Settings lets users generate/revoke personal API keys (`api_keys` table, `0001_initial.sql`; routes at `GET/POST /api/auth/api-keys`, `DELETE .../api-keys/:id` for revoke, `DELETE .../api-keys/:id/permanent`). Keys are stored **hash-only** (`hashApiKey`, SHA-256) plus a non-secret `key_prefix`/`key_last4` display hint: `POST` returns the plaintext exactly once, and `GET` returns metadata only (`toApiKeyMetadata`). Never reintroduce reversible storage or put key material in a list response. The old AES `encrypted_key` column is legacy: no code reads or writes it, and `0015_api_keys_hash_only.sql` nulls existing values (old keys stay valid as hashes but can't be redisplayed). `API_KEY_ENCRYPTION_SECRET` is no longer used. `POST` refuses a new key once a user has `MAX_ACTIVE_API_KEYS_PER_USER` unrevoked keys. Despite existing, these keys are **not currently wired into `requireAuth`** (the README says so too — keep it honest) — that helper accepts JWT bearer tokens or web session cookies. Don't assume a route documented as requiring auth accepts an API key; it doesn't yet.

## Super-admin role is config-driven, not just a DB flag

`requireSuperAdmin(db, authUser, env)` gates the admin routes (`GET/PATCH/DELETE /api/auth/admin/users*`, the moderation `POST /api/auth/admin/users/:id/{suspend|unsuspend|make-private}`, and `GET /api/auth/admin/auth-events`). On every check it cross-references `SUPER_ADMIN_EMAIL` (and any other configured role mapping) via `isSuperAdminEmail`/`getRoleForEmail`, and self-heals `users.role` to match via `ensureUserRoleMatchesConfig` — so a configured super-admin's role can't be permanently changed through the admin API itself; it'll just resync on the next check. Changing who's a super-admin means changing env config, not just editing the `users` row.

## Profile moderation and the indexing bar

Visibility rules for public profiles live in one module, `functions/_lib/profileVisibility.js` (no `onRequest*` export, so Pages doesn't route it), imported by `GET /api/profiles/:username`, the `/u/:username` SSR and the sitemap. Don't re-derive them inline in one of the three.

- **Visible** = `profile_public = 1` and not suspended. Missing, non-public and suspended profiles all get the *same* 404 (SSR and API); never reveal that an account is suspended.
- **Indexable** = visible and passes `PROFILE_INDEXING_BAR`: verified email, account ≥ 14 days old, ≥ 5 public (non-private) bookmarks. Only indexable profiles are in `/sitemap.xml`. A visible but below-bar profile still renders **200** with `<meta name="robots" content="noindex">` and `X-Robots-Tag: noindex`. Going public is still immediate; the bar only governs indexing. Change the thresholds in that constant only.
- The API returns `profile.indexable` (an additive field) so `PublicProfile.jsx` passes the same `noindex` to `useDocumentMeta` as the SSR. Without it, hydration would remove the server's robots meta. It discloses nothing the page's robots meta doesn't already say.
- **Suspension** (`users.suspended_at`/`suspended_by`, migration `0016`): set by `POST /api/auth/admin/users/:id/suspend`, cleared by `.../unsuspend`. A suspended user can still sign in and use their private library (non-destructive and reversible). `PUT /auth/profile-public` refuses to turn the profile **on** (403 `{ suspended: true }`) but always allows turning it off. `/auth/me` returns `suspended` so Settings → Public Profile can show a notice. Suspending does **not** touch `profile_public`, so lifting a wrongful suspension restores the profile as it was. `.../make-private` sets `profile_public = 0`, and unsuspending never re-publishes it. Super admins can't be suspended.
- Moderation actions go to `auth_events` (`admin_account_suspended`, `admin_account_unsuspended`, `admin_profile_made_private`) with `actor_user_id` naming the admin (also `0016`), shown with a "By admin" column in Settings → Admin. Like every `auth_events` row they're pruned after 30 days; `users.suspended_by` keeps the current suspension's actor.
- Before `0016` is applied: nobody counts as suspended, suspend/unsuspend answer 503, `make-private` still works (it only needs `profile_public`), and events are logged without an actor.
- "Report this profile" on public profiles links to `/support?report=<username>`. `SupportPage` prefills the message with the profile URL; it accepts only a username-like value.

## Changing an account's email is a two-step, inbox-verified flow

`PUT /auth/email` never writes `users.email`/`role`. After the password check it stores a hashed token in `email_change_tokens` (`0014`, fail-closed 503 until applied), mails the link to the **new** address and warns the old one. The link reuses `/verify-email?token=`: `confirmEmailChange` claims the token atomically (signup verification does the same, claiming the token and marking the account verified in one batch before it issues a session), then sets email + `getRoleForEmail` role, clears the user's reset tokens, bumps `token_version`, and issues **no session** (the frontend shows "sign in again"). Keep role promotion behind this confirmation — an unverified address must never change effective privileges.

## Frontend: real client-side routing (react-router-dom)

`src/main.jsx` wraps the app in `<BrowserRouter>`, and `src/App.jsx` (the always-mounted root) renders a `<Suspense><Routes>…</Routes></Suspense>` tree using `useNavigate`/`useParams`/`useSearchParams` — there's no manual `activePage` string or `window.location.pathname` parsing.

A new top-level page means a `<Route path="..." element={...} />` in `App.jsx` plus the imported component. Two things to get right:

- Place it **before** the `/` and `/settings` routes' `user ? … : homeElement` auth gate if it must work for anonymous visitors.
- `React.lazy()`-load it for code-splitting, unless it's needed on first paint (like `Home`).

`/settings` (`Settings.jsx`) and `/tags` (`TagsPage.jsx`) are both dumb content components taking a `pageMode` prop, with `App.jsx` supplying header/footer/nav chrome. Copy that route block — including the `.settings-page-main`/`.settings-page-content` classes that give full width instead of the two-column bookmark-browser layout — for the next authenticated full-page view rather than inventing a new page shell.

Because `App.jsx`'s module-level `import './App.css'` always runs, `App.css`'s classes are globally available without re-importing — `PublicProfile.jsx` and friends intentionally reuse `.app-main`, `.bookmark-card`, `.toolbar`, etc. rather than duplicating styles.

The whole tree is wrapped in an `ErrorBoundary` (`src/components/ErrorBoundary.jsx`, mounted in `src/main.jsx`) so an uncaught render error shows a fallback instead of a white screen. It's a class component (required for `componentDidCatch`) and its fallback uses a plain `<a href="/">`, not `<Link>` — it must render even if the error happened above/outside router context.

## Shared bookmark-browsing UI and app shell

`src/components/BookmarkBrowser.jsx` owns sort/search/tag-filter/pagination state and renders the toolbar + grid + pagination + sidebar `TagCloud`. Both the owner's main view (`App.jsx`) and the public profile (`PublicProfile.jsx`) render it — **don't fork this logic again** for a future read-only or filtered view; add a prop instead. Existing extension points: `renderCard`, `toolbarExtra`, `showFavoritesFilter`, `tags`, `emptyStateMessage`, `initialSelectedTags`/`onSelectedTagsChange`, `focusBookmarkId`.

`focusBookmarkId` short-circuits the search/tag/favorites filters to show only that bookmark (clearing the underlying filter controls as a side effect) and scrolls it into view once rendered — it's how the "Random" toolbar button isolates a single bookmark in edit mode regardless of the active filter. Clear it back to `null` (on cancel/save/refresh) to return to the full list.

`TagCloud.jsx` accepts an optional `tags` prop so it can be fed pre-fetched data instead of self-fetching via the authenticated `/api/bookmarks/tags/all`, and an optional `showActions` prop (default `true`) that hides the add-to-query/favorite icon row where the chips are just a pick-list — `TagsPage.jsx`'s merge picker is the reference usage (`showActions={false}`, `onTagSelect` repurposed to mean "select as source/target" instead of "filter by this tag"). Each rack tag is a noninteractive `.tag-stock` wrapper holding **sibling** native buttons — the name (`aria-pressed`, select), add-to-filter, and favorite (`aria-pressed`). Never nest the action buttons inside an interactive parent (axe `nested-interactive`; a parent key handler swallows their Enter/Space), and keep every chip control at least 24×24 CSS px (WCAG 2.5.8 / axe `target-size`).

`App.jsx`'s bookmark list has a manual refresh button plus a silent 5-minute `setInterval` poll (mirroring the extension sidebar's interval). There is **no** push/webhook/websocket between a bookmark save (e.g. from the extension) and an already-open web app tab — both are plain re-fetches of `GET /bookmarks` + `GET /bookmarks/tags/all`. Don't assume the UI reflects extension-side changes immediately.

`normalizeBookmarkUrl` is duplicated three times — `src/App.jsx`, `functions/api/[[path]].js`, and `../tagstash-extension/lib/bookmark-url.js` — rather than shared, since the extension is a separate deployable with its own bundling. It prefixes a missing `https://` and keeps a trailing slash on bare roots (`https://example.com` → `https://example.com/`); deeper paths are left alone. The "Base URL" button (`handleBaseUrl`/`handleEditBaseUrl` in `App.jsx`, `toBaseUrl` in the extension's `lib/bookmark-url.js`) relies on the same root selection via `new URL(...).origin + "/"`. **Change one copy, change all three**, or site and extension will silently disagree on what gets stored for the same pasted URL.

`src/components/AppHeader.jsx`/`AppFooter.jsx` are the shared page chrome (logo, tagline, theme selector, footer copyright) used by every full-page view. `AppHeader` takes an optional `onLogoClick` — pass it for the authenticated button-based "back to bookmarks" behavior, omit it for a plain `<a href="/">` logo link on anonymous/public pages. Page-specific actions (welcome text, nav buttons, logout, footer links) go through each component's `children`, not by forking the markup.

## Theme system: three CSS-variable themes, account-synced

Three themes — `slate` (neutral grey, default), `midnight` (the original purple-heavy dark theme), and `light` — are three blocks of CSS custom properties in `src/index.css`: bare `:root` (slate), `:root[data-theme='midnight']`, `:root[data-theme='light']`. Every themed color goes through a `--color-*`/`--shadow-*`/`--theme-gradient` variable; there should be no hardcoded theme-sensitive colors in component CSS. `slate` intentionally keeps the purple accent variables matching `midnight` so buttons/links/tags stay on-brand — only neutral surface/background/border/text variables and `--theme-gradient` differ between the two dark themes.

Tags everywhere (cards, tag rack, filters, tag inputs, Tags page, home demo) render with the shared `.tag-stock` class in `index.css`: a soft-violet shipping tag (echoing the logo) with a pointed end and a punched eyelet, colored per theme by `--color-tag-bg`/`--color-tag-bg-hover`/`--color-tag-edge`/`--color-tag-ink`/`--color-tag-ring`, with `.tag-stock--active` for selected (solid violet). Keep `--color-tag-bg` opaque: the point is a separate pseudo-element, so a translucent fill shows a seam where they meet. The eyelet is painted with `--tag-eyelet`, which must match the surface behind the tag (it defaults to `--color-panel`); override it when a tag sits on a different surface. Type is a single family, Archivo: expanded via `--stretch-display` for headlines, normal width everywhere else (tag labels were condensed at first and proved hard to read; keep them at normal width and at least ~0.8rem).

`THEME_ORDER`/`THEME_LABELS`/`THEME_ICONS`/`isValidTheme` live in `src/utils/theme.js`, the single source of truth — import from there rather than hardcoding theme name lists. `src/components/ThemeSelector.jsx` renders the header control: collapsed it shows the active theme's icon, and hovering/focusing expands it (via a JS `expanded` state, not pure CSS `:hover`, so keyboard focus and touch tap work too) into all three options in **fixed** `THEME_ORDER` position — non-active buttons collapse to `max-width: 0` rather than being reordered, so selecting a theme never makes buttons swap places.

⚠️ If you touch `.theme-selector-btn` in `index.css`, watch for specificity traps: a `:first-child`-style override can silently beat a `--hidden`/`--collapsed` modifier of equal-or-lower specificity, leaving phantom padding on whichever button sits first in DOM order. Prefer uniform per-button padding plus a single collapse mechanism over position-based selectors.

`App.jsx` owns the state: `theme` (`useState`, initialized from `localStorage['tagstash-theme']` or `prefers-color-scheme`), applied via `document.documentElement.dataset.theme` in a `useEffect`. `selectTheme(nextTheme)` sets it directly (no cycling) and, when logged in, fires `authAPI.updateTheme(nextTheme)` (`PUT /api/auth/theme`, guarded by `usersTableHasColumn(db, 'theme')` per the migration pattern above) to persist to `users.theme`. A separate effect applies `user.theme` over the local value whenever `user` loads/changes — so a logged-in account's saved theme wins over `localStorage` on that browser, while logged-out visitors still get `localStorage`/system-preference behavior.

## Link-opening preference: same shape as theme, but don't share it with the extension

"Open bookmark links in a new tab / the same tab" (Settings → Preferences) is stored per account in `users.link_target` (`'new' | 'same'`, nullable — `NULL` means never picked), written by `PUT /api/auth/link-target` behind the usual `usersTableHasColumn(db, 'link_target')` guard, and returned by `/auth/login`, `/auth/me`, and the verify-email handler. `App.jsx` owns the state exactly like `theme`: `localStorage['tagstash-link-target']` for first paint and anonymous public-profile visitors, overridden by `user.link_target` once the account loads.

`src/utils/linkTarget.js` is the single source of truth (`LINK_TARGET_ORDER`/`LINK_TARGET_LABELS`/`isValidLinkTarget`/`linkTargetProps`). Apply it by spreading `linkTargetProps(linkTarget)` onto the anchor rather than hardcoding `target="_blank" rel="noopener noreferrer"` — that helper is what drops both attributes for the same-tab case. It's meant for **bookmark URLs only** (the card link, the edit form's "Open" button); site chrome like the footer and marketing links stays `_blank` unconditionally.

The browser extension has its own equivalent setting (sidebar cog → "Open bookmarks in"), stored in `browser.storage.local` and **deliberately never synced with this one** — unlike `theme`, which the extension mirrors from the account. Don't "fix" that asymmetry by making the extension read `user.link_target`.

## Dependency installs

Use `npm ci` on a clean checkout. `.npmrc` sets a 7-day `min-release-age` and `strict-allow-scripts`; `package.json` `allowScripts` denies esbuild/workerd install scripts (not needed). These need npm 11.19+; Cloudflare Pages runs npm 10.9.2, which ignores them and installs from the lockfile. A new dependency with an install script fails the install until reviewed. Workflow and bypass procedure: `docs/supply-chain.md`.

## Local dev workflow

```bash
npm run setup:db   # apply D1 migrations to local wrangler state
npm run dev:all    # Vite (localhost:3000) + wrangler pages dev (127.0.0.1:5000), proxied via /api
```

Gotchas:

- **Email verification can't be exercised locally** unless `CLOUDFLARE_API_TOKEN`/`CLOUDFLARE_ACCOUNT_ID` are set in `.dev.vars` — `POST /api/auth/register` fails at the send step and rolls back the user without them. For a usable authenticated test account, insert a pre-verified user directly into local D1:
  ```bash
  node -e "require('bcryptjs').hash('testpass123', 10).then(console.log)"
  npx wrangler d1 execute tagstash-db --local --command "INSERT INTO users (username, email, password_hash, membership_tier, role, email_verified) VALUES ('testuser', 'test@example.com', '<hash>', 'free', 'user', 1)"
  ```
  then log in via `POST /api/auth/login` to get a JWT.
- **Auth regression checks:** `npm run test:auth` (Node 22.13+), using isolated in-memory SQLite with the real migrations and API handlers. For concurrency tests pass `createAuthEnv({ queryLatency: true })`: each query then waits a macrotask like a real D1 round trip, so parallel requests actually interleave. Without it they run back to back and check-then-act races pass by accident. Mock upstreams by replacing `globalThis.fetch`; `tests/upstream-calls.test.mjs` also shortens `AbortSignal.timeout` to exercise real deadlines quickly. General verification remains `npm run build` plus driving the app. Pure helpers in `functions/api/[[path]].js` (extractors, normalizers) can be exercised without a Worker by slicing the function out of the file into a temp `.mjs` and importing it — cheap way to check parsing changes against real fetched HTML.
- This environment has a working local Playwright setup (Chromium cached under `%LOCALAPPDATA%\ms-playwright\chromium-<rev>\chrome-win64\chrome.exe` — note `chrome-win64`, not `chrome-win`), usable via `playwright-core` installed ad hoc in the scratchpad. Useful for screenshotting/regression-checking both owner and public-profile views. For authenticated flows, drive login or call `/auth/login` with the web-client header and cookie-aware request context. Setting `localStorage['token']` now only exercises the legacy upgrade path.
- Windows Git Bash and Node resolve `/tmp` differently (`/tmp/x` from bash isn't `C:\tmp\x` from Node) — write files Node needs to read into the scratchpad directory instead of `/tmp`.


## Repository scope and work tracking

GitHub Issues is the active backlog: https://github.com/jmusick/tagstash/issues.
Use category and priority labels; link extension work to its tracker at
https://github.com/jmusick/tagstash-extension/issues. Preserve historical audit
dates and distinguish confirmed current behavior from carried-forward observations.

Keep executable website code, runtime assets, developer tooling, and canonical
technical Markdown here. Original artwork, social graphics, raw demo captures,
backups, and historical audit evidence belong outside the source checkout.
The demo seed/render tools require `TAGSTASH_DEMO_WORK_DIR`; pass that same directory
to the recorder. The seed remains local-only. Deployment expectations and the
latest dated integration check live in [docs/deployment.md](docs/deployment.md).

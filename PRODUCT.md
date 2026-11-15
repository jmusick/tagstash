# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

Primary: heavy link savers. Individuals (researchers, developers, hobbyists) with hundreds or thousands of saved links who have outgrown browser folders and need to find things again by topic. They save constantly, often from the browser extension or the phone's share sheet, and come back later to search, filter and tidy.

Secondary, confirmed in the product but not the design center:

- Visitors browsing someone's opt-in public profile (`/u/:username`), read-only and tag-filtered, often arriving from a shared link or search.
- Developers building on a library: personal API keys, the public profile JSON API and RSS feeds (`/developers`).
- Super admins moderating accounts (Settings → Admin).

## Product Purpose

Tagstash is a tag-first bookmark manager. A link is saved once and carries every tag that applies, then is found again by search (with operators), sorting and combinable tag, domain, month, favorite and note filters instead of digging through nested folders. Success is the user retrieving the link they half-remember in seconds, and keeping a large library tidy (merge/rename tags, untagged filter, duplicate finder, bulk edits, trash with restore) without fear of losing anything.

It is a live SaaS with real users and real Stripe billing at https://tagsta.sh/, run by Stone Dragon Media LLC.

## Positioning

All four are confirmed as defining, and future work must not erode any of them:

- **Tags, not folders.** One link appears under every topic it belongs to; tags combine to narrow results, and search operators (`#tag`, `title:`, `created:`, `match:OR`, exclusions) go further.
- **Private and portable.** Bookmarks are private by default; sharing is an explicit opt-in per profile and per bookmark. The whole library (including private bookmarks and notes) exports as HTML, CSV or JSON, imports read the major competitors' formats, and the code is source-available. No lock-in.
- **Cheap and honest.** Every feature is on both plans; Pro only lifts the 50-bookmark free cap, at $3/month or $36/year (the same rate). Copy never overpromises (for example, no promise of instant takedown, and refunds are neither promised nor denied until issue #115 is decided).
- **Open by API and RSS.** A stable, documented public profile API, per-profile and per-tag RSS feeds, and library-scoped personal API keys let people build on their own data.

## Operating Context

- Saving happens mostly outside the web app: the Chrome and Firefox extensions (separate repo, `tagstash-extension`) and the installed web app's Android share target. The web app picks those saves up via a manual refresh and a quiet 5-minute poll, not push.
- Retrieval and housekeeping happen in the web app on desktop and mobile: library (`/`), Tags (`/tags`), Duplicates (`/duplicates`), Trash (`/trash`), Settings (preferences, import/export, API keys, sessions, billing, reset/delete).
- Public surfaces: homepage, `/features`, `/pricing`, `/developers`, `/privacy`, `/support`, and public profiles. Several are server-rendered or prerendered for crawlers, so browser and crawler content must stay aligned.
- Public profiles are embedded on other sites through the API (for example orboro.net and Hidden Lodge fetch it server-side).

## Capabilities and Constraints

- Free plan: 50 live bookmarks, no time limit. Pro: unlimited. Limits per bookmark: 50 tags, title 1000 chars, URL 8192, description 10000, private Markdown note 10000.
- Notes are private, always: never on public profiles, the API, RSS, SSR snapshots or the sitemap.
- Trash keeps deleted bookmarks 30 days; destructive actions confirm with exact counts and offer Undo where possible.
- Three user-selectable themes (Slate default, Midnight, Light), synced to the account; every surface must work in all three.
- Link-opening preference (new tab or same tab) applies to bookmark links only.
- Strict CSP: no inline scripts or styles, no parsed `style="..."` attributes or runtime `<style>` injection, fonts self-hosted, any new third-party origin must be added to `public/_headers` deliberately.
- The public profile API response shape is a compatibility contract.
- Terminology in the UI: bookmarks, tags, library, public profile, Trash, Favorites, Pro / Free plan, API keys.
- Undecided: refund policy (#115); whether anything becomes Pro-only (#113).

## Brand Commitments

- Name: Tagstash (domain tagsta.sh). Owner: Stone Dragon Media LLC. Licence: Tagstash Non-Commercial License (TNCL) v1.0; commercial inquiries to legal@tagsta.sh.
- Existing logo assets in light and dark variants (`public/logo-*.png|webp`), app icons and `public/og-image.jpg`.
- Voice: plain, factual and precise. Copy states exact numbers, limits and consequences, explains privacy plainly, and never inflates claims.

## Evidence on Hand

- Real feature demonstrations captured from the live interface: looping MP4s with poster JPGs in `public/feature-demos/` (save, organize, find, favorites, merge, import, export, extensions, share, privacy, preferences, themes, api).
- Published pricing (`src/content/pricing.js`), FAQ and feature copy (`src/content/`), and the API reference (`src/content/developersApi.js`).
- Absent, and must not be fabricated: testimonials, customer or user counts, logos of customers, press, ratings, benchmarks.

## Product Principles

1. **Retrieval first.** Every surface should make finding a half-remembered link faster; organizing exists to serve finding.
2. **Never lose the user's data.** Destructive actions are reversible where possible, confirmed with exact counts where not, and the full library is always exportable.
3. **Private unless chosen otherwise.** Sharing is opt-in and granular; private content never leaks into public surfaces.
4. **Say exactly what is true.** Limits, prices, caching delays and policies are stated precisely; no promises the system cannot keep.
5. **One feature set for everyone.** Paying lifts a quantity limit, not a capability wall.

## Accessibility & Inclusion

Required standard: WCAG 2.2 AA, in all three themes, on the app and the public pages. Existing commitments to keep: visible keyboard focus, skip links, reduced-motion support (feature demos default to paused), text contrast of at least 4.5:1 via color variables rather than opacity, inline confirmations instead of `window.confirm` where possible, and equal prominence for cookie-consent Accept and Decline. The automated axe audit (`npm run test:a11y`) is retained but paused; run it only when accessibility testing is resumed.

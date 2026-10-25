// Server-renders per-profile <title>/description/OG tags into the SPA shell for
// GET /u/:username, so link previews (Slack, Discord, X, Facebook, etc.) and search
// engines see unique metadata per profile instead of the generic index.html defaults.
// For profiles that pass the indexing bar it also renders a static snapshot of the most
// recent public bookmarks into <div id="ssr-profile">, inserted just before #root, so
// crawlers that don't run JS see real content. Real visitors get the same HTML: CSS hides
// #root while the snapshot is present (`#ssr-profile + #root`, src/App.css), the app mounts
// into the hidden #root, and PublicProfile removes the snapshot in a layout effect once the
// real list is rendered (src/utils/profileSnapshot.js), so there is no loading flash.
// useDocumentMeta (src/utils/useDocumentMeta.js) keeps the head correct on client-side nav.
// Visibility (public, not suspended) and the indexing bar come from the shared helper, so
// this page, GET /api/profiles/:username and the sitemap always agree.
import { findVisibleProfile, getProfileSchema, publicBookmarkCondition } from '../_lib/profileVisibility.js';

const escapeHtml = (value) =>
  String(value).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  }[c]));

// JSON inside a <script> element ends at the first "</script", so "<" (and the other
// characters that can change how the HTML parser or older JS engines read it) is escaped.
const serializeJsonLd = (value) =>
  JSON.stringify(value).replace(/[<>&\u2028\u2029]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);

// Most recent public bookmarks rendered into #ssr-profile for indexable profiles. The full list
// (and filtering/sorting) comes from GET /api/profiles/:username once the app mounts.
export const SSR_BOOKMARK_LIMIT = 100;

// One query: the newest public bookmarks (same order as the profile page's default
// "Date saved, newest first" sort) with each bookmark's tag names as a JSON array.
const recentBookmarksQuery = (schema) => `WITH recent AS (
    SELECT b.id, b.title, b.url, b.created_at FROM bookmarks b
    WHERE b.user_id = ?${publicBookmarkCondition(schema)}
    ORDER BY b.created_at DESC, b.id DESC LIMIT ${SSR_BOOKMARK_LIMIT}
  )
  SELECT r.id, r.title, r.url,
    (SELECT json_group_array(t.name) FROM bookmark_tags bt JOIN tags t ON t.id = bt.tag_id
     WHERE bt.bookmark_id = r.id) AS tags
  FROM recent r ORDER BY r.created_at DESC, r.id DESC`;

// Never throws: a failed snapshot query leaves the page with metadata only.
const fetchRecentBookmarks = async (db, userId, schema) => {
  try {
    const { results } = await db.prepare(recentBookmarksQuery(schema)).bind(userId).all();
    return results || [];
  } catch {
    return [];
  }
};

// Only http(s) URLs become links; anything else (javascript:, data:, unparseable) is
// rendered as plain text. Returns the normalized URL so what's emitted is what was parsed.
export const safeHttpUrl = (value) => {
  try {
    const url = new URL(String(value));
    return url.protocol === 'http:' || url.protocol === 'https:' ? url : null;
  } catch {
    return null;
  }
};

const parseTagNames = (value) => {
  try {
    const names = JSON.parse(value || '[]');
    return Array.isArray(names) ? names.filter((name) => typeof name === 'string' && name).sort() : [];
  } catch {
    return [];
  }
};

const logoPicture = (variant) => `<picture class="logo-picture ssr-logo--${variant}"><source srcset="/logo-${variant}.webp 255w, /logo-${variant}-large.webp 560w" sizes="80px" type="image/webp" /><img src="/logo-${variant}-small.png" alt="Tagstash" width="560" height="440" class="app-header-logo" /></picture>`;

// Mirrors the PublicProfile page shell (AppHeader, .app-main, BookmarkBrowser's toolbar
// height, list and DefaultCard, AppFooter) with the global App.css/index.css classes, so
// the snapshot looks like the page that replaces it. Every user-controlled value is escaped.
export function renderProfileBookmarks(username, bookmarks, totalPublic, now = new Date()) {
  const items = bookmarks.map((bookmark) => {
    const url = safeHttpUrl(bookmark.url);
    const title = escapeHtml(bookmark.title || (url ? url.href : 'Untitled'));
    const titleHtml = url
      ? `<a href="${escapeHtml(url.href)}" rel="ugc nofollow noopener">${title}</a>`
      : title;
    const domain = url ? url.hostname.replace(/^www\./i, '') : '';
    const tags = parseTagNames(bookmark.tags);
    return `<article class="bookmark-card"><div class="bookmark-header"><span class="favicon-slot" aria-hidden="true"></span><h3 class="bookmark-title">${titleHtml}</h3></div>`
      + (domain ? `<div class="bookmark-meta"><span class="bookmark-url">${escapeHtml(domain)}</span></div>` : '')
      + (tags.length ? `<div class="tags">${tags.map((tag) => `<span class="tag-stock">${escapeHtml(tag)}</span>`).join('')}</div>` : '')
      + '</article>';
  });
  const total = Math.max(Number(totalPublic) || 0, bookmarks.length);
  const count = total > bookmarks.length
    ? `${bookmarks.length} most recent of ${total} bookmarks`
    : `${total} ${total === 1 ? 'bookmark' : 'bookmarks'}`;
  const safeUsername = escapeHtml(username);
  // The logo follows the theme App.jsx applies to <html data-theme> on mount; the empty
  // toolbar spacer keeps the heading where it sits once the real search box renders.
  return `<div id="ssr-profile"><div class="app"><header class="app-header"><div class="app-header-brand"><a href="/" class="app-header-logo-btn" title="Back to Tagstash">${logoPicture('dark')}${logoPicture('light')}</a><p class="app-header-tagline">Public bookmarks</p></div></header>`
    + `<main class="app-main"><div class="main-content"><div class="toolbar" aria-hidden="true"><div class="toolbar-row"><div class="search-control ssr-toolbar-spacer"></div></div></div><div class="public-profile-header"><h1>@${safeUsername}&#39;s bookmarks</h1></div>`
    + `<div class="bookmarks-section"><div class="results-bar"><p class="results-count">${count}</p></div><div class="bookmarks-grid">${items.join('')}</div></div></div></main>`
    + `<footer class="app-footer"><span class="footer-copyright">&copy; ${now.getUTCFullYear()} Stone Dragon Media LLC</span><a class="footer-privacy-link" href="/">Create your own Tagstash</a><a class="footer-privacy-link" href="/support?report=${encodeURIComponent(username)}" rel="nofollow">Report this profile</a><a class="footer-privacy-link" href="/developers">Developers</a></footer></div></div>`;
}

export async function onRequestGet({ request, env, params, next }) {
  const response = await next();

  const contentType = response.headers.get('Content-Type') || '';
  if (response.status !== 200 || !contentType.includes('text/html')) {
    return response;
  }

  const origin = new URL(request.url).origin;
  let rawUsername;
  try {
    rawUsername = decodeURIComponent(params.username || '');
  } catch {
    // Malformed percent-encoding can't name a profile; render the not-found metadata.
    rawUsername = '';
  }
  const imageUrl = `${origin}/og-image.jpg`;

  let title = 'Profile Not Found - Tagstash';
  let description = "This profile doesn't exist or isn't public.";
  let found = false;
  // A visible profile below PROFILE_INDEXING_BAR still renders (200) but is noindex.
  let indexable = false;
  // Stored casing of the matched user. Lookup is case-insensitive, so /u/jd and /u/JD
  // both resolve to one profile; canonical, og:url and JSON-LD must name that one
  // address (the stored casing) rather than echoing whatever casing the URL used.
  let canonicalUsername = rawUsername;
  // 404 when the profile doesn't exist, isn't public or is suspended (so crawlers don't index a
  // soft-404); 503 when the lookup itself failed, so a transient D1 error isn't
  // mistaken for a missing profile.
  let status = 404;
  // Static bookmark snapshot placed before #root; only ever set for indexable profiles.
  let snapshotHtml = '';

  try {
    const db = env.DB;
    if (rawUsername) {
      if (!db) throw new Error('DB binding is not configured');
      const schema = await getProfileSchema(db);
      const user = await findVisibleProfile(db, rawUsername, schema);
      if (user) {
        found = true;
        indexable = user.indexable;
        status = 200;
        canonicalUsername = user.username;
        const tagsQuery = `SELECT t.name AS name, COUNT(*) AS cnt FROM bookmark_tags bt
           JOIN bookmarks b ON bt.bookmark_id = b.id
           JOIN tags t ON bt.tag_id = t.id
           WHERE b.user_id = ?${publicBookmarkCondition(schema)}
           GROUP BY t.name ORDER BY cnt DESC LIMIT 5`;

        // The bookmark snapshot is the one extra query, run only for indexable profiles.
        // It is best-effort: if it fails the page degrades to metadata only, not a 503.
        const [{ results }, recentBookmarks] = await Promise.all([
          db.prepare(tagsQuery).bind(user.id).all(),
          indexable ? fetchRecentBookmarks(db, user.id, schema) : [],
        ]);
        const topTags = (results || []).map((row) => row.name);
        if (recentBookmarks.length) {
          snapshotHtml = renderProfileBookmarks(user.username, recentBookmarks, user.public_bookmark_count);
        }

        title = `${user.username}'s Bookmarks - Tagstash`;
        description = topTags.length
          ? `Browse ${user.username}'s public bookmarks on Tagstash, tagged with ${topTags.join(', ')}.`
          : `Browse ${user.username}'s public bookmarks on Tagstash.`;
      }
    }
  } catch {
    // Fall through with the generic not-found title/description below rather than
    // failing the page load over a best-effort metadata lookup.
    title = 'Profile Not Found - Tagstash';
    description = "This profile doesn't exist or isn't public.";
    found = false;
    indexable = false;
    snapshotHtml = '';
    status = 503;
  }

  const pageUrl = `${origin}/u/${encodeURIComponent(canonicalUsername)}`;

  const safeTitle = escapeHtml(title);
  const safeDescription = escapeHtml(description);

  const jsonLd = found
    ? {
        '@context': 'https://schema.org',
        '@type': 'ProfilePage',
        mainEntity: { '@type': 'Person', name: canonicalUsername, url: pageUrl },
      }
    : null;

  const headHtml = `
<meta name="description" content="${safeDescription}" />
<link rel="canonical" href="${escapeHtml(pageUrl)}" />
<meta property="og:type" content="profile" />
<meta property="og:title" content="${safeTitle}" />
<meta property="og:description" content="${safeDescription}" />
<meta property="og:url" content="${escapeHtml(pageUrl)}" />
<meta property="og:image" content="${escapeHtml(imageUrl)}" />
<meta name="twitter:title" content="${safeTitle}" />
<meta name="twitter:description" content="${safeDescription}" />
<meta name="twitter:image" content="${escapeHtml(imageUrl)}" />
${found && indexable ? '' : '<meta name="robots" content="noindex" />'}
${jsonLd ? `<script type="application/ld+json">${serializeJsonLd(jsonLd)}</script>` : ''}
`;

  // index.html already ships default description/canonical/OG/Twitter/JSON-LD tags
  // (and the default og:type/og:site_name/twitter:card apply fine here too) — strip
  // just the ones we're replacing so the response doesn't end up with duplicates.
  const removeSelectors = [
    'meta[name="description"]',
    'link[rel="canonical"]',
    'meta[property="og:type"]',
    'meta[property="og:title"]',
    'meta[property="og:description"]',
    'meta[property="og:url"]',
    'meta[property="og:image"]',
    'meta[name="twitter:title"]',
    'meta[name="twitter:description"]',
    'meta[name="twitter:image"]',
    'script[type="application/ld+json"]',
  ];

  let rewriter = new HTMLRewriter()
    .on('title', {
      element(el) {
        el.setInnerContent(title);
      },
    })
    .on('head', {
      element(el) {
        el.append(headHtml, { html: true });
      },
    });

  // Outside #root, so React never renders over it; #root itself stays empty.
  if (snapshotHtml) {
    rewriter = rewriter.on('#root', {
      element(el) {
        el.before(snapshotHtml, { html: true });
      },
    });
  }

  for (const selector of removeSelectors) {
    rewriter = rewriter.on(selector, {
      element(el) {
        el.remove();
      },
    });
  }

  const transformed = await rewriter.transform(response);
  if (status === 200 && indexable) return transformed;

  // Below-bar profiles stay 200 with noindex. Missing/non-public/suspended ones keep the SPA
  // shell as the body so the app still renders its not-found UI, but answer with a real
  // error status (the noindex meta above stays as belt and braces).
  const headers = new Headers(transformed.headers);
  headers.set('X-Robots-Tag', 'noindex');
  if (status === 503) headers.set('Retry-After', '60');
  return new Response(transformed.body, { status, headers });
}

// HEAD probes (link checkers, some crawlers) must see the same status as GET.
export const onRequestHead = onRequestGet;

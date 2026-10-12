// Server-renders per-profile <title>/description/OG tags into the SPA shell for
// GET /u/:username, so link previews (Slack, Discord, X, Facebook, etc.) and search
// engines see unique metadata per profile instead of the generic index.html defaults.
// Real visitors get the same HTML; React hydrates over it and useDocumentMeta (see
// src/utils/useDocumentMeta.js) keeps things correct on subsequent client-side nav.
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

        const { results } = await db.prepare(tagsQuery).bind(user.id).all();
        const topTags = (results || []).map((row) => row.name);

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

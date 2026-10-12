// Server-renders per-profile <title>/description/OG tags into the SPA shell for
// GET /u/:username, so link previews (Slack, Discord, X, Facebook, etc.) and search
// engines see unique metadata per profile instead of the generic index.html defaults.
// Real visitors get the same HTML; React hydrates over it and useDocumentMeta (see
// src/utils/useDocumentMeta.js) keeps things correct on subsequent client-side nav.

const usersTableHasColumn = async (db, columnName) => {
  const result = await db.prepare('PRAGMA table_info(users)').all();
  return result.results.some((col) => col.name === columnName);
};

const bookmarksTableHasColumn = async (db, columnName) => {
  const result = await db.prepare('PRAGMA table_info(bookmarks)').all();
  return result.results.some((col) => col.name === columnName);
};

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
  const pageUrl = `${origin}/u/${encodeURIComponent(rawUsername)}`;
  const imageUrl = `${origin}/og-image.jpg`;

  let title = 'Profile Not Found - Tagstash';
  let description = "This profile doesn't exist or isn't public.";
  let found = false;

  try {
    const db = env.DB;
    if (db && rawUsername) {
      const hasProfilePublicColumn = await usersTableHasColumn(db, 'profile_public');
      if (hasProfilePublicColumn) {
        const user = await db
          .prepare('SELECT id, username FROM users WHERE LOWER(username) = LOWER(?) AND profile_public = 1')
          .bind(rawUsername)
          .first();

        if (user) {
          found = true;
          const hasIsPrivateColumn = await bookmarksTableHasColumn(db, 'is_private');
          const tagsQuery = hasIsPrivateColumn
            ? `SELECT t.name AS name, COUNT(*) AS cnt FROM bookmark_tags bt
               JOIN bookmarks b ON bt.bookmark_id = b.id
               JOIN tags t ON bt.tag_id = t.id
               WHERE b.user_id = ? AND b.is_private = 0
               GROUP BY t.name ORDER BY cnt DESC LIMIT 5`
            : `SELECT t.name AS name, COUNT(*) AS cnt FROM bookmark_tags bt
               JOIN bookmarks b ON bt.bookmark_id = b.id
               JOIN tags t ON bt.tag_id = t.id
               WHERE b.user_id = ?
               GROUP BY t.name ORDER BY cnt DESC LIMIT 5`;

          const { results } = await db.prepare(tagsQuery).bind(user.id).all();
          const topTags = (results || []).map((row) => row.name);

          title = `${user.username}'s Bookmarks - Tagstash`;
          description = topTags.length
            ? `Browse ${user.username}'s public bookmarks on Tagstash, tagged with ${topTags.join(', ')}.`
            : `Browse ${user.username}'s public bookmarks on Tagstash.`;
        }
      }
    }
  } catch {
    // Fall through with the generic not-found title/description below rather than
    // failing the page load over a best-effort metadata lookup.
    title = 'Profile Not Found - Tagstash';
    description = "This profile doesn't exist or isn't public.";
    found = false;
  }

  const safeTitle = escapeHtml(title);
  const safeDescription = escapeHtml(description);

  const jsonLd = found
    ? {
        '@context': 'https://schema.org',
        '@type': 'ProfilePage',
        mainEntity: { '@type': 'Person', name: rawUsername, url: pageUrl },
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
${found ? '' : '<meta name="robots" content="noindex" />'}
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

  return rewriter.transform(response);
}

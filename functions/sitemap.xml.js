// Dynamic XML sitemap: static marketing pages + public profiles that pass the indexing bar.
import { getProfileSchema, isProfileIndexable, publicBookmarkCondition, visibleProfileCondition } from './_lib/profileVisibility.js';

const STATIC_PATHS = [
  // Content-change dates; update these when editing a page's substantive content.
  { path: '/', lastmod: '2026-10-07' },
  { path: '/features', lastmod: '2026-10-07' },
  { path: '/privacy', lastmod: '2026-10-12' },
  { path: '/support', lastmod: '2026-08-17' },
];

// D1 stores UTC as 'YYYY-MM-DD HH:MM:SS' (or ISO); take the date part directly so the
// server's timezone can't shift it. Anything unparseable yields no lastmod.
const toLastmodDay = (value) => {
  if (!value) return '';
  const direct = /^(\d{4}-\d{2}-\d{2})/.exec(String(value));
  if (direct) return direct[1];
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '' : date.toISOString().slice(0, 10);
};

const xmlEscape = (value) =>
  String(value).replace(/[<>&'"]/g, (c) => ({
    '<': '&lt;',
    '>': '&gt;',
    '&': '&amp;',
    "'": '&apos;',
    '"': '&quot;',
  }[c]));

export async function onRequestGet({ request, env }) {
  const origin = new URL(request.url).origin;
  const db = env.DB;

  const urlEntries = STATIC_PATHS.map(
    ({ path, lastmod }) =>
      `<url><loc>${xmlEscape(origin + path)}</loc><lastmod>${lastmod}</lastmod></url>`
  );

  const schema = db ? await getProfileSchema(db) : null;
  if (schema?.hasProfilePublic) {
    // Only indexable profiles (visible + the PROFILE_INDEXING_BAR quality bar) are listed;
    // suspended and below-bar profiles are left out. lastmod is the newest *public* bookmark
    // change, not users.updated_at (which logins and preference changes bump).
    const { results } = await db
      .prepare(
        `SELECT u.username AS username, u.created_at AS created_at, u.email_verified AS email_verified,
                COUNT(b.id) AS public_bookmark_count,
                MAX(MAX(b.created_at, b.updated_at)) AS last_content_at
         FROM users u LEFT JOIN bookmarks b ON b.user_id = u.id${publicBookmarkCondition(schema)}
         WHERE ${visibleProfileCondition(schema)}
         GROUP BY u.id
         ORDER BY u.id`
      )
      .all();

    const now = Date.now();
    for (const row of results) {
      if (!isProfileIndexable(row, now)) continue;
      const day = toLastmodDay(row.last_content_at);
      const lastmod = day ? `<lastmod>${day}</lastmod>` : '';
      urlEntries.push(`<url><loc>${xmlEscape(`${origin}/u/${encodeURIComponent(row.username)}`)}</loc>${lastmod}</url>`);
    }
  }

  const xml = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urlEntries.join('\n')}\n</urlset>`;

  return new Response(xml, {
    headers: {
      'Content-Type': 'application/xml; charset=utf-8',
      'Cache-Control': 'public, max-age=3600',
    },
  });
}

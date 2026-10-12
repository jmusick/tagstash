// Dynamic XML sitemap: static marketing pages + all public profile URLs.
const STATIC_PATHS = [
  // Content-change dates; update these when editing a page's substantive content.
  { path: '/', lastmod: '2026-10-07' },
  { path: '/features', lastmod: '2026-10-07' },
  { path: '/privacy', lastmod: '2026-09-23' },
  { path: '/support', lastmod: '2026-08-17' },
];

const usersTableHasColumn = async (db, columnName) => {
  const result = await db.prepare('PRAGMA table_info(users)').all();
  return result.results.some((col) => col.name === columnName);
};

const bookmarksTableHasColumn = async (db, columnName) => {
  const result = await db.prepare('PRAGMA table_info(bookmarks)').all();
  return result.results.some((col) => col.name === columnName);
};

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

  if (db && (await usersTableHasColumn(db, 'profile_public'))) {
    // lastmod is the newest *public* bookmark change, not users.updated_at (which logins
    // and preference changes bump). Profiles with no public bookmarks omit lastmod.
    // is_private is guarded like everywhere else: before its migration every bookmark counts.
    const publicOnly = (await bookmarksTableHasColumn(db, 'is_private')) ? ' AND b.is_private = 0' : '';
    const { results } = await db
      .prepare(
        `SELECT u.username AS username, MAX(MAX(b.created_at, b.updated_at)) AS last_content_at
         FROM users u LEFT JOIN bookmarks b ON b.user_id = u.id${publicOnly}
         WHERE u.profile_public = 1
         GROUP BY u.id`
      )
      .all();

    for (const { username, last_content_at: lastContentAt } of results) {
      const day = toLastmodDay(lastContentAt);
      const lastmod = day ? `<lastmod>${day}</lastmod>` : '';
      urlEntries.push(`<url><loc>${xmlEscape(`${origin}/u/${encodeURIComponent(username)}`)}</loc>${lastmod}</url>`);
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

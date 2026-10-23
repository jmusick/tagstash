// Shared rules for who appears where: used by the public profile API
// (functions/api/[[path]].js), the profile SSR (functions/u/[username].js) and the sitemap
// (functions/sitemap.xml.js), so the three can't drift apart. This module exports no
// onRequest* handler, so Pages Functions doesn't route it.
//
// "Visible": profile_public = 1 and not suspended. Anything else is a 404, with the same
//   response as a profile that never existed (suspension is never disclosed).
// "Indexable": visible AND passes the quality bar below. Visible-but-below-bar profiles
//   still render (200) but carry noindex and stay out of the sitemap. The bar only
//   controls indexing; going public is still immediate.

export const PROFILE_INDEXING_BAR = Object.freeze({
  requireVerifiedEmail: true,
  minAccountAgeDays: 14,
  minPublicBookmarks: 5,
});

const DAY_MS = 24 * 60 * 60 * 1000;

const tableColumns = async (db, table) => {
  const result = await db.prepare(`PRAGMA table_info(${table})`).all();
  return new Set((result.results || []).map((column) => column.name));
};

// Column guards (see AGENTS.md "D1 migrations"): code can reach prod before its migration.
// Without profile_public nothing is visible; without suspended_at nobody counts as
// suspended; without is_private every bookmark counts as public; without deleted_at (trash,
// migration 0019) no bookmark is trashed.
export async function getProfileSchema(db) {
  const [users, bookmarks] = await Promise.all([tableColumns(db, 'users'), tableColumns(db, 'bookmarks')]);
  return {
    hasProfilePublic: users.has('profile_public'),
    hasSuspendedAt: users.has('suspended_at'),
    hasIsPrivate: bookmarks.has('is_private'),
    hasDeletedAt: bookmarks.has('deleted_at'),
  };
}

// WHERE fragment selecting visible profiles from `users ${alias}`.
export const visibleProfileCondition = (schema, alias = 'u') =>
  `${alias}.profile_public = 1${schema.hasSuspendedAt ? ` AND ${alias}.suspended_at IS NULL` : ''}`;

// Bookmark filter for public bookmarks of `bookmarks ${alias}`, prefixed with AND: not private
// and not in the trash. A trashed bookmark is never public, whatever its age, so this is a plain
// `deleted_at IS NULL` (the 30-day purge window only matters to the owner's trash view). Every
// public surface (API, SSR, sitemap, the indexing bar's count, admin counts) goes through here.
export const publicBookmarkCondition = (schema, alias = 'b') =>
  (schema.hasIsPrivate ? ` AND ${alias}.is_private = 0` : '') +
  (schema.hasDeletedAt ? ` AND ${alias}.deleted_at IS NULL` : '');

// D1 stores CURRENT_TIMESTAMP as UTC 'YYYY-MM-DD HH:MM:SS' with no zone marker; read it as UTC.
export const parseDbTimestamp = (value) => {
  if (!value) return NaN;
  const text = String(value).trim();
  const sqlite = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2}(?:\.\d+)?)$/.exec(text);
  return Date.parse(sqlite ? `${sqlite[1]}T${sqlite[2]}Z` : text);
};

// `profile` needs email_verified, created_at, public_bookmark_count and, if known, suspended_at.
export function isProfileIndexable(profile, now = Date.now()) {
  if (!profile || profile.suspended_at) return false;
  if (PROFILE_INDEXING_BAR.requireVerifiedEmail && !Number(profile.email_verified)) return false;
  const createdAt = parseDbTimestamp(profile.created_at);
  if (!Number.isFinite(createdAt) || now - createdAt < PROFILE_INDEXING_BAR.minAccountAgeDays * DAY_MS) return false;
  return Number(profile.public_bookmark_count || 0) >= PROFILE_INDEXING_BAR.minPublicBookmarks;
}

// Case-insensitive lookup of a visible profile. Returns null when it is missing, not public
// or suspended (callers must answer all three identically), else the row plus `indexable`.
export async function findVisibleProfile(db, username, schema) {
  if (!schema.hasProfilePublic) return null;
  const row = await db
    .prepare(
      `SELECT u.id, u.username, u.created_at, u.email_verified,
              (SELECT COUNT(*) FROM bookmarks b WHERE b.user_id = u.id${publicBookmarkCondition(schema)}) AS public_bookmark_count
       FROM users u
       WHERE LOWER(u.username) = LOWER(?) AND ${visibleProfileCondition(schema)}`
    )
    .bind(username)
    .first();
  if (!row) return null;
  return { ...row, indexable: isProfileIndexable(row) };
}

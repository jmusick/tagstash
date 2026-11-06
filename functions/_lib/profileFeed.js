// RSS 2.0 feed of a public profile's newest bookmarks, optionally narrowed to one or more tags
// (issue #94). Served by functions/u/[username]/feed.xml.js as GET /u/:username/feed.xml?tag=x.
// This module exports no onRequest* handler, so Pages Functions doesn't route it; the API
// imports profileFeedCacheKey from here so its profile cache purges cover the feed too.
//
// Visibility comes from ./profileVisibility.js like every other public surface: a missing,
// non-public or suspended profile is the same 404, and only public (not private, not trashed)
// bookmarks appear. Feeds select named columns and never include the owner-only `note`.
import { parseDbTimestamp, publicBookmarkCondition } from './profileVisibility.js';
import { profileFeedPath } from '../../src/utils/profileFeed.js';

export { profileFeedPath };

export const FEED_ITEM_LIMIT = 50;
// Same bounds as the profile API's edge cache. More filters than this is a 400 (each one is a
// bound parameter, and D1 caps those); a longer tag can't exist, so it simply matches nothing.
export const FEED_MAX_TAG_FILTERS = 10;
export const FEED_MAX_TAG_LENGTH = 100;
export const FEED_CACHE_TTL_SECONDS = 60;

// Same normalization as the profile API's ?tag= (trimmed, lowercased, de-duplicated,
// first-seen order), and AND semantics like it.
export const parseFeedTags = (url) => [...new Set(
  url.searchParams.getAll('tag').map((tag) => tag.trim().toLowerCase()).filter(Boolean)
)];

// SQLite LOWER() folds ASCII only, so the cache key folds ASCII only too: JS toLowerCase()
// would merge two distinct usernames into one entry.
const asciiLower = (text) => text.replace(/[A-Z]/g, (char) => char.toLowerCase());

// Canonical Cache API key: lowercased username plus the normalized tag list. Cookies, headers
// and any other query parameter are not part of it.
export const profileFeedCacheKey = (origin, username, tags = []) =>
  new Request(new URL(profileFeedPath(asciiLower(username), tags), origin).toString(), { method: 'GET' });

export const isCacheableFeedFilter = (tags) => tags.every((tag) => tag.length <= FEED_MAX_TAG_LENGTH);

// Newest public bookmarks with all their tag names, filtered in SQL so only FEED_ITEM_LIMIT
// rows are read. Each ?tag= adds one EXISTS (AND); tag names compare case-insensitively.
export const feedBookmarksQuery = (schema, tagCount) => {
  const tagFilters = Array.from({ length: tagCount }, () => `
      AND EXISTS (SELECT 1 FROM bookmark_tags ft JOIN tags fn ON fn.id = ft.tag_id
                  WHERE ft.bookmark_id = b.id AND LOWER(fn.name) = ?)`).join('');
  return `WITH recent AS (
    SELECT b.id, b.title, b.url, b.description, b.created_at FROM bookmarks b
    WHERE b.user_id = ?${publicBookmarkCondition(schema)}${tagFilters}
    ORDER BY b.created_at DESC, b.id DESC LIMIT ${FEED_ITEM_LIMIT}
  )
  SELECT r.id, r.title, r.url, r.description, r.created_at,
    (SELECT json_group_array(t.name) FROM bookmark_tags bt JOIN tags t ON t.id = bt.tag_id
     WHERE bt.bookmark_id = r.id) AS tags
  FROM recent r ORDER BY r.created_at DESC, r.id DESC`;
};

// XML 1.0 forbids most C0 control characters even when escaped, and one would make the whole
// feed unparseable, so they are dropped along with lone surrogates.
// eslint-disable-next-line no-control-regex
const INVALID_XML_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;

export const xmlEscape = (value) =>
  String(value)
    .replace(INVALID_XML_CHARS, '')
    .replace(/[<>&'"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' }[c]));

// Only http(s) URLs become item links; anything else (javascript:, data:, unparseable) is left
// out and the item links to the profile instead.
const safeHttpUrl = (value) => {
  try {
    const url = new URL(String(value));
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : null;
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

// RFC 822 dates, as RSS 2.0 requires (Date#toUTCString gives "Mon, 02 Jan 2026 10:00:00 GMT").
const rfc822 = (value) => {
  const time = parseDbTimestamp(value);
  return Number.isFinite(time) ? new Date(time).toUTCString() : '';
};

// `username` is the stored casing; `tags` the normalized filter. Every user-controlled value
// is escaped. Items link to the bookmarked page; the guid is a stable, non-permalink id.
export function renderProfileFeed({ origin, username, tags = [], bookmarks = [], now = new Date() }) {
  const profileUrl = new URL(`/u/${encodeURIComponent(username)}`, origin);
  for (const tag of tags) profileUrl.searchParams.append('tag', tag);
  const selfUrl = new URL(profileFeedPath(username, tags), origin).toString();
  const tagLabel = tags.length ? ` tagged ${tags.join(' + ')}` : '';
  const title = `@${username}'s bookmarks${tagLabel} - Tagstash`;
  const description = `The newest public bookmarks${tagLabel} saved by @${username} on Tagstash.`;
  const newest = bookmarks.length ? rfc822(bookmarks[0].created_at) : '';

  const items = bookmarks.map((bookmark) => {
    const link = safeHttpUrl(bookmark.url) || profileUrl.toString();
    const itemTitle = bookmark.title || safeHttpUrl(bookmark.url) || 'Untitled';
    const pubDate = rfc822(bookmark.created_at);
    const categories = parseTagNames(bookmark.tags).map((tag) => `<category>${xmlEscape(tag)}</category>`).join('');
    return '<item>'
      + `<title>${xmlEscape(itemTitle)}</title>`
      + `<link>${xmlEscape(link)}</link>`
      + (bookmark.description ? `<description>${xmlEscape(bookmark.description)}</description>` : '')
      + categories
      + `<guid isPermaLink="false">${xmlEscape(`${origin}/u/${encodeURIComponent(username)}#bookmark-${bookmark.id}`)}</guid>`
      + (pubDate ? `<pubDate>${pubDate}</pubDate>` : '')
      + '</item>';
  });

  return '<?xml version="1.0" encoding="UTF-8"?>\n'
    + '<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom"><channel>'
    + `<title>${xmlEscape(title)}</title>`
    + `<link>${xmlEscape(profileUrl.toString())}</link>`
    + `<description>${xmlEscape(description)}</description>`
    + `<atom:link href="${xmlEscape(selfUrl)}" rel="self" type="application/rss+xml" />`
    + `<lastBuildDate>${newest || now.toUTCString()}</lastBuildDate>`
    + '<generator>Tagstash</generator>'
    + items.join('')
    + '</channel></rss>\n';
}

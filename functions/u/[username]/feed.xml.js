// GET /u/:username/feed.xml[?tag=x&tag=y]: RSS 2.0 feed of a public profile's newest public
// bookmarks (issue #94). Rendering, the query and the cache key live in
// functions/_lib/profileFeed.js; visibility in functions/_lib/profileVisibility.js, shared with
// the profile API, the /u/:username SSR and the sitemap.
//
// - Missing, non-public and suspended profiles get the same 404 (suspension is never disclosed);
//   malformed percent-encoding is a 404 too. A failed D1 lookup is a 503 with Retry-After.
// - Every response is noindex: a feed is for readers, not search results, and below-bar
//   profiles must not get indexed through it.
// - Successful bodies are kept in the Workers Cache API for 60 s, like the profile API, keyed
//   on the canonical URL. The API's profile purges (turning a profile private, suspension,
//   make-private, renames, deletion) also drop the base feed and its single-tag variants.
// - This is a Function response, so public/_headers doesn't apply: the security headers are set
//   here. CORS is open (`*`), like the public profile API, for web-based feed readers.
import { findVisibleProfile, getProfileSchema } from '../../_lib/profileVisibility.js';
import {
  FEED_CACHE_TTL_SECONDS,
  FEED_MAX_TAG_FILTERS,
  feedBookmarksQuery,
  isCacheableFeedFilter,
  parseFeedTags,
  profileFeedCacheKey,
  renderProfileFeed,
} from '../../_lib/profileFeed.js';

const FEED_CONTENT_TYPE = 'application/rss+xml; charset=utf-8';
// Clients revalidate every time (max-age=0); a shared cache may hold it as long as ours does.
const FEED_CACHE_CONTROL = `public, max-age=0, s-maxage=${FEED_CACHE_TTL_SECONDS}`;
// put() refuses entries without a positive TTL.
const FEED_STORE_CONTROL = `public, max-age=${FEED_CACHE_TTL_SECONDS}, s-maxage=${FEED_CACHE_TTL_SECONDS}`;

const getEdgeCache = () => {
  try {
    return (typeof caches !== 'undefined' && caches.default) || null;
  } catch {
    return null;
  }
};

const baseHeaders = (request) => {
  const headers = new Headers({
    'X-Content-Type-Options': 'nosniff',
    'X-Robots-Tag': 'noindex',
    'Referrer-Policy': 'no-referrer',
    'X-Frame-Options': 'DENY',
    'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'",
    'Access-Control-Allow-Origin': '*',
  });
  if (new URL(request.url).protocol === 'https:') {
    headers.set('Strict-Transport-Security', 'max-age=63072000; includeSubDomains');
  }
  return headers;
};

const respond = (request, status, body, extra = {}) => {
  const headers = baseHeaders(request);
  for (const [name, value] of Object.entries(extra)) headers.set(name, value);
  return new Response(request.method === 'HEAD' ? null : body, { status, headers });
};

const textError = (request, status, message, extra = {}) =>
  respond(request, status, message, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store', ...extra });

const feedResponse = (request, body, cacheStatus) =>
  respond(request, 200, body, {
    'Content-Type': FEED_CONTENT_TYPE,
    'Cache-Control': FEED_CACHE_CONTROL,
    ...(cacheStatus ? { 'X-Tagstash-Cache': cacheStatus } : {}),
  });

// Like runAfterResponse in the API: waitUntil when the runtime has it, else inline.
const afterResponse = (context, task) => {
  const promise = Promise.resolve().then(task).catch((error) => {
    console.error('[profile-feed] cache put failed:', error?.name || 'error');
  });
  if (typeof context?.waitUntil === 'function') {
    context.waitUntil(promise);
    return Promise.resolve();
  }
  return promise;
};

export async function onRequestGet(context) {
  const { request, env, params } = context;
  const url = new URL(request.url);

  let username;
  try {
    username = decodeURIComponent(params.username || '');
  } catch {
    username = '';
  }
  if (!username) return textError(request, 404, 'Not found');

  const tags = parseFeedTags(url);
  if (tags.length > FEED_MAX_TAG_FILTERS) {
    return textError(request, 400, `At most ${FEED_MAX_TAG_FILTERS} tag filters are allowed`);
  }

  const edgeCache = isCacheableFeedFilter(tags) ? getEdgeCache() : null;
  const cacheKey = edgeCache ? profileFeedCacheKey(url.origin, username, tags) : null;
  if (edgeCache) {
    try {
      const hit = await edgeCache.match(cacheKey);
      if (hit && hit.status === 200) return feedResponse(request, await hit.text(), 'HIT');
    } catch (error) {
      console.error('[profile-feed] cache match failed:', error?.name || 'error');
    }
  }

  let body;
  try {
    const db = env.DB;
    if (!db) throw new Error('DB binding is not configured');
    const schema = await getProfileSchema(db);
    const user = await findVisibleProfile(db, username, schema);
    if (!user) return textError(request, 404, 'Not found');
    const { results } = await db
      .prepare(feedBookmarksQuery(schema, tags.length))
      .bind(user.id, ...tags)
      .all();
    body = renderProfileFeed({ origin: url.origin, username: user.username, tags, bookmarks: results || [] });
  } catch {
    return textError(request, 503, 'Feed temporarily unavailable', { 'Retry-After': '60' });
  }

  if (edgeCache) {
    await afterResponse(context, () =>
      edgeCache.put(
        cacheKey,
        new Response(body, { status: 200, headers: { 'Content-Type': FEED_CONTENT_TYPE, 'Cache-Control': FEED_STORE_CONTROL } })
      )
    );
  }
  return feedResponse(request, body, edgeCache ? 'MISS' : null);
}

// Feed validators and some readers probe with HEAD; same status and headers, no body.
export const onRequestHead = onRequestGet;

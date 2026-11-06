// Address of a public profile's RSS feed (issue #94), served by functions/u/[username]/feed.xml.js.
// `tags` narrows it like the profile API's ?tag= (AND). Shared with the Worker
// (functions/_lib/profileFeed.js), so the links and the cache keys use one spelling.
// ?tag= filters as the profile API and the feed read them: trimmed, lowercased, de-duplicated,
// first-seen order.
export const normalizeTagFilters = (values) => [...new Set(
  values.map((tag) => String(tag).trim().toLowerCase()).filter(Boolean)
)]

export const profileFeedPath = (username, tags = []) => {
  const params = new URLSearchParams()
  for (const tag of tags) params.append('tag', tag)
  const query = params.toString()
  return `/u/${encodeURIComponent(username)}/feed.xml${query ? `?${query}` : ''}`
}

export const profileFeedUrl = (username, tags = [], origin = typeof window !== 'undefined' ? window.location.origin : '') =>
  `${origin}${profileFeedPath(username, tags)}`

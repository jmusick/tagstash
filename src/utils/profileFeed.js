// Address of a public profile's RSS feed (issue #94), served by functions/u/[username]/feed.xml.js.
// `tags` narrows it like the profile API's ?tag= (AND). Shared with the Worker
// (functions/_lib/profileFeed.js), so the links and the cache keys use one spelling.
export const profileFeedPath = (username, tags = []) => {
  const params = new URLSearchParams()
  for (const tag of tags) params.append('tag', tag)
  const query = params.toString()
  return `/u/${encodeURIComponent(username)}/feed.xml${query ? `?${query}` : ''}`
}

export const profileFeedUrl = (username, tags = [], origin = typeof window !== 'undefined' ? window.location.origin : '') =>
  `${origin}${profileFeedPath(username, tags)}`

// Pure helpers for the bookmark list filters shared by BookmarkBrowser.

// A bookmark is "untagged" when it has no tags at all. The API returns `tags`
// as an array of { id, name }, but be tolerant of a missing or null value.
export function hasNoTags(bookmark) {
  return !Array.isArray(bookmark?.tags) || bookmark.tags.length === 0
}

export function countUntagged(bookmarks) {
  return Array.isArray(bookmarks) ? bookmarks.filter(hasNoTags).length : 0
}

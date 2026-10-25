// Pure helpers for the bookmark list filters shared by BookmarkBrowser.
import { parseSavedDate } from './bookmarkDisplay.js'
import { getRegistrableDomain } from './domain.js'

// A bookmark is "untagged" when it has no tags at all. The API returns `tags`
// as an array of { id, name }, but be tolerant of a missing or null value.
export function hasNoTags(bookmark) {
  return !Array.isArray(bookmark?.tags) || bookmark.tags.length === 0
}

export function countUntagged(bookmarks) {
  return Array.isArray(bookmarks) ? bookmarks.filter(hasNoTags).length : 0
}

// "Has note": the owner's private note (issue #60) has some non-blank text. Public profile
// bookmarks never carry a note, so this is only meaningful in the owner's library.
export function hasNote(bookmark) {
  return typeof bookmark?.note === 'string' && bookmark.note.trim() !== ''
}

export function countWithNotes(bookmarks) {
  return Array.isArray(bookmarks) ? bookmarks.filter(hasNote).length : 0
}

export function isFavoriteBookmark(bookmark) {
  return Boolean(Number(bookmark?.is_favorite))
}

export function countFavorites(bookmarks) {
  return Array.isArray(bookmarks) ? bookmarks.filter(isFavoriteBookmark).length : 0
}

// Related and the domain picker share the original site grouping, including its
// multi-part suffix list. URL canonicalizes case, ports and IDNs (punycode).
export function getBookmarkDomain(url) {
  if (typeof url !== 'string') return null
  try {
    const parsed = new URL(url)
    if (!['http:', 'https:'].includes(parsed.protocol)) return null
    // IP literals have no registrable domain; keep the complete address.
    if (parsed.hostname.includes(':') || /^\d+\.\d+\.\d+\.\d+$/.test(parsed.hostname)) return parsed.hostname
    return getRegistrableDomain(url) || null
  } catch {
    return null
  }
}

export function countDomains(bookmarks) {
  const counts = new Map()
  for (const bookmark of bookmarks) {
    const domain = getBookmarkDomain(bookmark.url)
    if (domain) counts.set(domain, (counts.get(domain) || 0) + 1)
  }
  return counts
}

// Bucket the instant in the user's LOCAL time zone, including when UTC and
// local time fall in different months/years. Card dates use the same parser.
export function getCreatedMonth(value) {
  const date = parseSavedDate(value)
  if (!date) return null
  return `${String(date.getFullYear()).padStart(4, '0')}-${String(date.getMonth() + 1).padStart(2, '0')}`
}

export function formatCreatedMonth(month) {
  const [year, number] = month.split('-').map(Number)
  // Mid-month avoids midnight transitions at a month boundary in some zones.
  const date = new Date(0)
  date.setFullYear(year, number - 1, 15)
  return date.toLocaleDateString(undefined, { month: 'long', year: 'numeric' })
}

export function countCreatedMonths(bookmarks) {
  const counts = new Map()
  for (const bookmark of bookmarks) {
    const month = getCreatedMonth(bookmark.created_at)
    if (month) counts.set(month, (counts.get(month) || 0) + 1)
  }
  return [...counts].sort(([a], [b]) => b.localeCompare(a))
    .map(([value, count]) => ({ value, count, label: formatCreatedMonth(value) }))
}

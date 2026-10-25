import { INPUT_LIMITS } from './inputLimits.js'
import { parseSavedDate } from './bookmarkDisplay.js'

// One availability decision for both navigation and the route. Free for every owner for now.
export const canUseDuplicateFinder = (user) => Boolean(user)

const TRACKING_PARAMETERS = new Set(['fbclid', 'gclid', 'dclid', 'msclkid'])

// Review-only equivalence, deliberately separate from save/import duplicate detection.
// URL handles host case and scheme-specific default ports. Ignore scheme, one leading www.,
// fragment and one trailing path slash. Preserve path case, non-default ports and the raw
// meaningful query (order, repetitions and encoding included). Never follow redirects.
export function normalizeDuplicateUrl(value) {
  if (typeof value !== 'string') return null
  try {
    const url = new URL(value.trim())
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return null
    const query = url.search.slice(1).split('&').filter((part) => {
      let name
      try { name = decodeURIComponent(part.split('=')[0].replace(/\+/g, ' ')).toLowerCase() }
      catch { return true }
      return !name.startsWith('utm_') && !TRACKING_PARAMETERS.has(name)
    }).join('&')
    return JSON.stringify([url.hostname.replace(/^www\./, ''), url.port, url.pathname.replace(/\/$/, ''), query])
  } catch {
    return null
  }
}

export function findDuplicateGroups(bookmarks) {
  const groups = new Map()
  for (const bookmark of bookmarks) {
    if (bookmark.deleted_at != null) continue
    const key = normalizeDuplicateUrl(bookmark.url)
    if (!key) continue
    if (!groups.has(key)) groups.set(key, { key, bookmarks: [] })
    groups.get(key).bookmarks.push(bookmark)
  }
  return [...groups.values()].filter((group) => group.bookmarks.length > 1)
}

// Unknown dates sort after known dates for either shortcut; tied/unknown dates use the id.
export function chooseDuplicateKeeper(bookmarks, order) {
  return [...bookmarks].sort((a, b) => {
    const aTime = parseSavedDate(a.created_at)?.getTime()
    const bTime = parseSavedDate(b.created_at)?.getTime()
    if (aTime == null && bTime != null) return 1
    if (bTime == null && aTime != null) return -1
    const delta = (aTime ?? 0) - (bTime ?? 0) || a.id - b.id
    return order === 'newest' ? -delta : delta
  })[0]?.id ?? null
}

// No valid keeper means no deletion. Each confirmation/Undo fits a single bulk request.
export function duplicateTrashIds(group, keepId) {
  if (!group?.bookmarks.some((bookmark) => bookmark.id === keepId)) return []
  return group.bookmarks.filter((bookmark) => bookmark.id !== keepId)
    .slice(0, INPUT_LIMITS.bulkBookmarkIds).map((bookmark) => bookmark.id)
}

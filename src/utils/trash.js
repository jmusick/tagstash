// Trash (issue #61). Deleting a bookmark moves it to the trash; it can be restored for this many
// days, after which it is gone (the API treats it as missing from the moment it is older than
// this, and purges the row opportunistically). The Worker imports this file too
// (functions/api/[[path]].js), so the number lives in one place.
export const TRASH_RETENTION_DAYS = 30

const DAY_MS = 24 * 60 * 60 * 1000

// D1 stores CURRENT_TIMESTAMP as UTC 'YYYY-MM-DD HH:MM:SS' with no zone marker; read it as UTC.
export const parseTrashTimestamp = (value) => {
  if (!value) return NaN
  const text = String(value).trim()
  const sqlite = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2}(?:\.\d+)?)$/.exec(text)
  return Date.parse(sqlite ? `${sqlite[1]}T${sqlite[2]}Z` : text)
}

// Whole days left before a trashed bookmark is purged, rounded up so a bookmark deleted a moment
// ago says 30, and never below 0. `deletedAt` is the bookmark's deleted_at.
export const daysLeftInTrash = (deletedAt, now = Date.now()) => {
  const deleted = parseTrashTimestamp(deletedAt)
  if (!Number.isFinite(deleted)) return 0
  const msLeft = deleted + TRASH_RETENTION_DAYS * DAY_MS - now
  return Math.max(0, Math.ceil(msLeft / DAY_MS))
}

export const describeDaysLeft = (days) => {
  if (days <= 0) return 'Removed permanently soon'
  return `${days} ${days === 1 ? 'day' : 'days'} left`
}

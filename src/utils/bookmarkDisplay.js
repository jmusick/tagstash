// Display helpers shared by the owner and public-profile bookmark cards.

// "https://www.example.com/docs/" -> "example.com/docs"
export function displayUrl(url) {
  if (!url) return ''
  return url
    .replace(/^[a-z][a-z0-9+.-]*:\/\//i, '')
    .replace(/^www\./i, '')
    .replace(/\/$/, '')
}

// D1 CURRENT_TIMESTAMP is UTC without an offset; imported ISO timestamps may
// include one. Share the instant with month filtering so card dates agree.
export function parseSavedDate(value) {
  if (typeof value !== 'string' || !value.trim()) return null
  const timestamp = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(?:\.\d+)?$/.test(value)
    ? `${value.replace(' ', 'T')}Z`
    : value
  const date = new Date(timestamp)
  return Number.isNaN(date.getTime()) ? null : date
}

export function formatSavedDate(value) {
  const date = parseSavedDate(value)
  if (!date) return ''
  return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })
}

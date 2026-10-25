import { unescapeCsvField } from './bookmarkExport.js'

// File parsers for Settings → Import that don't need the DOM (the Netscape HTML parser uses
// DOMParser and stays in Import.jsx). Each returns bookmark objects for POST /bookmarks/import,
// which validates every row again: { title, url, description, tags, note? }.

// Parse a single CSV line, handling quoted fields with embedded commas/newlines.
function parseCSVLine(line) {
  const fields = []
  let inQuotes = false
  let current = ''

  for (let i = 0; i < line.length; i++) {
    const ch = line[i]
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') {
        current += '"'
        i++
      } else {
        inQuotes = !inQuotes
      }
    } else if (ch === ',' && !inQuotes) {
      fields.push(current)
      current = ''
    } else {
      current += ch
    }
  }
  fields.push(current)
  return fields
}

const toTag = (value) => value.trim().toLowerCase().replace(/\s+/g, '-')

// Parses a Raindrop.io CSV export, or a CSV exported by Tagstash itself, into bookmark objects.
// Returns null when the file has no title/url columns.
// - Tagstash exports since notes (issue #60) have a `description` column and a separate `note`
//   column; their formula-guard apostrophes are removed again, so text round-trips exactly.
// - Raindrop files and older Tagstash exports have no `description` column. As before notes
//   existed, `note` (or Raindrop's `excerpt`) becomes the description and nothing becomes a note.
export function parseBookmarksCSV(text) {
  // Normalise line endings
  const raw = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n')

  // Split respecting quoted newlines
  const lines = []
  let current = ''
  let inQuotes = false
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i]
    if (ch === '"') {
      if (inQuotes && raw[i + 1] === '"') {
        current += '""'
        i++
      } else {
        inQuotes = !inQuotes
        current += ch
      }
    } else if (ch === '\n' && !inQuotes) {
      lines.push(current)
      current = ''
    } else {
      current += ch
    }
  }
  if (current.trim()) lines.push(current)

  if (lines.length < 2) return []

  const headers = parseCSVLine(lines[0]).map((h) => h.trim().toLowerCase())
  const col = (name) => headers.indexOf(name)

  const idxTitle = col('title')
  const idxDescription = col('description')
  const idxNote = col('note')
  const idxExcerpt = col('excerpt')
  const idxUrl = col('url')
  const idxFolder = col('folder')
  const idxTags = col('tags')

  if (idxTitle === -1 || idxUrl === -1) return null // Not a Raindrop CSV

  const tagstashFormat = idxDescription !== -1
  const field = (fields, index) => {
    if (index === -1) return ''
    const value = fields[index] ?? ''
    return tagstashFormat ? unescapeCsvField(value) : value
  }

  const bookmarks = []

  for (let i = 1; i < lines.length; i++) {
    if (!lines[i].trim()) continue
    const fields = parseCSVLine(lines[i])

    const title = field(fields, idxTitle).trim()
    const url = field(fields, idxUrl).trim()
    if (!title || !url) continue

    let description
    let note = null
    if (tagstashFormat) {
      description = field(fields, idxDescription).trim() || null
      // Kept as written: leading whitespace can be Markdown.
      const noteText = field(fields, idxNote)
      note = noteText.trim() ? noteText : null
    } else {
      const legacyNote = field(fields, idxNote).trim()
      const excerpt = field(fields, idxExcerpt).trim()
      description = legacyNote || excerpt || null
    }

    const folder = field(fields, idxFolder).trim()
    const tagsRaw = field(fields, idxTags).trim()

    const tags = tagsRaw
      .split(',')
      .map(toTag)
      .filter((t) => t.length > 0)

    // Add folder as a tag when it's meaningful
    if (folder && folder.toLowerCase() !== 'unsorted') {
      const folderTag = folder.toLowerCase().replace(/\s+/g, '-')
      if (!tags.includes(folderTag)) tags.push(folderTag)
    }

    bookmarks.push(note ? { title, url, description, tags, note } : { title, url, description, tags })
  }

  return bookmarks
}

// Parses Tagstash's JSON export ({ version: 1, bookmarks: [...] }). Returns null when the file
// isn't one. Only the fields the import route accepts are kept (favorite/private flags and dates
// are not imported, the same as every other source).
export function parseTagstashJSON(text) {
  let data
  try {
    data = JSON.parse(text)
  } catch {
    return null
  }
  const rows = Array.isArray(data?.bookmarks) ? data.bookmarks : null
  if (!rows) return null

  const bookmarks = []
  for (const row of rows) {
    if (!row || typeof row !== 'object') continue
    const title = typeof row.title === 'string' ? row.title.trim() : ''
    const url = typeof row.url === 'string' ? row.url.trim() : ''
    if (!title || !url) continue
    const tags = (Array.isArray(row.tags) ? row.tags : [])
      .map((tag) => (typeof tag === 'string' ? tag : tag?.name))
      .filter((tag) => typeof tag === 'string')
      .map(toTag)
      .filter(Boolean)
    const description = typeof row.description === 'string' && row.description.trim() ? row.description : null
    const note = typeof row.note === 'string' && row.note.trim() ? row.note : null
    bookmarks.push(note ? { title, url, description, tags: [...new Set(tags)], note } : { title, url, description, tags: [...new Set(tags)] })
  }
  return bookmarks
}

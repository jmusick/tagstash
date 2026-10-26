import { unescapeCsvField } from './bookmarkExport.js'

// File parsers for Settings → Import. None need the DOM, so they run under node tests. Each
// returns bookmark objects for POST /bookmarks/import, which validates every row again:
// { title, url, description, tags, note? }. A parser returns null when the file doesn't look
// like the chosen source and [] when it does but has no usable rows.

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

// Splits CSV text into raw records, keeping newlines inside quoted fields.
function splitCsvRecords(text) {
  // Normalise line endings (and drop a BOM)
  const raw = text.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n').replace(/\r/g, '\n')

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
  return lines
}

// Reads a CSV into { headers (trimmed, lowercased), rows (arrays of fields) }.
function readCsv(text) {
  const lines = splitCsvRecords(text)
  if (lines.length === 0) return { headers: [], rows: [] }
  return {
    headers: parseCSVLine(lines[0]).map((h) => h.trim().toLowerCase()),
    rows: lines.slice(1).filter((line) => line.trim()).map(parseCSVLine),
  }
}

const toTag = (value) => value.trim().toLowerCase().replace(/\s+/g, '-')
const toTags = (values) => [...new Set(values.map((v) => toTag(String(v))).filter(Boolean))]


// Parses a Raindrop.io CSV export, or a CSV exported by Tagstash itself, into bookmark objects.
// Returns null when the file has no title/url columns.
// - Tagstash exports since notes (issue #60) have a `description` column and a separate `note`
//   column; their formula-guard apostrophes are removed again, so text round-trips exactly.
// - Raindrop files and older Tagstash exports have no `description` column. As before notes
//   existed, `note` (or Raindrop's `excerpt`) becomes the description and nothing becomes a note.
export function parseBookmarksCSV(text) {
  const lines = splitCsvRecords(text)

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

// --- Other services -------------------------------------------------------------------------
// Read/unread/shared/archive status fields are ignored on purpose: no tags are invented from them.

const isWebUrl = (url) => /^https?:\/\//i.test(url)
const textOrNull = (value) => (typeof value === 'string' && value.trim() ? value.trim() : null)

// Pocket CSV (title,url,time_added,tags,status). Tags are separated by `|`. A row without a
// title keeps its URL as the title. Returns null when the columns don't look like a Pocket export.
export function parsePocketCSV(text) {
  const { headers, rows } = readCsv(text)
  const idxTitle = headers.indexOf('title')
  const idxUrl = headers.indexOf('url')
  const idxTags = headers.indexOf('tags')
  if (idxUrl === -1 || idxTitle === -1 || (headers.indexOf('time_added') === -1 && headers.indexOf('status') === -1)) return null

  const bookmarks = []
  for (const fields of rows) {
    const url = (fields[idxUrl] ?? '').trim()
    if (!isWebUrl(url)) continue
    const title = (fields[idxTitle] ?? '').trim() || url
    const tags = toTags(idxTags === -1 ? [] : (fields[idxTags] ?? '').split('|'))
    bookmarks.push({ title, url, description: null, tags })
  }
  return bookmarks
}

// Pinboard JSON export: an array of { href, description (the title), extended (the description),
// tags (space-separated), time, shared, toread }. Returns null when the file isn't one.
export function parsePinboardJSON(text) {
  let data
  try {
    data = JSON.parse(text)
  } catch {
    return null
  }
  if (!Array.isArray(data)) return null
  const isPost = (row) => row && typeof row === 'object' && typeof row.href === 'string'
  if (data.length > 0 && !data.some(isPost)) return null

  const bookmarks = []
  for (const row of data) {
    if (!isPost(row)) continue
    const url = row.href.trim()
    if (!isWebUrl(url)) continue
    const title = textOrNull(row.description) || url
    const tags = toTags(typeof row.tags === 'string' ? row.tags.split(/\s+/) : [])
    bookmarks.push({ title, url, description: textOrNull(row.extended), tags })
  }
  return bookmarks
}

// Folders Instapaper always has; they say nothing about the bookmark, so they aren't tags.
const INSTAPAPER_DEFAULT_FOLDERS = new Set(['unread', 'archive', 'starred'])

// Instapaper CSV (URL,Title,Selection,Folder,Timestamp and, in newer exports, Tags). Tags can be
// a JSON array string like ["a","b"] or a plain comma-separated list. Selection becomes the
// description; a non-default Folder becomes a tag. Returns null for other CSV files.
export function parseInstapaperCSV(text) {
  const { headers, rows } = readCsv(text)
  const idxUrl = headers.indexOf('url')
  const idxTitle = headers.indexOf('title')
  const idxSelection = headers.indexOf('selection')
  const idxFolder = headers.indexOf('folder')
  const idxTags = headers.indexOf('tags')
  if (idxUrl === -1 || idxTitle === -1 || (idxSelection === -1 && idxFolder === -1 && headers.indexOf('timestamp') === -1)) return null

  const bookmarks = []
  for (const fields of rows) {
    const url = (fields[idxUrl] ?? '').trim()
    if (!isWebUrl(url)) continue
    const title = (fields[idxTitle] ?? '').trim() || url

    const tagsRaw = idxTags === -1 ? '' : (fields[idxTags] ?? '').trim()
    let tagList = []
    if (tagsRaw.startsWith('[')) {
      try {
        const parsed = JSON.parse(tagsRaw)
        if (Array.isArray(parsed)) tagList = parsed.filter((tag) => typeof tag === 'string')
      } catch {
        tagList = tagsRaw.split(',')
      }
    } else if (tagsRaw) {
      tagList = tagsRaw.split(',')
    }

    const folder = idxFolder === -1 ? '' : (fields[idxFolder] ?? '').trim()
    if (folder && !INSTAPAPER_DEFAULT_FOLDERS.has(folder.toLowerCase())) tagList.push(folder)

    const description = idxSelection === -1 ? null : textOrNull(fields[idxSelection])
    bookmarks.push({ title, url, description, tags: toTags(tagList) })
  }
  return bookmarks
}

// --- Netscape bookmark HTML (Firefox, Chrome, Safari, Pinboard, Pocket, del.icio.us...) ------

// Latin-1 named entities, in code point order starting at U+00A0 (nbsp ... yuml).
const LATIN1_NAMES = ('nbsp iexcl cent pound curren yen brvbar sect uml copy ordf laquo not shy reg macr deg plusmn sup2 sup3 acute micro para middot cedil sup1 ordm raquo frac14 frac12 frac34 iquest '
  + 'Agrave Aacute Acirc Atilde Auml Aring AElig Ccedil Egrave Eacute Ecirc Euml Igrave Iacute Icirc Iuml ETH Ntilde Ograve Oacute Ocirc Otilde Ouml times Oslash Ugrave Uacute Ucirc Uuml Yacute THORN szlig '
  + 'agrave aacute acirc atilde auml aring aelig ccedil egrave eacute ecirc euml igrave iacute icirc iuml eth ntilde ograve oacute ocirc otilde ouml divide oslash ugrave uacute ucirc uuml yacute thorn yuml').split(' ')

const HTML_ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'",
  ndash: '–', mdash: '—', lsquo: '‘', rsquo: '’', sbquo: '‚', ldquo: '“', rdquo: '”', bdquo: '„',
  hellip: '…', bull: '•', trade: '™', euro: '€', dagger: '†', Dagger: '‡', permil: '‰',
  lsaquo: '‹', rsaquo: '›', prime: '′', Prime: '″', larr: '←', rarr: '→', uarr: '↑', darr: '↓',
  ensp: '\u2002', emsp: '\u2003', thinsp: '\u2009', OElig: 'Œ', oelig: 'œ', Scaron: 'Š', scaron: 'š', Yuml: 'Ÿ', fnof: 'ƒ',
}
LATIN1_NAMES.forEach((name, i) => { HTML_ENTITIES[name] = String.fromCharCode(0xa0 + i) })

// One decode pass, so `&amp;lt;` stays `&lt;`.
function decodeEntities(value) {
  return value.replace(/&(?:#(\d+)|#x([0-9a-f]+)|([a-z]+));/gi, (match, dec, hex, name) => {
    if (name) return HTML_ENTITIES[name] ?? HTML_ENTITIES[name.toLowerCase()] ?? match
    const code = dec ? parseInt(dec, 10) : parseInt(hex, 16)
    try {
      return String.fromCodePoint(code)
    } catch {
      return match
    }
  })
}

function parseAttributes(source) {
  const attrs = {}
  const pattern = /([^\s=/"'<>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g
  let match
  while ((match = pattern.exec(source))) {
    const value = match[2] ?? match[3] ?? match[4] ?? ''
    attrs[match[1].toLowerCase()] = decodeEntities(value)
  }
  return attrs
}

// Folders that every browser adds around the user's own; they aren't tags.
const SKIP_FOLDERS = new Set([
  'bookmarks menu',
  'bookmarks toolbar',
  'bookmarks bar',
  'other bookmarks',
  'mobile bookmarks',
  'imported from firefox',
  'toolbar',
  'bookmarks',
  'menu',
  'favorites',
  'favorites bar',
  'reading list',
])

// True for Netscape-style bookmark HTML, with or without the exact doctype.
export function looksLikeBookmarkHtml(html) {
  if (/NETSCAPE-Bookmark-file/i.test(html)) return true
  if (/<dl[\s>]/i.test(html) && /<a\s[^>]*href\s*=/i.test(html)) return true
  // Pocket's ril_export.html: a plain <ul> of links carrying time_added and tags attributes.
  return /<a\s[^>]*time_added\s*=/i.test(html) || /<title>\s*Pocket Export\s*<\/title>/i.test(html)
}

// Parses Netscape-style bookmark HTML without a DOM, so it tolerates what real exports do:
// unclosed <DT>/<DD>/<p>/<A> tags, TAGS="a,b" and NOTE attributes on <A>, and <DD> descriptions
// after a <DT>. Folder names (the <H3> in front of a <DL>) become tags, except the browsers'
// own root folders. Pocket's old ril_export.html (a plain <ul> list of links) works too.
// Returns null when the text isn't bookmark HTML.
export function parseBookmarksHTML(html) {
  if (typeof html !== 'string' || !looksLikeBookmarkHtml(html)) return null

  const bookmarks = []
  const folderStack = [] // one entry per open <DL>: the folder name it belongs to, or null
  let pendingFolder = null
  let folderText = null // text of the <H3> being read
  let anchor = null // { attrs, text } for the <A> being read
  let descriptionFor = null // bookmark whose <DD> is being read
  let descriptionText = ''
  let lastBookmark = null
  let skipText = false // inside <script>/<style>

  const closeAnchor = () => {
    if (!anchor) return
    const { attrs } = anchor
    const url = (attrs.href || '').trim()
    const title = decodeEntities(anchor.text).replace(/\s+/g, ' ').trim()
    anchor = null
    if (!url || !title || !isWebUrl(url)) {
      lastBookmark = null
      return
    }
    const folderTags = folderStack
      .filter((name) => name && !SKIP_FOLDERS.has(name.toLowerCase()))
      .map((name) => name.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, ''))
    const exportedTags = (attrs.tags || '').split(',')
    const bookmark = { title, url, description: null, tags: toTags([...folderTags, ...exportedTags]) }
    if ((attrs.note || '').trim()) bookmark.note = attrs.note
    bookmarks.push(bookmark)
    lastBookmark = bookmark
  }
  const closeDescription = () => {
    if (!descriptionFor) return
    const text = decodeEntities(descriptionText).trim()
    if (text) descriptionFor.description = text
    descriptionFor = null
    descriptionText = ''
  }
  const closeFolder = () => {
    if (folderText === null) return
    pendingFolder = decodeEntities(folderText).replace(/\s+/g, ' ').trim() || null
    folderText = null
  }

  const tokens = /<!--[\s\S]*?-->|<(\/?)([a-z][a-z0-9]*)((?:[^>"']|"[^"]*"|'[^']*')*)>|[^<]+|</gi
  let token
  while ((token = tokens.exec(html))) {
    const [raw, closing, rawName, rest] = token
    if (!rawName) {
      if (raw.startsWith('<!--') || skipText) continue
      if (anchor) anchor.text += raw
      else if (folderText !== null) folderText += raw
      else if (descriptionFor) descriptionText += raw
      continue
    }
    const name = rawName.toLowerCase()

    if (name === 'script' || name === 'style') {
      skipText = !closing
      continue
    }
    if (skipText) continue

    if (closing) {
      if (name === 'a') closeAnchor()
      else if (name === 'h3') closeFolder()
      else if (name === 'dl') {
        closeAnchor()
        closeDescription()
        folderStack.pop()
      }
      continue
    }

    if (name === 'br' && descriptionFor) {
      descriptionText += '\n'
    } else if (name === 'dl') {
      closeAnchor()
      closeDescription()
      folderStack.push(pendingFolder)
      pendingFolder = null
    } else if (name === 'h3') {
      closeAnchor()
      closeDescription()
      lastBookmark = null
      folderText = ''
    } else if (name === 'a') {
      closeAnchor()
      closeDescription()
      closeFolder()
      anchor = { attrs: parseAttributes(rest), text: '' }
    } else if (name === 'dd') {
      closeAnchor()
      closeDescription()
      if (lastBookmark) descriptionFor = lastBookmark
    } else if (name === 'dt' || name === 'li') {
      closeAnchor()
      closeDescription()
      closeFolder()
    }
  }
  closeAnchor()
  closeDescription()
  return bookmarks
}

// Search operators for the bookmark search box (issue #74). Pure: parse the text once with
// parseSearchQuery, then test each bookmark with matchesSearchQuery. Shared by the owner's
// library and public profiles through BookmarkBrowser.
//
//   word            every plain word must appear (title, link, description, note, tag names)
//   "exact phrase"  the phrase appears as written (case-insensitive, whitespace collapsed)
//   -word -"phrase" excludes bookmarks that contain it; "-" works before any operator
//   #tag #"a tag"   has that tag (whole name, case-insensitive)
//   title:x link:x note:x   only that field; the value may be quoted
//   created:2026 created:2026-10 created:2026-10-05 (local dates, like the month filter)
//   created:>D >=D <D <=D   after/from/before/through that year, month or day ("created:>= D" too)
//   created:A..B    inclusive range, each end a year, month or day; A.. and ..B are open
//   match:OR        the positive terms match with OR; exclusions always exclude
//
// Malformed input never throws: an unmatched quote is ignored, an unknown key (type:, https:) is
// searched as a plain word, and an empty operator ("-", "#", "title:") or a created: value that is
// not a date yet ("created:2", "created:2026-13") is skipped, so the rest of the query still
// applies and a half-typed query never empties the list.
import { decodeHtmlEntities } from './decodeHtmlEntities.js'
import { parseSavedDate } from './bookmarkDisplay.js'

const FIELD_KEYS = new Set(['title', 'link', 'note'])
const KNOWN_KEYS = new Set([...FIELD_KEYS, 'created', 'match'])

const normalizeText = (value) => value.toLowerCase().replace(/\s+/g, ' ').trim()

// Reads a value at `index`: a quoted string when it starts with a quote that is closed later,
// otherwise everything up to the next whitespace (an unmatched opening quote is dropped).
function readValue(input, index) {
  if (input[index] === '"') {
    const close = input.indexOf('"', index + 1)
    if (close !== -1) return { value: input.slice(index + 1, close), end: close + 1 }
    index += 1
  }
  let end = index
  while (end < input.length && !/\s/.test(input[end])) end += 1
  return { value: input.slice(index, end), end }
}

// Splits the raw text into tokens of { negate, prefix, key, value, raw }.
function tokenize(input) {
  const tokens = []
  let i = 0
  while (i < input.length) {
    if (/\s/.test(input[i])) {
      i += 1
      continue
    }
    const start = i
    let negate = false
    if (input[i] === '-') {
      negate = true
      i += 1
    }
    let prefix = null
    let key = null
    if (input[i] === '#') {
      prefix = '#'
      i += 1
    } else {
      const keyMatch = /^([a-z]+):/i.exec(input.slice(i))
      if (keyMatch && KNOWN_KEYS.has(keyMatch[1].toLowerCase())) {
        key = keyMatch[1].toLowerCase()
        i += keyMatch[0].length
      }
    }
    const { value, end } = readValue(input, i)
    i = end
    tokens.push({ negate, prefix, key, value, raw: input.slice(start, end) })
  }
  return tokens
}

// A year, month or day in the visitor's local time zone, as the half-open instant range
// [start, end). Returns null for anything that is not a real calendar date.
export function parseDatePeriod(text) {
  const match = /^(\d{4})(?:-(\d{1,2})(?:-(\d{1,2}))?)?$/.exec(text)
  if (!match) return null
  const year = Number(match[1])
  const month = match[2] === undefined ? null : Number(match[2]) - 1
  const day = match[3] === undefined ? null : Number(match[3])
  // setFullYear (not the Date constructor) so years below 100 are not mapped to 19xx.
  const localDate = (y, m, d) => {
    const date = new Date(0)
    date.setFullYear(y, m, d)
    date.setHours(0, 0, 0, 0)
    return date
  }
  const m0 = month ?? 0
  const d = day ?? 1
  const first = localDate(year, m0, d)
  // Month 13, day 0, Feb 30 and the like roll over into another date: not a real calendar date.
  if (first.getFullYear() !== year || first.getMonth() !== m0 || first.getDate() !== d) return null
  const end = day !== null
    ? localDate(year, m0, d + 1)
    : month !== null ? localDate(year, m0 + 1, 1) : localDate(year + 1, 0, 1)
  return { start: first.getTime(), end: end.getTime() }
}

// created: values -> { from, to } (from inclusive, to exclusive; either may be null = open).
export function parseCreatedRange(text) {
  if (typeof text !== 'string' || !text) return null
  const comparison = /^(>=|<=|>|<)(.+)$/.exec(text)
  if (comparison) {
    const period = parseDatePeriod(comparison[2])
    if (!period) return null
    switch (comparison[1]) {
      case '>': return { from: period.end, to: null }
      case '>=': return { from: period.start, to: null }
      case '<': return { from: null, to: period.start }
      default: return { from: null, to: period.end }
    }
  }
  const dots = text.indexOf('..')
  if (dots !== -1) {
    const left = text.slice(0, dots)
    const right = text.slice(dots + 2)
    if (!left && !right) return null
    const a = left ? parseDatePeriod(left) : null
    const b = right ? parseDatePeriod(right) : null
    if ((left && !a) || (right && !b)) return null
    if (a && b) {
      // A reversed range is read the other way round rather than matching nothing.
      return a.start < b.end ? { from: a.start, to: b.end } : { from: b.start, to: a.end }
    }
    return a ? { from: a.start, to: null } : { from: null, to: b.end }
  }
  const period = parseDatePeriod(text)
  return period ? { from: period.start, to: period.end } : null
}

// Parses the search box text. Never throws: what it cannot read is a plain word or skipped.
// Returns { mode: 'and' | 'or', terms: [{ type, negate, value, field?, range? }] }.
export function parseSearchQuery(input) {
  const result = { mode: 'and', terms: [] }
  if (typeof input !== 'string' || !input.trim()) return result
  const textTerm = (negate, value) => {
    const text = normalizeText(value)
    if (text) result.terms.push({ type: 'text', negate, value: text })
  }

  const tokens = tokenize(input)
  for (let index = 0; index < tokens.length; index += 1) {
    const { negate, prefix, key, value, raw } = tokens[index]
    if (prefix === '#') {
      const tag = normalizeText(value)
      if (tag) result.terms.push({ type: 'tag', negate, value: tag })
      continue
    }
    // Something that is not a usable operator is searched as written (without a leading "-").
    const asText = () => textTerm(negate, negate ? raw.slice(1) : raw)
    if (key === 'match') {
      const mode = value.trim().toLowerCase()
      if (!mode) continue
      if (!negate && (mode === 'or' || mode === 'and')) result.mode = mode
      else asText()
      continue
    }
    if (key === 'created') {
      let text = value.trim()
      // "created:>= 2026-01-01": a bare comparison takes the next plain word as its date, but
      // only when that makes a date, so "created:> rye" still searches for rye.
      const next = tokens[index + 1]
      if (/^(>=|<=|>|<)$/.test(text) && next && !next.negate && !next.prefix && !next.key
        && parseCreatedRange(text + next.value)) {
        text += next.value
        index += 1
      }
      // A value that is not a date (yet) is skipped, like an empty operator, rather than
      // searched as text that no bookmark contains.
      const range = parseCreatedRange(text)
      if (range) result.terms.push({ type: 'created', negate, value: text, range })
      continue
    }
    if (key) {
      const text = normalizeText(value)
      if (text) result.terms.push({ type: 'field', negate, field: key, value: text })
      continue
    }
    textTerm(negate, value)
  }
  return result
}

export function isEmptySearchQuery(query) {
  return !query || query.terms.length === 0
}

// Lowercased, whitespace-collapsed text of each searchable field, built once per bookmark.
// Titles and descriptions are entity-decoded like the cards show them.
function bookmarkText(bookmark) {
  const tags = Array.isArray(bookmark?.tags)
    ? bookmark.tags.map((tag) => (typeof tag?.name === 'string' ? normalizeText(tag.name) : '')).filter(Boolean)
    : []
  return {
    title: normalizeText(decodeHtmlEntities(typeof bookmark?.title === 'string' ? bookmark.title : '')),
    link: normalizeText(typeof bookmark?.url === 'string' ? bookmark.url : ''),
    description: normalizeText(decodeHtmlEntities(typeof bookmark?.description === 'string' ? bookmark.description : '')),
    // The owner's private note; public profile bookmarks never carry one, so note: matches nothing.
    note: typeof bookmark?.note === 'string' ? normalizeText(bookmark.note) : '',
    tags,
  }
}

function termMatches(term, bookmark, text) {
  switch (term.type) {
    case 'tag':
      return text().tags.includes(term.value)
    case 'field':
      return text()[term.field].includes(term.value)
    case 'created': {
      const date = parseSavedDate(bookmark?.created_at)
      if (!date) return false
      const time = date.getTime()
      const { from, to } = term.range
      return (from === null || time >= from) && (to === null || time < to)
    }
    default: {
      // Each field on its own, so a phrase cannot run from the end of one field into the next.
      const { title, link, description, note, tags } = text()
      return [title, link, description, note, ...tags].some((field) => field.includes(term.value))
    }
  }
}

// True when the bookmark satisfies the parsed query. An empty query matches everything.
export function matchesSearchQuery(bookmark, query) {
  if (isEmptySearchQuery(query)) return true
  let cached = null
  const text = () => (cached ??= bookmarkText(bookmark))
  let positives = 0
  let anyPositive = false
  for (const term of query.terms) {
    const hit = termMatches(term, bookmark, text)
    if (term.negate) {
      if (hit) return false
      continue
    }
    positives += 1
    if (hit) anyPositive = true
    else if (query.mode === 'and') return false
  }
  return positives === 0 || query.mode === 'and' || anyPositive
}

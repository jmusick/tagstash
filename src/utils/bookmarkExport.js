const escapeHtml = (value) => String(value ?? '').replace(/[&<>"']/g, (character) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
}[character]))

// Attribute values keep line breaks as character references, so a multi-line note survives a
// Netscape file intact (an HTML parser turns &#10; back into a newline).
const escapeAttribute = (value) => escapeHtml(value).replace(/\r/g, '&#13;').replace(/\n/g, '&#10;')

// Spreadsheet programs execute formula-like fields even when CSV quotes them, so such fields get a
// leading apostrophe. Leading apostrophes already in the text count too, which makes the prefix
// reversible: unescapeCsvField (used when Tagstash reads its own CSV back) drops exactly one.
// That matters for notes, where a Markdown list ("- item") is ordinary text.
const FORMULA_LIKE = /^'*(?:\s*[=+@-]|[\t\r\n])/
const csvField = (value) => {
  let text = String(value ?? '')
  if (FORMULA_LIKE.test(text)) text = "'" + text
  return `"${text.replaceAll('"', '""')}"`
}
export const unescapeCsvField = (text) => (text.startsWith("'") && FORMULA_LIKE.test(text.slice(1)) ? text.slice(1) : text)

const tagNames = (bookmark) => (bookmark.tags || []).map((tag) => typeof tag === 'string' ? tag : tag.name)
const timestamp = (date) => {
  const milliseconds = Date.parse(date)
  return Number.isFinite(milliseconds) ? Math.floor(milliseconds / 1000) : 0
}

// The columns of Tagstash's own CSV export. `description` and `note` are separate columns; files
// exported before notes existed called the description column `note` (src/utils/bookmarkImport.js
// tells the two apart by the `description` header).
export const CSV_EXPORT_FIELDS = ['title', 'url', 'description', 'tags', 'created_at', 'updated_at', 'is_favorite', 'is_private', 'note']

// Exports are the owner's own library: they carry the private note. Nothing public serializes
// bookmarks through here.
export function serializeBookmarks(bookmarks, format) {
  const records = bookmarks.map((bookmark) => ({
    title: bookmark.title,
    url: bookmark.url,
    description: bookmark.description || '',
    tags: tagNames(bookmark),
    created_at: bookmark.created_at,
    updated_at: bookmark.updated_at,
    is_favorite: Boolean(Number(bookmark.is_favorite)),
    is_private: Boolean(Number(bookmark.is_private)),
    note: bookmark.note || '',
  }))
  if (format === 'json') return { content: JSON.stringify({ version: 1, bookmarks: records }, null, 2), type: 'application/json', extension: 'json' }
  if (format === 'csv') {
    const rows = records.map((record) => [record.title, record.url, record.description, record.tags.join(', '), record.created_at, record.updated_at, record.is_favorite ? '1' : '0', record.is_private ? '1' : '0', record.note].map(csvField).join(','))
    return { content: '﻿' + [CSV_EXPORT_FIELDS.join(','), ...rows].join('\r\n'), type: 'text/csv;charset=utf-8', extension: 'csv' }
  }
  if (format === 'html') {
    const links = records.map((record) => {
      // Only active web links belong in a file users will open in their browser.
      if (!/^https?:\/\//i.test(record.url)) return ''
      // The description stays in <DD> (what browsers and other services read); the note goes in a
      // NOTE attribute, like the TAGS extension, so neither is folded into the other. Browsers
      // ignore the attribute, so importing this file into one drops the note but nothing else.
      const note = record.note ? ` NOTE="${escapeAttribute(record.note)}"` : ''
      return `    <DT><A HREF="${escapeHtml(record.url)}" ADD_DATE="${timestamp(record.created_at)}" TAGS="${escapeHtml(record.tags.join(','))}"${note}>${escapeHtml(record.title)}</A>${record.description ? `\n    <DD>${escapeHtml(record.description)}` : ''}`
    }).filter(Boolean)
    return { content: ['<!DOCTYPE NETSCAPE-Bookmark-file-1>', '<META HTTP-EQUIV="Content-Type" CONTENT="text/html; charset=UTF-8">', '<TITLE>Tagstash Bookmarks</TITLE>', '<H1>Tagstash Bookmarks</H1>', '<DL><p>', ...links, '</DL><p>'].join('\n'), type: 'text/html;charset=utf-8', extension: 'html' }
  }
  throw new Error('Unsupported export format')
}

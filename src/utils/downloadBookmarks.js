import { serializeBookmarks } from './bookmarkExport'

// Serializes bookmarks with the shared export formats (html, csv, json) and hands the file to the
// browser. Used by Settings → Export (the whole library) and the library's "Export selected".
// `filenamePrefix` keeps the two downloads apart on disk.
export function downloadBookmarks(bookmarks, format, filenamePrefix = 'tagstash-bookmarks') {
  const file = serializeBookmarks(bookmarks, format)
  const url = URL.createObjectURL(new Blob([file.content], { type: file.type }))
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = `${filenamePrefix}-${new Date().toISOString().slice(0, 10)}.${file.extension}`
  document.body.appendChild(anchor)
  anchor.click()
  anchor.remove()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
  return bookmarks.length
}

// "Open selected in new tabs" helpers.
//
// Browsers only let a page open a pop-up from a user gesture, and many allow just the first
// window per click (Chrome) or a small number (Firefox), so callers must run openUrlsInTabs
// synchronously inside the click handler (no await before it) and then report what was blocked.

// More than this many tabs asks for a confirmation first.
export const BULK_OPEN_CONFIRM_THRESHOLD = 10
// The most tabs one click will open.
export const BULK_OPEN_MAX = 50

// Only web links are ever opened; javascript:, data:, file:, ftp: and anything unparseable are
// skipped. Returns the normalized URLs (in the given order) and how many bookmarks were skipped.
export function getOpenableUrls(bookmarks) {
  const urls = []
  let skipped = 0
  for (const bookmark of bookmarks) {
    let parsed = null
    try {
      parsed = new URL(String(bookmark?.url ?? '').trim())
    } catch {
      parsed = null
    }
    if (parsed && (parsed.protocol === 'http:' || parsed.protocol === 'https:')) {
      urls.push(parsed.href)
    } else {
      skipped += 1
    }
  }
  return { urls, skipped }
}

// Opens each URL in a new tab. `open` is window.open. A null return means the browser blocked
// that pop-up; those URLs are handed back so the UI can offer them as ordinary links. The opener
// is cut on each window we get back (the equivalent of rel="noopener": the opened pages must not
// reach this app through window.opener). `noopener` can't be passed to window.open itself because
// it makes the call return null even on success, which would hide blocked pop-ups.
export function openUrlsInTabs(urls, open = (...args) => window.open(...args)) {
  const blocked = []
  let opened = 0
  for (const url of urls) {
    const win = open(url, '_blank')
    if (win) {
      try {
        win.opener = null
      } catch {
        // A cross-origin window may refuse; it is still open.
      }
      opened += 1
    } else {
      blocked.push(url)
    }
  }
  return { opened, blocked }
}

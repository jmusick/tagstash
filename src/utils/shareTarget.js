// Web Share Target (issue #102). public/manifest.json declares a GET share_target, so an
// installed Tagstash shows up in the OS share sheet and opens /share?title=&text=&url=.
// Android apps often leave `url` empty and put the link inside `text` ("Title https://..."),
// so both are read. main.jsx captures the parameters before React renders and strips them
// from the address bar, so the shared link never sits in history or in an analytics
// page_location; App opens the add form with it once the user is signed in.
import { INPUT_LIMITS } from './inputLimits.js'

export const SHARE_TARGET_PATH = '/share'

const URL_IN_TEXT = /https?:\/\/[^\s<>"]+/i
const TRAILING_PUNCTUATION = /[.,;:!?]+$/

const asText = (value) => (typeof value === 'string' ? value : '')

const httpUrl = (value) => {
  const candidate = value.trim()
  if (!/^https?:\/\//i.test(candidate) || candidate.length > INPUT_LIMITS.url) return ''
  try {
    const parsed = new URL(candidate)
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? candidate : ''
  } catch {
    return ''
  }
}

// A link found in free text loses sentence punctuation after it, and a closing parenthesis
// unless the URL opened one itself (Wikipedia-style "Foo_(bar)").
const trimFoundUrl = (raw) => {
  let url = raw
  for (;;) {
    const trimmed = url.replace(TRAILING_PUNCTUATION, '')
    const unbalanced = trimmed.endsWith(')') && (trimmed.match(/\(/g) || []).length < (trimmed.match(/\)/g) || []).length
    const next = unbalanced ? trimmed.slice(0, -1) : trimmed
    if (next === url) return url
    url = next
  }
}

const cleanTitle = (value) => value.replace(/\s+/g, ' ').trim().slice(0, INPUT_LIMITS.title)

/**
 * Turns share-target query parameters into `{ url, title }`, or null when nothing usable
 * was shared. `url` is '' when the share carried no http(s) link.
 */
export function parseSharedLink(params) {
  const get = (name) => asText(params?.get?.(name))
  const sharedTitle = get('title')
  const text = get('text')

  let url = httpUrl(get('url'))
  let remainingText = text
  if (!url) {
    const match = text.match(URL_IN_TEXT)
    if (match) {
      const found = httpUrl(trimFoundUrl(match[0]))
      if (found) {
        url = found
        remainingText = text.replace(found, ' ')
      }
    }
  } else {
    remainingText = text.replace(url, ' ')
  }

  let title = cleanTitle(sharedTitle)
  if (!title || title === url) title = cleanTitle(remainingText)

  if (!url && !title) return null
  return { url, title }
}

let pendingSharedLink = null

const isSharePath = (pathname) => (pathname.replace(/\/+$/, '') || '/') === SHARE_TARGET_PATH

/**
 * Reads a share-target visit once, at startup, and replaces the address with a bare /share.
 * Kept in memory only: a reload before signing in drops it, which is the safer failure.
 */
export function captureSharedLink(win = typeof window === 'undefined' ? null : window) {
  if (!win || !isSharePath(win.location.pathname) || !win.location.search) return null
  pendingSharedLink = parseSharedLink(new URLSearchParams(win.location.search))
  try {
    win.history.replaceState(win.history.state, '', SHARE_TARGET_PATH + win.location.hash)
  } catch {}
  return pendingSharedLink
}

export const peekSharedLink = () => pendingSharedLink

export const clearSharedLink = () => {
  pendingSharedLink = null
}

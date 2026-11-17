// The web session is an HttpOnly cookie, so the app can't tell on first paint whether the
// visitor is signed in; it finds out from GET /auth/me. Until then it needs a guess, or a
// signed-in visitor sees the signed-out loading screen flash before their library.
//
// - functions/index.js marks <html data-session="present|absent"> on GET /, where the
//   server saw the request's cookies. That answer wins when it's there.
// - Everywhere else, the outcome of the last session check on this browser, kept in
//   localStorage by AuthContext.
//
// It's only a guess for the loading screen. Nothing is shown or allowed because of it.
export const SESSION_HINT_KEY = 'tagstash-session-hint'

// Routes whose content depends on being signed in; the rest render the same either way.
export const SIGNED_IN_PATHS = new Set(['/', '/settings', '/tags', '/trash', '/duplicates', '/share'])

export function expectSignedIn() {
  if (typeof document === 'undefined') return false
  const fromServer = document.documentElement.dataset.session
  if (fromServer === 'present') return true
  if (fromServer === 'absent') return false
  try {
    return localStorage.getItem(SESSION_HINT_KEY) === '1'
  } catch {
    return false
  }
}

export function rememberSignedIn(signedIn) {
  try {
    if (signedIn) localStorage.setItem(SESSION_HINT_KEY, '1')
    else localStorage.removeItem(SESSION_HINT_KEY)
  } catch {
    // Storage blocked: the next load just falls back to the signed-out loading screen.
  }
}

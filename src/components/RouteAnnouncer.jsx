import { useEffect, useRef, useState } from 'react'
import { useLocation } from 'react-router-dom'

// Client-side navigation swaps the page without a document load, so assistive
// tech hears nothing and keyboard focus stays on the (possibly unmounted) link
// that was activated. After each route change this moves focus to #main (every
// view renders <main id="main" tabIndex={-1}>) and announces the new
// document.title through a polite live region. It deliberately does nothing on
// the initial page load, so it never steals focus from the browser's default.
const MAX_MAIN_WAIT_MS = 2000
const POLL_MS = 50
// Child components set document.title in a passive effect (useDocumentMeta),
// so give those a moment to run before reading it.
const TITLE_SETTLE_MS = 100

function RouteAnnouncer() {
  const { pathname } = useLocation()
  const previousPathname = useRef(pathname)
  const [announcement, setAnnouncement] = useState('')

  useEffect(() => {
    if (previousPathname.current === pathname) return
    previousPathname.current = pathname

    let timer
    let waited = 0
    const focusMain = () => {
      const main = document.getElementById('main')
      if (!main && waited < MAX_MAIN_WAIT_MS) {
        // A lazy route may still be loading its chunk.
        waited += POLL_MS
        timer = setTimeout(focusMain, POLL_MS)
        return
      }
      main?.focus()
      timer = setTimeout(() => setAnnouncement(document.title), TITLE_SETTLE_MS)
    }
    timer = setTimeout(focusMain, 0)

    return () => clearTimeout(timer)
  }, [pathname])

  return (
    <div className="sr-only" role="status" aria-live="polite" aria-atomic="true">
      {announcement}
    </div>
  )
}

export default RouteAnnouncer

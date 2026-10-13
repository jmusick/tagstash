import { useEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { ANALYTICS_ID, GA_MEASUREMENT_ID, ANALYTICS_CONSENT_STORAGE_KEY } from '../utils/analytics'
import './ConsentBanner.css'

// Named ConsentBanner, not CookieConsent: content blockers (uBlock Origin et al.)
// match filter lists against request URLs, and paths containing "cookieconsent"
// hit EasyPrivacy-style rules for third-party consent-management scripts. When
// this module is served as its own file under that name, the request is blocked
// and — since App.jsx imports it — the whole app fails to boot. Keep the name
// neutral, and keep the import in App.jsx failure-tolerant.
//
// Opt-in, and strictly so: gtag.js is not fetched at all until the visitor
// accepts. A banner that loads the tag first and asks second still discloses
// the visitor's IP to Google on page one, which is the thing consent is
// supposed to prevent - so the script element is only created in the accept path.
//
// The choice lives in localStorage, not a cookie, so recording "no" doesn't
// itself store anything a consent regime would object to.
function loadAnalytics() {
  if (!ANALYTICS_ID || window.dataLayer) return

  window.dataLayer = window.dataLayer || []
  function gtag() { window.dataLayer.push(arguments) }

  // Consent Mode defaults are declared before config so the tag never assumes
  // permission for anything beyond the analytics storage granted here.
  gtag('consent', 'default', {
    ad_storage: 'denied',
    ad_user_data: 'denied',
    ad_personalization: 'denied',
    analytics_storage: 'denied',
  })
  gtag('consent', 'update', { analytics_storage: 'granted' })
  gtag('js', new Date())
  gtag('config', ANALYTICS_ID)

  const script = document.createElement('script')
  script.async = true
  script.src = `https://www.googletagmanager.com/gtag/js?id=${ANALYTICS_ID}`
  document.head.appendChild(script)
}

// Withdrawing consent can't unload a running tag - drop its cookies and reload.
function clearAnalyticsCookies() {
  const host = window.location.hostname
  document.cookie.split(';').forEach((entry) => {
    const name = entry.split('=')[0].trim()
    if (!name.startsWith('_ga')) return
    const expiry = '=; Max-Age=0; path=/'
    document.cookie = name + expiry
    document.cookie = `${name}${expiry}; domain=${host}`
    document.cookie = `${name}${expiry}; domain=.${host}`
  })
}

function ConsentBanner() {
  const [visible, setVisible] = useState(false)
  const wasGrantedRef = useRef(false)
  const acceptBtnRef = useRef(null)

  useEffect(() => {
    let stored = null
    try {
      stored = window.localStorage.getItem(ANALYTICS_CONSENT_STORAGE_KEY)
    } catch {
      // Private-browsing modes can throw on access; treat as "no choice yet".
    }

    if (stored === 'granted') {
      wasGrantedRef.current = true
      loadAnalytics()
    } else if (stored !== 'denied') {
      setVisible(true)
    }

    // Any element with data-cookie-preferences reopens the choice - the
    // footer link uses this, and it satisfies "consent must be as easy to
    // withdraw as it was to give".
    const handleReopen = (event) => {
      const trigger = event.target.closest('[data-cookie-preferences]')
      if (!trigger) return
      event.preventDefault()
      setVisible(true)
      requestAnimationFrame(() => acceptBtnRef.current?.focus())
    }

    document.addEventListener('click', handleReopen)
    return () => document.removeEventListener('click', handleReopen)
  }, [])

  const record = (choice) => {
    try {
      window.localStorage.setItem(ANALYTICS_CONSENT_STORAGE_KEY, choice)
    } catch {
      // Choice won't persist, but honour it for this page view.
    }
    setVisible(false)

    if (choice === 'granted') {
      loadAnalytics()
    } else if (wasGrantedRef.current) {
      clearAnalyticsCookies()
      window.location.reload()
    }
    wasGrantedRef.current = choice === 'granted'
  }

  if (!GA_MEASUREMENT_ID || !visible) return null

  return (
    <div
      className="cookie-consent"
      role="dialog"
      aria-modal="false"
      aria-labelledby="cc-title"
      aria-describedby="cc-body"
    >
      <div className="cc-inner">
        <div className="cc-text">
          <p id="cc-title" className="cc-title">Analytics</p>
          <p id="cc-body" className="cc-body">
            Tagstash would like to count visits with Google Analytics, which sets cookies.
            Nothing is sent to Google unless you accept, and the app works the same either
            way. See the <Link to="/privacy">Privacy Policy</Link>.
          </p>
        </div>
        {/* Accept and Decline share one style on purpose: equal prominence, neither is the primary action. */}
        <div className="cc-actions">
          <button type="button" className="cc-btn" onClick={() => record('denied')}>
            Decline
          </button>
          <button
            type="button"
            className="cc-btn"
            ref={acceptBtnRef}
            onClick={() => record('granted')}
          >
            Accept
          </button>
        </div>
      </div>
    </div>
  )
}

export default ConsentBanner

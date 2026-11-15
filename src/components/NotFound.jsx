import { Link } from 'react-router-dom'
import PublicHeader from './PublicHeader'
import AppFooter from './AppFooter'
import { useDocumentMeta } from '../utils/useDocumentMeta'

export default function NotFound({ logoSrc, theme, onSelectTheme, signedIn = false }) {
  useDocumentMeta({ title: 'Page Not Found - Tagstash', noindex: true })
  return (
    <div className="app public-page">
      <PublicHeader signedIn={signedIn} logoSrc={logoSrc} theme={theme} onSelectTheme={onSelectTheme} />
      <main id="main" tabIndex={-1} className="app-main not-found-main">
        <div className="not-found-content">
          <p className="not-found-code" aria-hidden="true">404</p>
          <h1>Page not found</h1>
          <p>This address doesn’t point to a Tagstash page.</p>
          <p>The page may have moved, or the link may be incomplete.</p>
          <div className="not-found-actions">
            <Link className="btn-primary" to="/">{signedIn ? 'Search your bookmarks' : 'Go to the homepage'}</Link>
            <Link className="btn-secondary" to="/support">Get help</Link>
          </div>
        </div>
      </main>
      <AppFooter />
    </div>
  )
}

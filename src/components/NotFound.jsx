import { Link } from 'react-router-dom'
import PublicHeader from './PublicHeader'
import AppFooter from './AppFooter'
import { useDocumentMeta } from '../utils/useDocumentMeta'

export default function NotFound({ logoSrc, theme, onSelectTheme, signedIn = false }) {
  useDocumentMeta({ title: 'Page Not Found - Tagstash', noindex: true })
  return (
    <div className="app public-page">
      <PublicHeader signedIn={signedIn} logoSrc={logoSrc} theme={theme} onSelectTheme={onSelectTheme} />
      <main id="main" tabIndex={-1} className="app-main settings-page-main">
        <div className="settings-page-content">
          <h1>Page not found</h1>
          <p>This address doesn’t point to a Tagstash page.</p>
          <Link to="/">Back to Tagstash</Link>
        </div>
      </main>
      <AppFooter />
    </div>
  )
}

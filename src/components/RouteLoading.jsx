import PublicHeader from './PublicHeader'
import AppFooter from './AppFooter'

// Shared chrome stays visible while authentication or a route chunk loads.
// Static placeholders respect reduced motion without a separate animation mode.
// While a probably-signed-in visitor's session is checked on a page that differs by auth state,
// show nothing visible rather than public chrome the library would replace a moment later.
export function SessionLoading() {
  return (
    <main id="main" tabIndex={-1} aria-busy="true">
      <p className="sr-only" role="status">Loading…</p>
    </main>
  )
}

export default function RouteLoading({ path, ...headerProps }) {
  const title = {
    '/features': 'Tagstash features',
    '/pricing': 'Tagstash pricing',
    '/developers': 'Build with Tagstash',
  }[path] || 'Tagstash'

  return (
    <div className="app public-page route-loading">
      <PublicHeader {...headerProps} currentPath={path} />
      <main id="main" tabIndex={-1} className="route-loading-main" aria-busy="true">
        <h1>{title}</h1>
        <p className="sr-only" role="status">Loading page…</p>
        <div className="route-loading-placeholder" aria-hidden="true">
          <div className="route-loading-line" />
          <div className="route-loading-line route-loading-line--short" />
          <div className="route-loading-panel" />
        </div>
      </main>
      <AppFooter />
    </div>
  )
}

import PublicHeader from './PublicHeader'
import AppFooter from './AppFooter'
import { version } from '../../package.json'
import { useDocumentMeta } from '../utils/useDocumentMeta'
import { usePageStructuredData } from '../utils/usePageStructuredData'
import { EXTENSION_FACTS, EXTENSION_FEATURES, EXTENSION_INSTALL_STEPS, EXTENSION_META, EXTENSION_STORES, EXTENSION_UPDATED } from '../content/browserExtension'
import { getExtensionStructuredData } from '../content/marketingSchema'
import './Home.css'
import './FeaturesPage.css'
import './ExtensionPage.css'

// Rendered at build time too (scripts/prerender-features.mjs), so the initial HTML and the
// React page share one source. Pages are plain links: no router callbacks in the markup.

function StoreLinks() {
  return (
    <ul className="extension-stores">
      {EXTENSION_STORES.map(store => (
        <li key={store.id} className="extension-store">
          <img src={store.icon} width="40" height="40" alt="" />
          <div>
            <p className="extension-store-name">{store.name}</p>
            <p>{store.summary}</p>
            <a className="features-button features-button--small" href={store.url} target="_blank" rel="noopener noreferrer">
              {store.action}<span className="sr-only"> (opens {store.store})</span>
            </a>
          </div>
        </li>
      ))}
    </ul>
  )
}

export function ExtensionView({ logoSrc = '/logo-dark.png', theme = 'slate', onSelectTheme = () => {}, signedIn = false }) {
  return (
    <div className="features-page extension-page public-page">
      <PublicHeader logoSrc={logoSrc} theme={theme} onSelectTheme={onSelectTheme} signedIn={signedIn} />
      <main id="main" tabIndex={-1} className="features-main">
        <nav className="features-breadcrumbs" aria-label="Breadcrumb">
          <a href="/">Home</a><span aria-hidden="true"> / </span><span aria-current="page">Browser extension</span>
        </nav>
        <section className="features-intro extension-intro" aria-labelledby="extension-title">
          <h1 id="extension-title">Save the tab you’re on, tags and all</h1>
          <p>The Tagstash extension for Chrome and Firefox saves the current page to your library without leaving it. Add tags and a note while the page is still in front of you.</p>
          <StoreLinks />
        </section>

        <section className="extension-section" aria-labelledby="extension-features-title">
          <h2 id="extension-features-title">What the extension does</h2>
          <ul className="extension-features">
            {EXTENSION_FEATURES.map(feature => (
              <li key={feature.title}>
                <h3>{feature.title}</h3>
                <p>{feature.description}</p>
              </li>
            ))}
          </ul>
        </section>

        <section className="extension-section" aria-labelledby="extension-install-title">
          <h2 id="extension-install-title">Install it in a minute</h2>
          <ol className="extension-steps">
            {EXTENSION_INSTALL_STEPS.map(step => <li key={step}>{step}</li>)}
          </ol>
          {!signedIn && <a className="features-button" href="/?signup=1#account">Create your free account</a>}
        </section>

        <section className="extension-section" aria-labelledby="extension-facts-title">
          <h2 id="extension-facts-title">Good to know</h2>
          <ul className="extension-facts">
            {EXTENSION_FACTS.map(fact => <li key={fact}>{fact}</li>)}
          </ul>
          <p>More of what Tagstash does is on the <a href="/features">Features page</a>. Moving from another bookmark manager? See the <a href="/import">import guides</a>.</p>
          <p className="features-updated">Page updated <time dateTime={EXTENSION_UPDATED}>November 16, 2026</time>.</p>
        </section>
      </main>
      <AppFooter version={version}>
        <a className="footer-privacy-link" href="/">Home</a>
        <a className="footer-privacy-link" href="/privacy">Privacy Policy</a>
        <a className="footer-privacy-link" href="/support">Support</a>
      </AppFooter>
    </div>
  )
}

export default function ExtensionPage(props) {
  useDocumentMeta(EXTENSION_META)
  usePageStructuredData(getExtensionStructuredData)
  return <ExtensionView {...props} />
}

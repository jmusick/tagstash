import { useMemo } from 'react'
import { useParams } from 'react-router-dom'
import PublicHeader from './PublicHeader'
import AppFooter from './AppFooter'
import NotFound from './NotFound'
import { version } from '../../package.json'
import { useDocumentMeta } from '../utils/useDocumentMeta'
import { usePageStructuredData } from '../utils/usePageStructuredData'
import { IMPORT_FACTS, IMPORT_GUIDES, IMPORT_GUIDES_UPDATED, IMPORT_HUB_META, findImportGuide, importGuideMeta, tagstashImportSteps } from '../content/importGuides'
import { getImportGuideStructuredData, getImportHubStructuredData } from '../content/marketingSchema'
import './Home.css'
import './FeaturesPage.css'
import './ImportGuidesPage.css'

// Rendered at build time too (scripts/prerender-features.mjs), so the initial HTML and the
// React page share one source. Pages are plain links: no router callbacks in the markup.

function ImportLayout({ logoSrc, theme, onSelectTheme, signedIn, children }) {
  return (
    <div className="features-page import-guides-page public-page">
      <PublicHeader logoSrc={logoSrc} theme={theme} onSelectTheme={onSelectTheme} signedIn={signedIn} />
      <main id="main" tabIndex={-1} className="features-main">{children}</main>
      <AppFooter version={version}>
        <a className="footer-privacy-link" href="/">Home</a>
        <a className="footer-privacy-link" href="/privacy">Privacy Policy</a>
        <a className="footer-privacy-link" href="/support">Support</a>
      </AppFooter>
    </div>
  )
}

function ImportFacts() {
  return (
    <section className="import-guide-section" aria-labelledby="import-facts-title">
      <h2 id="import-facts-title">Good to know</h2>
      <ul>
        {IMPORT_FACTS.map(fact => <li key={fact}>{fact}</li>)}
      </ul>
      <p className="features-updated">Guides updated <time dateTime={IMPORT_GUIDES_UPDATED}>November 16, 2026</time>.</p>
    </section>
  )
}

export function ImportHubView({ logoSrc = '/logo-dark.png', theme = 'slate', onSelectTheme = () => {}, signedIn = false }) {
  return (
    <ImportLayout logoSrc={logoSrc} theme={theme} onSelectTheme={onSelectTheme} signedIn={signedIn}>
      <nav className="features-breadcrumbs" aria-label="Breadcrumb">
        <a href="/">Home</a><span aria-hidden="true"> / </span><span aria-current="page">Import guides</span>
      </nav>
      <section className="features-intro import-guides-intro" aria-labelledby="import-title">
        <h1 id="import-title">Import your bookmarks into Tagstash</h1>
        <p>Export your bookmarks from where they are now, then upload the file in Settings → Import / Export. Folders and tags come along as tags, so nothing has to be sorted twice.</p>
      </section>

      <section className="import-guide-section" aria-labelledby="import-sources-title">
        <h2 id="import-sources-title">Choose where your bookmarks are now</h2>
        <ul className="import-guide-list">
          {IMPORT_GUIDES.map(guide => (
            <li key={guide.slug}>
              <a href={`/import/${guide.slug}`}>{guide.name}</a>
              <p>{guide.summary}</p>
            </li>
          ))}
        </ul>
      </section>

      <ImportFacts />
    </ImportLayout>
  )
}

export function ImportGuideView({ slug, logoSrc = '/logo-dark.png', theme = 'slate', onSelectTheme = () => {}, signedIn = false }) {
  const guide = findImportGuide(slug)
  const importHref = signedIn ? '/settings?tab=import' : '/?signup=1#account'
  return (
    <ImportLayout logoSrc={logoSrc} theme={theme} onSelectTheme={onSelectTheme} signedIn={signedIn}>
      <nav className="features-breadcrumbs" aria-label="Breadcrumb">
        <a href="/">Home</a><span aria-hidden="true"> / </span>
        <a href="/import">Import guides</a><span aria-hidden="true"> / </span>
        <span aria-current="page">{guide.name}</span>
      </nav>
      <section className="features-intro import-guides-intro" aria-labelledby="import-guide-title">
        <h1 id="import-guide-title">Import {guide.name} bookmarks into Tagstash</h1>
        <p>{guide.intro || guide.summary}</p>
      </section>

      <section className="import-guide-section" aria-labelledby="import-export-title">
        <h2 id="import-export-title">1. Export from {guide.name}</h2>
        <ol className="import-guide-steps">
          {guide.steps.map(step => <li key={step}>{step}</li>)}
        </ol>
      </section>

      <section className="import-guide-section" aria-labelledby="import-upload-title">
        <h2 id="import-upload-title">2. Import into Tagstash</h2>
        <ol className="import-guide-steps">
          {tagstashImportSteps(guide).map(step => <li key={step}>{step}</li>)}
        </ol>
        <a className="features-button" href={importHref}>{signedIn ? 'Open Import / Export' : 'Create your free account'}</a>
      </section>

      <section className="import-guide-section import-guide-columns" aria-label={`What comes across from ${guide.name}`}>
        <div>
          <h2>What comes across</h2>
          <ul>{guide.carries.map(item => <li key={item}>{item}</li>)}</ul>
        </div>
        <div>
          <h2>What stays behind</h2>
          <ul>{guide.leaves.map(item => <li key={item}>{item}</li>)}</ul>
        </div>
      </section>

      <ImportFacts />
      <p className="import-guide-back"><a href="/import">All import guides</a></p>
    </ImportLayout>
  )
}

function ImportHubPage(props) {
  useDocumentMeta(IMPORT_HUB_META)
  usePageStructuredData(getImportHubStructuredData)
  return <ImportHubView {...props} />
}

function ImportGuidePage({ guide, ...props }) {
  const createData = useMemo(() => origin => getImportGuideStructuredData(origin, guide.slug), [guide.slug])
  useDocumentMeta(importGuideMeta(guide))
  usePageStructuredData(createData)
  return <ImportGuideView slug={guide.slug} {...props} />
}

// An unknown source is the regular 404, with none of the guide's head tags or schema.
export default function ImportGuidesPage(props) {
  const { source } = useParams()
  if (!source) return <ImportHubPage {...props} />
  const guide = findImportGuide(source)
  return guide ? <ImportGuidePage key={guide.slug} guide={guide} {...props} /> : <NotFound {...props} />
}

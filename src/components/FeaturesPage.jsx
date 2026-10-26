import AppHeader from './AppHeader'
import AppFooter from './AppFooter'
import HomeTagDemo from './HomeTagDemo'
import FeatureAnimation from './FeatureAnimation'
import { FEATURE_DEMOS } from '../utils/featureDemos'
import { version } from '../../package.json'
import { useDocumentMeta } from '../utils/useDocumentMeta'
import { FEATURES_META } from '../utils/featuresMeta'
import { FEATURES_FAQS, FEATURES_UPDATED } from '../content/featuresFaqs'
import { getFeaturesStructuredData } from '../content/marketingSchema'
import { usePageStructuredData } from '../utils/usePageStructuredData'
import './Home.css'
import './FeaturesPage.css'

// Also rendered at build time: the initial HTML and React page share one source.
export function FeaturesView({ logoSrc = '/logo-dark.png', theme = 'slate', onSelectTheme = () => {}, signedIn = false }) {
  return (
    <div className="features-page">
      <AppHeader logoSrc={logoSrc} theme={theme} onSelectTheme={onSelectTheme}>
        <a className="features-nav-link" href="/">Home</a>
        <a className="features-nav-link" href="/features" aria-current="page">Features</a>
        <a className="features-button features-button--small" href={signedIn ? '/' : '/?signup=1#account'}>
          {signedIn ? 'Your bookmarks' : 'Start free'}
        </a>
      </AppHeader>

      <main id="main" tabIndex={-1} className="features-main">
        <nav className="features-breadcrumbs" aria-label="Breadcrumb">
          <a href="/">Home</a><span aria-hidden="true"> / </span><span aria-current="page">Features</span>
        </nav>
        <section className="features-intro" aria-labelledby="features-title">
          <h1 id="features-title">A bookmark manager.<br />Every tag that fits.</h1>
          <p>Tagstash is a tag-based bookmark manager for saving, organizing, and sharing links. Give recipes, research, weekend plans, and articles every tag that fits, then find them by search or by combining tags.</p>
          <a className="features-button" href={signedIn ? '/' : '/?signup=1#account'}>{signedIn ? 'Open your bookmarks' : 'Start your free collection'}</a>
          <span className="features-free-note">Your first 50 bookmarks are free. No time limit.</span>
        </section>

        <nav className="features-jump-links" aria-label="Explore features">
          <a href="#organize">Organize</a>
          <a href="#save">Save</a>
          <a href="#find">Find</a>
          <a href="#share">Share</a>
          <a href="#move">Import &amp; export</a>
        </nav>

        <section id="organize" className="features-story features-story--demo" aria-labelledby="organize-title">
          <div>
            <h2 id="organize-title">Organize bookmarks with multiple tags.</h2>
            <p>A trail packing list can be both <span className="tag-stock features-inline-tag">hiking</span> and <span className="tag-stock features-inline-tag">reference</span>. Save it once, then find it under either tag. Select both to narrow your collection to links that match both topics.</p>
            <p>As your collection grows, merge tags from the Tags page to bring overlapping labels together. Favorite the tags you reach for most.</p>
          </div>
          <div className="features-demo">
            <HomeTagDemo />
            <p className="features-demo-caption">Try it with these sample bookmarks.</p>
          </div>
          <FeatureAnimation clips={FEATURE_DEMOS.organize} />
        </section>

        <section id="save" className="features-story" aria-labelledby="save-title">
          <div>
            <h2 id="save-title">Save links from the web or your browser.</h2>
            <p>The Chrome and Firefox extensions save the current tab directly to your library. Add tags and notes while the page is still fresh in your mind.</p>
            <p>You can also add links in the web app. Adjust the title and description, trim a URL’s query string, or save just the site’s base URL.</p>
          </div>
          <div className="features-aside">
            <h3>Save from your browser</h3>
            <p>Install the extension for the browser you use.</p>
            <a className="features-extension" href="https://chromewebstore.google.com/detail/tagstash/ijoaejbpaibpodnohjmlbeanfhjdgoab" target="_blank" rel="noopener noreferrer"><img src="/chrome.svg" width="28" height="28" alt="" />Add to Chrome</a>
            <a className="features-extension" href="https://addons.mozilla.org/en-US/firefox/addon/tagstash/" target="_blank" rel="noopener noreferrer"><img src="/firefox.svg" width="28" height="28" alt="" />Add to Firefox</a>
          </div>
          <FeatureAnimation clips={FEATURE_DEMOS.save} />
        </section>

        <section id="find" className="features-story" aria-labelledby="find-title">
          <div>
            <h2 id="find-title">Search, sort, and revisit your bookmarks.</h2>
            <p>Search across titles, URLs, descriptions, and tags. Combine search with tag filters, then sort by date saved, title, or URL to get the view you need.</p>
            <p>Star useful bookmarks and filter to your favorites. When you want to revisit something you’ve forgotten, use Random to bring a bookmark back into view.</p>
          </div>
          <div className="features-aside">
            <h3>Make your collection comfortable</h3>
            <p>Choose Slate, Midnight, or Light. Your theme follows your account.</p>
            <p>Set bookmark links to open in the same tab or a new one. The browser extension has its own link-opening preference.</p>
          </div>
          <FeatureAnimation clips={FEATURE_DEMOS.find} />
        </section>

        <section id="share" className="features-story" aria-labelledby="share-title">
          <div>
            <h2 id="share-title">Share a public profile. Keep private links private.</h2>
            <p>Keep your library to yourself, or turn on a public profile to share a tag-filterable collection with other people. They can browse your shared bookmarks without an account.</p>
            <p>Mark individual bookmarks private to keep them out of your public profile. Their links, descriptions, and tags stay out of the public API too.</p>
          </div>
          <div className="features-aside">
            <h3>Bring your links to your own site</h3>
            <p>Your public profile includes a JSON API with optional tag filters. Copy its URL from Settings to use your shared bookmarks on another website.</p>
            <p>Share a whole collection, or just the links for one topic.</p>
          </div>
          <FeatureAnimation clips={FEATURE_DEMOS.share} />
        </section>

        <section id="move" className="features-story" aria-labelledby="move-title">
          <div>
            <h2 id="move-title">Import and export your bookmark library.</h2>
            <p>Import a bookmark HTML export from your browser (including Safari), or an export from Raindrop.io, Pocket, Pinboard or Instapaper. HTML imports also read tags and descriptions when they’re included in the file.</p>
            <p>Export your complete library, including private bookmarks, from Settings. Choose HTML for browser imports, CSV for a spreadsheet, or JSON to preserve dates, tags, favorites, and privacy settings.</p>
          </div>
          <div className="features-formats" aria-label="Export formats">
            <dl>
              <div><dt>HTML</dt><dd>Back to your browser</dd></div>
              <div><dt>CSV</dt><dd>Into a spreadsheet</dd></div>
              <div><dt>JSON</dt><dd>Keep the details</dd></div>
            </dl>
          </div>
          <FeatureAnimation clips={FEATURE_DEMOS.move} />
        </section>

        <section className="features-questions" aria-labelledby="features-questions-title">
          <h2 id="features-questions-title">Questions about Tagstash features</h2>
          <dl>
            {FEATURES_FAQS.map(faq => (
              <div key={faq.question}><dt>{faq.question}</dt><dd>{faq.answer}</dd></div>
            ))}
          </dl>
          <p className="features-updated">Feature information updated <time dateTime={FEATURES_UPDATED}>October 7, 2026</time>.</p>
        </section>

        <section className="features-closing" aria-labelledby="features-start-title">
          <div>
            <h2 id="features-start-title">Start with the links you want to keep.</h2>
            <p>Free for up to 50 bookmarks. Need more room? Pro gives you unlimited bookmarks for $3/month or $36/year. Upgrade from Settings whenever you’re ready.</p>
          </div>
          <a className="features-button" href={signedIn ? '/' : '/?signup=1#account'}>{signedIn ? 'Your bookmarks' : 'Create your free account'}</a>
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

export default function FeaturesPage(props) {
  useDocumentMeta(FEATURES_META)
  usePageStructuredData(getFeaturesStructuredData)
  return <FeaturesView {...props} />
}

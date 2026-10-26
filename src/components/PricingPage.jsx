import AppHeader from './AppHeader'
import AppFooter from './AppFooter'
import { version } from '../../package.json'
import { useDocumentMeta } from '../utils/useDocumentMeta'
import { PRICING_META } from '../utils/pageMeta'
import { PRICING_FAQS, PRICING_INCLUDED, PRICING_UPDATED } from '../content/pricing'
import { getPricingStructuredData } from '../content/marketingSchema'
import { usePageStructuredData } from '../utils/usePageStructuredData'
import './Home.css'
import './FeaturesPage.css'
import './PricingPage.css'

// Also rendered at build time, like FeaturesView: the initial HTML and React page share one source.
export function PricingView({ logoSrc = '/logo-dark.png', theme = 'slate', onSelectTheme = () => {}, signedIn = false, isPro = false }) {
  const startHref = signedIn ? '/' : '/?signup=1#account'
  return (
    <div className="features-page pricing-page">
      <AppHeader logoSrc={logoSrc} theme={theme} onSelectTheme={onSelectTheme}>
        <a className="features-nav-link" href="/">Home</a>
        <a className="features-nav-link" href="/features">Features</a>
        <a className="features-nav-link" href="/pricing" aria-current="page">Pricing</a>
        <a className="features-button features-button--small" href={startHref}>
          {signedIn ? 'Your bookmarks' : 'Start free'}
        </a>
      </AppHeader>

      <main id="main" tabIndex={-1} className="features-main">
        <nav className="features-breadcrumbs" aria-label="Breadcrumb">
          <a href="/">Home</a><span aria-hidden="true"> / </span><span aria-current="page">Pricing</span>
        </nav>
        <section className="features-intro pricing-intro" aria-labelledby="pricing-title">
          <h1 id="pricing-title">Tagstash pricing</h1>
          <p>Start free with 50 bookmarks and no time limit. Upgrade to Pro when your collection needs more room. Every feature is on both plans; Pro removes the bookmark limit.</p>
        </section>

        <section className="pricing-grid pricing-page-plans" aria-label="Plans">
          <div className="pricing-plan">
            <h2 className="pricing-plan-name">Free</h2>
            <p className="pricing-amount">$0</p>
            <p className="pricing-description">Up to 50 bookmarks, with no time limit. No payment details needed.</p>
            <a className="features-button" href={startHref}>{signedIn ? 'Open your bookmarks' : 'Create your free account'}</a>
          </div>
          <div className="pricing-plan pricing-plan--pro">
            <h2 className="pricing-plan-name">Pro</h2>
            <p className="pricing-amount">$3<span className="pricing-period">/month</span></p>
            <p className="pricing-description">Unlimited bookmarks. Pay monthly and cancel any time, or pay $36 once a year. Same rate either way.</p>
            <a className="pricing-plan-link" href={signedIn ? '/settings' : startHref}>
              {isPro ? 'Manage billing in Settings' : signedIn ? 'Upgrade in Settings' : 'Start free, upgrade from Settings'}
            </a>
          </div>
        </section>

        <section className="pricing-included" aria-labelledby="pricing-included-title">
          <h2 id="pricing-included-title">Included on both plans</h2>
          <ul>
            {PRICING_INCLUDED.map(item => <li key={item}>{item}</li>)}
          </ul>
          <p><a href="/features">See how each feature works</a></p>
        </section>

        <section className="features-questions" aria-labelledby="pricing-questions-title">
          <h2 id="pricing-questions-title">Questions about plans and billing</h2>
          <dl>
            {PRICING_FAQS.map(faq => (
              <div key={faq.question}><dt>{faq.question}</dt><dd>{faq.answer}</dd></div>
            ))}
          </dl>
          <p className="features-updated">Pricing information updated <time dateTime={PRICING_UPDATED}>October 26, 2026</time>.</p>
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

export default function PricingPage(props) {
  useDocumentMeta(PRICING_META)
  usePageStructuredData(getPricingStructuredData)
  return <PricingView {...props} />
}

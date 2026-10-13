// Injects structured data and a static content snapshot into the SPA shell for
// GET /, so crawlers that don't execute JavaScript (most AI/LLM crawlers, unlike
// Googlebot which renders JS on a second pass) see real marketing copy instead of
// an empty <div id="root">. Real visitors get the same HTML; React's createRoot
// render() replaces it on mount (see src/main.jsx), so this is a flash-then-hydrate
// snapshot of the *same* copy that ships in src/components/Home.jsx, not bot-only
// content. Keep the two in sync if either changes.

import { HOME_FAQS as FAQS, HOME_FEATURES as FEATURES } from '../src/content/homeMarketing.js';
import { getHomeStructuredData, serializeStructuredData } from '../src/content/marketingSchema.js';

const escapeHtml = (value) =>
  String(value).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  }[c]));

export async function onRequestGet({ request, next }) {
  const response = await next();

  const contentType = response.headers.get('Content-Type') || '';
  if (response.status !== 200 || !contentType.includes('text/html')) {
    return response;
  }

  const origin = new URL(request.url).origin;

  const headHtml = `<script type="application/ld+json" data-page-schema="true">${serializeStructuredData(getHomeStructuredData(origin))}</script>`;

  const featuresHtml = FEATURES.map(
    (f) => `<div class="feature-item"><dt>${escapeHtml(f.title)}</dt><dd>${escapeHtml(f.description)}</dd></div>`
  ).join('');

  const faqHtml = FAQS.map(
    (faq) => `<div class="faq-item"><dt>${escapeHtml(faq.question)}</dt><dd>${escapeHtml(faq.answer)}</dd></div>`
  ).join('');

  const rootHtml = `
<div class="home-container">
  <main id="main" tabindex="-1">
  <section class="hero-section">
    <div class="hero-content">
      <h1 class="hero-headline">Tag-first bookmarking for people who outgrow folders fast.</h1>
      <p class="hero-lede">Save links in a bookmark manager built around tags. Give each link every tag that fits, and find it again from any of them. Free for your first 50 bookmarks.</p>
    </div>
  </section>
  <section class="features-section">
    <h2 class="home-section-title">What you get</h2>
    <dl class="features-list">${featuresHtml}</dl>
    <a class="home-features-detail-link" href="/features">Explore all features</a>
  </section>
  <section class="pricing-section">
    <h2 class="home-section-title">Pricing</h2>
    <p class="pricing-note">Free: up to 50 bookmarks, with no time limit. Pro: unlimited bookmarks for $3/month, or $36 once a year. Same rate either way.</p>
  </section>
  <section class="faq-section">
    <h2 class="home-section-title">Questions</h2>
    <dl class="faq-list">${faqHtml}</dl>
  </section>
  </main>
</div>
`;

  const rewriter = new HTMLRewriter()
    .on('head', {
      element(el) {
        el.append(headHtml, { html: true });
      },
    })
    .on('#root', {
      element(el) {
        el.setInnerContent(rootHtml, { html: true });
      },
    });

  return rewriter.transform(response);
}

// Injects structured data and a static content snapshot into the SPA shell for
// GET /, so crawlers that don't execute JavaScript (most AI/LLM crawlers, unlike
// Googlebot which renders JS on a second pass) see real marketing copy instead of
// an empty <div id="root">. Real visitors get the same HTML; React's createRoot
// render() replaces it on mount (see src/main.jsx), so this is a flash-then-hydrate
// snapshot of the *same* copy that ships in src/components/Home.jsx, not bot-only
// content. Keep the two in sync if either changes.
//
// A visitor who sends a session cookie gets the bare shell instead: the snapshot is the
// signed-out homepage, and painting it before the app loads flashed it at signed-in users.
// The cookie only says a session probably exists; the app still checks it, and shows the
// homepage if it was expired or revoked.

import { renderPublicHeader } from './_lib/publicHeader.js';
import { HOME_FAQS as FAQS, HOME_FEATURES as FEATURES } from '../src/content/homeMarketing.js';
import { getHomeStructuredData, serializeStructuredData } from '../src/content/marketingSchema.js';
import { getSessionCookie } from './_lib/sessionCookie.js';

const escapeHtml = (value) =>
  String(value).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  }[c]));

// The two variants share a URL, so a browser must never revalidate one into the other. Drop
// the validators both ways: the shell's ETag doesn't describe either body anyway.
const withoutRevalidation = (response) => {
  const result = new Response(response.body, response);
  result.headers.delete('ETag');
  result.headers.delete('Last-Modified');
  result.headers.append('Vary', 'Cookie');
  return result;
};

export async function onRequestGet({ request, next }) {
  // Without conditional headers the asset server always answers 200 with the shell, never a
  // 304 that would let the browser show whichever variant it cached last.
  const headers = new Headers(request.headers);
  headers.delete('If-None-Match');
  headers.delete('If-Modified-Since');
  const response = await next(new Request(request, { headers }));

  const contentType = response.headers.get('Content-Type') || '';
  if (response.status !== 200 || !contentType.includes('text/html')) {
    return response;
  }

  if (getSessionCookie(request)) {
    return withoutRevalidation(response);
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
<div class="home-container public-page">
  ${renderPublicHeader()}
  <main id="main" tabindex="-1">
  <section class="hero-section">
    <div class="hero-content">
      <h1 class="hero-headline">Tag-first bookmarking for people who outgrow folders fast.</h1>
      <p class="hero-lede">Save links in a bookmark manager built around tags. Give each link every tag that fits, and find it again from any of them. Free for your first 50 bookmarks.</p>
      <a class="public-header-action hero-signup" href="/?signup=1#account">Create free account</a>
    </div>
  </section>
  <section class="features-section">
    <h2 class="home-section-title">What you get</h2>
    <dl class="features-list">${featuresHtml}</dl>
    <a class="home-features-detail-link" href="/features">Explore all features</a>
  </section>
  <section class="pricing-section">
    <h2 class="home-section-title">Pricing</h2>
    <p class="pricing-note">Free: up to 50 bookmarks, with no time limit. Pro: unlimited bookmarks for $3/month, or $36 once a year. Same rate either way. <a href="/pricing">Compare plans and billing</a></p>
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

  return withoutRevalidation(rewriter.transform(response));
}

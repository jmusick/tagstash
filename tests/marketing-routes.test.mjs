import test from 'node:test'
import assert from 'node:assert/strict'
import { onRequest } from '../functions/_middleware.js'
import { onRequestGet as sitemap } from '../functions/sitemap.xml.js'
import { getFeaturesStructuredData, getHomeStructuredData, getPricingStructuredData } from '../src/content/marketingSchema.js'
import { FEATURES_UPDATED } from '../src/content/featuresFaqs.js'
import { readFileSync } from 'node:fs'
import { PRICING_FAQS, PRICING_INCLUDED, PRICING_OFFERS, PRICING_UPDATED } from '../src/content/pricing.js'
import { PRICING_META } from '../src/utils/pageMeta.js'

test('the Features page stays indexable when served through Pages middleware', async () => {
  const response = await onRequest({
    request: new Request('https://tagsta.sh/features'),
    next: async () => new Response('<h1>Bookmark manager features</h1>', {
      headers: { 'Content-Type': 'text/html', 'Content-Security-Policy': "default-src 'self'" },
    }),
  })
  assert.equal(response.status, 200)
  assert.equal(response.headers.get('X-Robots-Tag'), null)
  assert.equal(response.headers.get('Content-Security-Policy'), "default-src 'self'")
  assert.match(await response.text(), /Bookmark manager features/)
})

test('the Pricing page is indexable and listed in the sitemap', async () => {
  const response = await onRequest({
    request: new Request('https://tagsta.sh/pricing'),
    next: async () => new Response('<h1>Tagstash pricing</h1>', { headers: { 'Content-Type': 'text/html' } }),
  })
  assert.equal(response.status, 200)
  assert.equal(response.headers.get('X-Robots-Tag'), null)
  const xml = await (await sitemap({ request: new Request('https://tagsta.sh/sitemap.xml'), env: {} })).text()
  assert.match(xml, /<loc>https:\/\/tagsta\.sh\/pricing<\/loc><lastmod>/)
})

test('the Pricing page schema shares the homepage offers and lists every pricing question', () => {
  const graph = getPricingStructuredData('https://tagsta.sh')['@graph']
  const software = graph.find(node => node['@type'] === 'SoftwareApplication')
  assert.deepEqual(software.offers, PRICING_OFFERS)
  const homeSoftware = getHomeStructuredData('https://tagsta.sh')['@graph'].find(node => node['@type'] === 'SoftwareApplication')
  assert.deepEqual(homeSoftware, software)
  const faq = graph.find(node => node['@type'] === 'FAQPage')
  assert.deepEqual(faq.mainEntity.map(question => question.name), PRICING_FAQS.map(item => item.question))
})

test('pricing copy matches the Worker limits', () => {
  const worker = readFileSync(new URL('../functions/api/[[path]].js', import.meta.url), 'utf8')
  const freeLimit = Number(/const FREE_BOOKMARK_LIMIT = (\d+);/.exec(worker)[1])
  const tagLimit = Number(/tagsPerBookmark: (\d+),/.exec(worker)[1])
  assert.match(PRICING_OFFERS[0].description, new RegExp(`Up to ${freeLimit} bookmarks`))
  assert.match(PRICING_META.description, new RegExp(`up to ${freeLimit} bookmarks`))
  assert.ok(PRICING_FAQS[0].question.includes(`${freeLimit} bookmarks`))
  assert.ok(PRICING_INCLUDED.some(item => item.startsWith(`Up to ${tagLimit} tags per bookmark`)))
  assert.ok(!PRICING_INCLUDED.some(item => /unlimited tags/i.test(item)))
})

test('an unknown SPA address stays a real nonindexable 404', async () => {
  const response = await onRequest({
    request: new Request('https://tagsta.sh/nonexistent-marketing-page'),
    next: async () => new Response('<div id="root"></div>', { headers: { 'Content-Type': 'text/html' } }),
  })
  assert.equal(response.status, 404)
  assert.equal(response.headers.get('X-Robots-Tag'), 'noindex')
})

test('owner pages are real 200 responses rather than the SPA 404', async () => {
  for (const path of ['/trash', '/tags', '/settings', '/duplicates']) {
    const response = await onRequest({
      request: new Request(`https://tagsta.sh${path}`),
      next: async () => new Response('<div id="root"></div>', { headers: { 'Content-Type': 'text/html' } }),
    })
    assert.equal(response.status, 200, path)
  }
})

test('marketing route handling preserves asset redirects and API responses', async () => {
  for (const [path, status, headers, body] of [
    ['/features/', 308, { Location: '/features' }, null],
    ['/api/profiles/alex', 200, { 'Content-Type': 'application/json' }, '{"bookmarks":[]}'],
  ]) {
    const response = await onRequest({
      request: new Request(`https://tagsta.sh${path}`),
      next: async () => new Response(body, { status, headers }),
    })
    assert.equal(response.status, status)
    assert.equal(response.headers.get('X-Robots-Tag'), null)
    if (path === '/features/') assert.equal(response.headers.get('Location'), '/features')
  }
})

test('Features and Pricing show one content date in the page, the schema and the sitemap', async () => {
  const xml = await (await sitemap({ request: new Request('https://tagsta.sh/sitemap.xml'), env: {} })).text()
  const spelled = (day) => new Date(`${day}T00:00:00Z`).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric', timeZone: 'UTC' })
  for (const [path, updated, component, getSchema] of [
    ['/features', FEATURES_UPDATED, 'src/components/FeaturesPage.jsx', getFeaturesStructuredData],
    ['/pricing', PRICING_UPDATED, 'src/components/PricingPage.jsx', getPricingStructuredData],
  ]) {
    assert.match(xml, new RegExp(`<loc>https://tagsta\\.sh${path}</loc><lastmod>${updated}</lastmod>`), path)
    const page = getSchema('https://tagsta.sh')['@graph'].find(node => node['@type'] === 'WebPage')
    assert.equal(page.dateModified, updated, path)
    const source = readFileSync(new URL(`../${component}`, import.meta.url), 'utf8')
    assert.match(source, new RegExp(`<time dateTime=\\{[A-Z_]+\\}>${spelled(updated)}</time>`), path)
  }
})

test('every marketing page that describes the app uses the complete SoftwareApplication entity', () => {
  // A partial inline SoftwareApplication (name and url only) is an invalid Software App rich result.
  const home = getHomeStructuredData('https://tagsta.sh')['@graph'].find(node => node['@type'] === 'SoftwareApplication')
  for (const getSchema of [getFeaturesStructuredData, getPricingStructuredData]) {
    const graph = getSchema('https://tagsta.sh')['@graph']
    const page = graph.find(node => node['@type'] === 'WebPage')
    assert.deepEqual(page.about, { '@id': 'https://tagsta.sh/#software' })
    assert.deepEqual(graph.find(node => node['@type'] === 'SoftwareApplication'), home)
    assert.ok(!JSON.stringify(page).includes('SoftwareApplication'))
  }
})

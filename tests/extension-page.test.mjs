import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { onRequest } from '../functions/_middleware.js'
import { onRequestGet as sitemap } from '../functions/sitemap.xml.js'
import { getExtensionStructuredData, getHomeStructuredData } from '../src/content/marketingSchema.js'
import { EXTENSION_FACTS, EXTENSION_INSTALL_STEPS, EXTENSION_META, EXTENSION_STORES, EXTENSION_UPDATED } from '../src/content/browserExtension.js'
import { RESERVED_USERNAMES } from '../src/utils/usernamePolicy.js'

const read = path => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8')

test('the extension page is indexable and in the sitemap', async () => {
  const response = await onRequest({
    request: new Request('https://tagsta.sh/extension'),
    next: async () => new Response('<div id="root"></div>', { headers: { 'Content-Type': 'text/html' } }),
  })
  assert.equal(response.status, 200)
  assert.equal(response.headers.get('X-Robots-Tag'), null)
  const xml = await (await sitemap({ request: new Request('https://tagsta.sh/sitemap.xml'), env: {} })).text()
  assert.ok(xml.includes(`<loc>https://tagsta.sh/extension</loc><lastmod>${EXTENSION_UPDATED}</lastmod>`))
})

test('the page links the same store listings as the rest of the site', () => {
  // Settings → Extensions, the Features page and the login card link the live listings.
  for (const component of ['src/components/Settings.jsx', 'src/components/FeaturesPage.jsx', 'src/components/Home.jsx']) {
    const source = read(component)
    for (const store of EXTENSION_STORES) assert.ok(source.includes(store.url), `${component}: ${store.id}`)
  }
  assert.deepEqual(EXTENSION_STORES.map(store => store.id), ['chrome', 'firefox'])
})

test('extension facts match the Worker free-plan limit', () => {
  const freeLimit = Number(/const FREE_BOOKMARK_LIMIT = (\d+);/.exec(read('functions/api/[[path]].js'))[1])
  assert.ok(EXTENSION_FACTS.some(fact => fact.includes(`${freeLimit} bookmarks`)))
})

test('extension schema uses the shared app entity, breadcrumbs, one date and the page steps', () => {
  const home = getHomeStructuredData('https://tagsta.sh')['@graph'].find(node => node['@type'] === 'SoftwareApplication')
  const graph = getExtensionStructuredData('https://tagsta.sh')['@graph']
  const page = graph.find(node => node['@type'] === 'WebPage')
  assert.equal(page.url, `https://tagsta.sh${EXTENSION_META.path}`)
  assert.equal(page.dateModified, EXTENSION_UPDATED)
  assert.deepEqual(page.about, { '@id': 'https://tagsta.sh/#software' })
  assert.deepEqual(graph.find(node => node['@type'] === 'SoftwareApplication'), home)
  assert.equal(graph.find(node => node['@type'] === 'BreadcrumbList').itemListElement.at(-1).item, page.url)
  const howTo = graph.find(node => node['@type'] === 'HowTo')
  assert.deepEqual(howTo.step.map(step => step.text), EXTENSION_INSTALL_STEPS)
})

test('the page shows the same updated date as the schema and sitemap', () => {
  const spelled = new Date(`${EXTENSION_UPDATED}T00:00:00Z`).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric', timeZone: 'UTC' })
  assert.match(read('src/components/ExtensionPage.jsx'), new RegExp(`<time dateTime=\\{EXTENSION_UPDATED\\}>${spelled}</time>`))
})

test('the footers link the extension page', () => {
  assert.match(read('src/components/AppFooter.jsx'), /href="\/extension"/)
  assert.match(read('functions/u/[username].js'), /href="\/extension">Browser extension</)
})

test('extension is a reserved username', () => {
  assert.ok(RESERVED_USERNAMES.has('extension'))
  assert.ok(RESERVED_USERNAMES.has('extensions'))
})

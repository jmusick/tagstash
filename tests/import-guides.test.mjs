import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { onRequest } from '../functions/_middleware.js'
import { onRequestGet as sitemap } from '../functions/sitemap.xml.js'
import { getHomeStructuredData, getImportGuideStructuredData, getImportHubStructuredData } from '../src/content/marketingSchema.js'
import { IMPORT_FACTS, IMPORT_GUIDES, IMPORT_GUIDES_UPDATED, IMPORT_GUIDE_PATHS, IMPORT_HUB_META, importGuideMeta } from '../src/content/importGuides.js'
import { RESERVED_USERNAMES } from '../src/utils/usernamePolicy.js'

const html = async (path) => onRequest({
  request: new Request(`https://tagsta.sh${path}`),
  next: async () => new Response('<div id="root"></div>', { headers: { 'Content-Type': 'text/html' } }),
})

test('the import hub and every guide are indexable and in the sitemap', async () => {
  assert.deepEqual(IMPORT_GUIDE_PATHS, ['/import', ...['chrome', 'firefox', 'safari', 'edge', 'raindrop', 'pocket', 'pinboard', 'instapaper'].map(slug => `/import/${slug}`)])
  const xml = await (await sitemap({ request: new Request('https://tagsta.sh/sitemap.xml'), env: {} })).text()
  for (const path of IMPORT_GUIDE_PATHS) {
    const response = await html(path)
    assert.equal(response.status, 200, path)
    assert.equal(response.headers.get('X-Robots-Tag'), null, path)
    assert.ok(xml.includes(`<loc>https://tagsta.sh${path}</loc><lastmod>${IMPORT_GUIDES_UPDATED}</lastmod>`), path)
  }
})

test('an unknown import guide stays a nonindexable 404', async () => {
  for (const path of ['/import/netscape', '/import/chrome/extra']) {
    const response = await html(path)
    assert.equal(response.status, 404, path)
    assert.equal(response.headers.get('X-Robots-Tag'), 'noindex', path)
  }
})

test('each guide names an option the importer really offers', () => {
  const importer = readFileSync(new URL('../src/components/Import.jsx', import.meta.url), 'utf8')
  const labels = [...importer.matchAll(/label: '([^']+)'/g)].map(([, label]) => label)
  for (const guide of IMPORT_GUIDES) {
    assert.ok(labels.includes(guide.option), `${guide.slug}: ${guide.option}`)
    // Every guide but Edge (which reuses the Chrome option) is also an importer source key.
    if (guide.slug !== 'edge') assert.match(importer, new RegExp(`\\n  ${guide.slug}: \\{`), guide.slug)
  }
})

test('shared import facts match the Worker limits', () => {
  const worker = readFileSync(new URL('../functions/api/[[path]].js', import.meta.url), 'utf8')
  const importLimit = Number(/importBookmarks: (\d+),/.exec(worker)[1])
  const freeLimit = Number(/const FREE_BOOKMARK_LIMIT = (\d+);/.exec(worker)[1])
  assert.ok(IMPORT_FACTS.some(fact => fact.includes(`${importLimit.toLocaleString('en-US')} bookmarks`)))
  assert.ok(IMPORT_FACTS.some(fact => fact.includes(`reach ${freeLimit} bookmarks`)))
})

test('import page schema uses the shared app entity, breadcrumbs and one date', () => {
  const home = getHomeStructuredData('https://tagsta.sh')['@graph'].find(node => node['@type'] === 'SoftwareApplication')
  const graphs = [
    [IMPORT_HUB_META, getImportHubStructuredData('https://tagsta.sh')['@graph']],
    ...IMPORT_GUIDES.map(guide => [importGuideMeta(guide), getImportGuideStructuredData('https://tagsta.sh', guide.slug)['@graph']]),
  ]
  for (const [meta, graph] of graphs) {
    const page = graph.find(node => node['@type'] === 'WebPage')
    assert.equal(page.url, `https://tagsta.sh${meta.path}`)
    assert.equal(page.dateModified, IMPORT_GUIDES_UPDATED)
    assert.deepEqual(page.about, { '@id': 'https://tagsta.sh/#software' })
    assert.deepEqual(graph.find(node => node['@type'] === 'SoftwareApplication'), home)
    const crumbs = graph.find(node => node['@type'] === 'BreadcrumbList').itemListElement
    assert.equal(crumbs.at(-1).item, page.url)
  }
  const howTo = getImportGuideStructuredData('https://tagsta.sh', 'edge')['@graph'].find(node => node['@type'] === 'HowTo')
  assert.ok(howTo.step.some(step => step.text.includes('Google Chrome Bookmarks (HTML)')))
})

test('the page shows the same updated date as the schema and sitemap', () => {
  const source = readFileSync(new URL('../src/components/ImportGuidesPage.jsx', import.meta.url), 'utf8')
  const spelled = new Date(`${IMPORT_GUIDES_UPDATED}T00:00:00Z`).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric', timeZone: 'UTC' })
  assert.match(source, new RegExp(`<time dateTime=\\{IMPORT_GUIDES_UPDATED\\}>${spelled}</time>`))
})

test('import is a reserved username', () => {
  assert.ok(RESERVED_USERNAMES.has('import'))
})

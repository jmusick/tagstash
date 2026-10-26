import { readFile, writeFile } from 'node:fs/promises'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { createServer } from 'vite'
import { FEATURES_META } from '../src/utils/featuresMeta.js'
import { getFeaturesStructuredData, getPricingStructuredData, serializeStructuredData } from '../src/content/marketingSchema.js'
import { PRIVACY_META, SUPPORT_META, DEVELOPERS_META, PRICING_META } from '../src/utils/pageMeta.js'
import { applyPageHead } from './page-head.mjs'

// Render the same presentation used by the public React routes. No copied copy,
// runtime Function, or new deployment is needed for these static pages.
const server = await createServer({
  server: { middlewareMode: true },
  appType: 'custom',
  optimizeDeps: { noDiscovery: true, entries: [], include: [] },
})
try {
  const manifest = JSON.parse(await readFile('dist/.vite/manifest.json', 'utf8'))
  const shell = await readFile('dist/index.html', 'utf8')

  // Full-body pages: the view's markup, its head and its own CSS. Styles are
  // collected per page so one page's CSS never becomes a prerequisite for another.
  async function prerenderPage({ module, view, meta, structuredData }) {
    const styles = new Set()
    const visited = new Set()
    function collectStyles(key) {
      if (visited.has(key)) return
      visited.add(key)
      const entry = manifest[key]
      if (!entry) throw new Error(`Missing build manifest entry: ${key}`)
      for (const css of entry.css || []) styles.add(css)
      for (const dependency of entry.imports || []) collectStyles(dependency)
    }
    collectStyles('index.html')
    collectStyles(module.slice(1))

    const View = (await server.ssrLoadModule(module))[view]
    let html = applyPageHead(shell, meta)
    const links = [...styles].filter(css => !html.includes(`href="/${css}"`)).map(css => `<link rel="stylesheet" href="/${css}" />`)
    if (structuredData) links.push(`<script type="application/ld+json" data-page-schema="true">${serializeStructuredData(structuredData)}</script>`)
    html = html
      .replace('<div id="root"></div>', () => `<div id="root">${renderToStaticMarkup(createElement(View))}</div>`)
      .replace('</head>', () => `${links.join('\n')}\n</head>`)
    // Pages serves dist/<name>.html at /<name> and redirects /<name>/ to the canonical
    // extensionless URL. A directory index would instead redirect to /<name>/.
    await writeFile(`dist${meta.path}.html`, html)
    console.log(`Prerendered ${meta.path} from ${view}`)
  }

  await prerenderPage({ module: '/src/components/FeaturesPage.jsx', view: 'FeaturesView', meta: FEATURES_META, structuredData: getFeaturesStructuredData('https://tagsta.sh') })
  await prerenderPage({ module: '/src/components/PricingPage.jsx', view: 'PricingView', meta: PRICING_META, structuredData: getPricingStructuredData('https://tagsta.sh') })
  await prerenderPage({ module: '/src/components/DevelopersPage.jsx', view: 'DevelopersView', meta: DEVELOPERS_META })

  // /privacy and /support are interactive (router callbacks, Turnstile), so only their
  // head is prerendered; React still renders the body client-side. Without this they
  // would ship the homepage's title/canonical/OG tags in the raw HTML.
  for (const meta of [PRIVACY_META, SUPPORT_META]) {
    await writeFile(`dist${meta.path}.html`, applyPageHead(shell, meta))
    console.log(`Prerendered head for ${meta.path}`)
  }
} finally {
  await server.close()
}

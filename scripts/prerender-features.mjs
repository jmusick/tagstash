import { readFile, writeFile } from 'node:fs/promises'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { createServer } from 'vite'
import { FEATURES_META } from '../src/utils/featuresMeta.js'
import { getFeaturesStructuredData, serializeStructuredData } from '../src/content/marketingSchema.js'
import { PRIVACY_META, SUPPORT_META, DEVELOPERS_META } from '../src/utils/pageMeta.js'
import { applyPageHead } from './page-head.mjs'

// Render the same presentation used by the public React route. No copied copy,
// runtime Function, or new deployment is needed for this static marketing page.
const server = await createServer({
  server: { middlewareMode: true },
  appType: 'custom',
  optimizeDeps: { noDiscovery: true, entries: [], include: [] },
})
try {
  const { FeaturesView } = await server.ssrLoadModule('/src/components/FeaturesPage.jsx')
  const markup = renderToStaticMarkup(createElement(FeaturesView))
  const manifest = JSON.parse(await readFile('dist/.vite/manifest.json', 'utf8'))
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
  collectStyles('src/components/FeaturesPage.jsx')

  const shell = await readFile('dist/index.html', 'utf8')
  let html = applyPageHead(shell, FEATURES_META)
  html = html
    .replace('<div id="root"></div>', () => `<div id="root">${markup}</div>`)
    .replace('</head>', `${[...styles].filter(css => !html.includes(`href="/${css}"`)).map((css) => `<link rel="stylesheet" href="/${css}" />`).join('\n')}\n<script type="application/ld+json" data-page-schema="true">${serializeStructuredData(getFeaturesStructuredData('https://tagsta.sh'))}</script>\n</head>`)
  // Pages serves this at /features and redirects /features/ to the canonical
  // extensionless URL. A directory index would instead redirect to /features/.
  await writeFile('dist/features.html', html)
  console.log('Prerendered /features from FeaturesView')

  const { DevelopersView } = await server.ssrLoadModule('/src/components/DevelopersPage.jsx')
  // Keep route CSS separate: importing a page must not make its styles a
  // prerequisite for a different prerendered page.
  styles.clear()
  visited.clear()
  collectStyles('index.html')
  collectStyles('src/components/DevelopersPage.jsx')
  let developersHtml = applyPageHead(shell, DEVELOPERS_META)
  developersHtml = developersHtml
    .replace('<div id="root"></div>', () => `<div id="root">${renderToStaticMarkup(createElement(DevelopersView))}</div>`)
    .replace('</head>', `${[...styles].filter(css => !developersHtml.includes(`href="/${css}"`)).map(css => `<link rel="stylesheet" href="/${css}" />`).join('\n')}\n</head>`)
  await writeFile('dist/developers.html', developersHtml)
  console.log('Prerendered /developers from DevelopersView')

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

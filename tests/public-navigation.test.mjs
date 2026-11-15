import test, { before, after } from 'node:test'
import assert from 'node:assert/strict'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { createServer } from 'vite'
import { renderPublicHeader } from '../functions/_lib/publicHeader.js'
import { onRequestGet as homePage } from '../functions/index.js'
import { renderProfileBookmarks } from '../functions/u/[username].js'

let server
before(async () => {
  server = await createServer({ server: { middlewareMode: true, hmr: false }, appType: 'custom', optimizeDeps: { noDiscovery: true, entries: [], include: [] } })
})
after(async () => { await server?.close() })

const navigation = html => html.match(/<nav class="public-header-nav"[^>]*>([\s\S]*?)<\/nav>/)?.[1]
const links = html => [...navigation(html).matchAll(/href="([^"]+)"[^>]*>([^<]+)<\/a>/g)].map(([, href, text]) => [href, text])
const anonymousLinks = [
  ['/features', 'Features'], ['/pricing', 'Pricing'], ['/developers', 'Developers'],
  ['/?signup=0#account', 'Log in'], ['/?signup=1#account', 'Start free'],
]

test('public header offers login and signup, or the signed-in library, with current page semantics', async () => {
  const Header = (await server.ssrLoadModule('/src/components/PublicHeader.jsx')).default
  const html = renderToStaticMarkup(createElement(Header, { currentPath: '/developers' }))
  assert.deepEqual(links(html), anonymousLinks)
  assert.match(navigation(html), /href="\/developers" aria-current="page"/)
  const signedIn = renderToStaticMarkup(createElement(Header, { signedIn: true }))
  assert.deepEqual(links(signedIn), [...anonymousLinks.slice(0, 3), ['/', 'Your bookmarks']])
  assert.doesNotMatch(navigation(signedIn), /Log in|Start free|Settings/)
  assert.deepEqual(links(renderPublicHeader()), links(html), 'Worker snapshots offer the same anonymous destinations')
})

test('all prerendered views expose the same public navigation for both auth states', async () => {
  for (const name of ['Features', 'Pricing', 'Developers']) {
    const View = (await server.ssrLoadModule(`/src/components/${name}Page.jsx`))[`${name}View`]
    for (const signedIn of [false, true]) {
      const html = renderToStaticMarkup(createElement(View, { signedIn }))
      assert.deepEqual(links(html), signedIn ? [...anonymousLinks.slice(0, 3), ['/', 'Your bookmarks']] : anonymousLinks, name)
      assert.doesNotMatch(navigation(html), /href="\/settings"/)
    }
  }
})

test('homepage and profile Worker snapshots include the anonymous public header', async () => {
  const original = globalThis.HTMLRewriter
  let snapshot
  globalThis.HTMLRewriter = class {
    on(selector, handler) {
      if (selector === '#root') handler.element({ setInnerContent: html => { snapshot = html } })
      return this
    }
    transform(response) { return response }
  }
  try {
    await homePage({ request: new Request('https://tagsta.sh/'), next: async () => new Response('', { headers: { 'Content-Type': 'text/html' } }) })
    assert.deepEqual(links(snapshot), anonymousLinks)
    assert.match(snapshot, /href="\/\?signup=1#account">Create free account<\/a>/)
    assert.deepEqual(links(renderProfileBookmarks('Reader', [], 0)), anonymousLinks)
  } finally {
    globalThis.HTMLRewriter = original
  }
})

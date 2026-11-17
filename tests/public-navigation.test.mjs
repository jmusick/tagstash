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
  const pending = renderToStaticMarkup(createElement(Header, { signedIn: null }))
  assert.deepEqual(links(pending), anonymousLinks.slice(0, 3), 'no auth actions while the session check is pending')
  assert.doesNotMatch(navigation(pending), /public-header-action/)
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

test('homepage skips the signed-out snapshot when a session cookie is sent, and never revalidates across variants', async () => {
  const original = globalThis.HTMLRewriter
  let snapshot, session
  globalThis.HTMLRewriter = class {
    on(selector, handler) {
      if (selector === '#root') handler.element({ setInnerContent: html => { snapshot = html } })
      if (selector === 'html') handler.element({ setAttribute: (name, value) => { if (name === 'data-session') session = value } })
      return this
    }
    transform(response) { return response }
  }
  const shell = '<div id="root"></div>'
  let forwarded
  const next = async (input) => {
    forwarded = input
    return new Response(shell, { headers: { 'Content-Type': 'text/html', ETag: '"shell"', 'Last-Modified': 'Mon, 16 Nov 2026 00:00:00 GMT' } })
  }
  const request = (url, cookie) => new Request(url, { headers: { 'If-None-Match': '"shell"', ...(cookie ? { Cookie: cookie } : {}) } })
  try {
    for (const [url, cookie] of [['https://tagsta.sh/', '_ga=1; __Host-tagstash-session=abc'], ['http://localhost:5000/', 'tagstash-session=abc']]) {
      snapshot = session = undefined
      const response = await homePage({ request: request(url, cookie), next })
      assert.equal(snapshot, undefined, url)
      assert.equal(session, 'present', 'the app is told to expect a session')
      assert.equal(await response.text(), shell)
      assert.equal(response.headers.get('ETag'), null)
      assert.equal(response.headers.get('Last-Modified'), null)
      assert.match(response.headers.get('Vary'), /Cookie/)
      assert.equal(forwarded.headers.get('If-None-Match'), null, 'the shell is fetched unconditionally')
    }

    // The local cookie name doesn't count on the production host, and vice versa.
    for (const [url, cookie] of [['https://tagsta.sh/', 'tagstash-session=abc'], ['https://tagsta.sh/', undefined]]) {
      snapshot = session = undefined
      const response = await homePage({ request: request(url, cookie), next })
      assert.match(snapshot, /Create free account/, url)
      assert.equal(session, 'absent')
      assert.equal(response.headers.get('ETag'), null)
      assert.match(response.headers.get('Vary'), /Cookie/)
    }
  } finally {
    globalThis.HTMLRewriter = original
  }
})

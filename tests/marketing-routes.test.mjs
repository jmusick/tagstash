import test from 'node:test'
import assert from 'node:assert/strict'
import { onRequest } from '../functions/_middleware.js'

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

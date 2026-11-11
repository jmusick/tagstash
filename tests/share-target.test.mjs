import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import {
  SHARE_TARGET_PATH,
  parseSharedLink,
  captureSharedLink,
  peekSharedLink,
  clearSharedLink,
} from '../src/utils/shareTarget.js'
import { INPUT_LIMITS } from '../src/utils/inputLimits.js'

const parse = (query) => parseSharedLink(new URLSearchParams(query))

test('the manifest declares a GET share target that /share reads', () => {
  const manifest = JSON.parse(readFileSync(new URL('../public/manifest.json', import.meta.url), 'utf8'))
  assert.deepEqual(manifest.share_target, {
    action: SHARE_TARGET_PATH,
    method: 'GET',
    params: { title: 'title', text: 'text', url: 'url' },
  })
})

test('a share with url and title uses both', () => {
  assert.deepEqual(parse('url=https%3A%2F%2Fexample.com%2Fa&title=An+article'), {
    url: 'https://example.com/a',
    title: 'An article',
  })
})

test('a link inside text is found when url is empty, and the rest becomes the title', () => {
  assert.deepEqual(parse({ text: 'Great read https://example.com/post?id=4 ' }), {
    url: 'https://example.com/post?id=4',
    title: 'Great read',
  })
  assert.deepEqual(parse({ title: 'Shared title', text: 'Look: https://example.com/x.' }), {
    url: 'https://example.com/x',
    title: 'Shared title',
  })
})

test('sentence punctuation and unbalanced parentheses are trimmed from a link in text', () => {
  assert.equal(parse({ text: '(see https://example.com/page).' }).url, 'https://example.com/page')
  assert.equal(
    parse({ text: 'https://en.wikipedia.org/wiki/Foo_(bar)' }).url,
    'https://en.wikipedia.org/wiki/Foo_(bar)',
  )
  assert.equal(parse({ text: 'https://example.com/search?q=[a]' }).url, 'https://example.com/search?q=[a]')
})

test('a title that is just the URL is dropped', () => {
  assert.deepEqual(parse({ url: 'https://example.com/', title: 'https://example.com/' }), {
    url: 'https://example.com/',
    title: '',
  })
  assert.deepEqual(parse({ text: 'https://example.com/only' }), { url: 'https://example.com/only', title: '' })
})

test('non-http links are ignored', () => {
  assert.deepEqual(parse({ url: 'javascript:alert(1)', text: 'Some note' }), { url: '', title: 'Some note' })
  assert.deepEqual(parse({ url: 'intent://example.com#Intent;end', title: 'App link' }), { url: '', title: 'App link' })
  assert.equal(parse({ text: 'ftp://example.com/file' }).url, '')
})

test('nothing usable gives null', () => {
  assert.equal(parse(''), null)
  assert.equal(parse({ title: '   ', text: '' }), null)
  assert.equal(parseSharedLink(null), null)
})

test('the title is collapsed and capped, and an over-long URL is refused', () => {
  const long = 'x'.repeat(INPUT_LIMITS.title + 50)
  assert.equal(parse({ url: 'https://example.com/', title: `  two\n\nlines ${long}` }).title.length, INPUT_LIMITS.title)
  assert.equal(parse({ title: 'a\n b' }).title, 'a b')
  const hugeUrl = `https://example.com/${'p'.repeat(INPUT_LIMITS.url)}`
  assert.equal(parse({ url: hugeUrl, title: 'Big' }).url, '')
})

const fakeWindow = (href) => {
  const location = new URL(href)
  const calls = []
  return {
    calls,
    location,
    history: {
      state: { idx: 0 },
      replaceState: (state, _title, url) => calls.push({ state, url }),
    },
  }
}

test('captureSharedLink keeps the link in memory and strips it from the address', () => {
  clearSharedLink()
  const win = fakeWindow('https://tagsta.sh/share?title=Hi&url=https%3A%2F%2Fexample.com%2F')
  assert.deepEqual(captureSharedLink(win), { url: 'https://example.com/', title: 'Hi' })
  assert.deepEqual(peekSharedLink(), { url: 'https://example.com/', title: 'Hi' })
  assert.deepEqual(win.calls, [{ state: { idx: 0 }, url: '/share' }])
  clearSharedLink()
  assert.equal(peekSharedLink(), null)
})

test('captureSharedLink ignores other paths and a bare /share', () => {
  clearSharedLink()
  for (const href of ['https://tagsta.sh/?url=https%3A%2F%2Fexample.com', 'https://tagsta.sh/share', 'https://tagsta.sh/shared?url=x']) {
    const win = fakeWindow(href)
    assert.equal(captureSharedLink(win), null, href)
    assert.deepEqual(win.calls, [], href)
  }
  assert.equal(peekSharedLink(), null)
  assert.equal(captureSharedLink(null), null)
})

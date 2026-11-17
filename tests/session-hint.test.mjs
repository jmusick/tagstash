import test, { afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { SESSION_HINT_KEY, SIGNED_IN_PATHS, expectSignedIn, rememberSignedIn } from '../src/utils/sessionHint.js'

const setup = ({ session, stored, storageThrows = false } = {}) => {
  const store = new Map(stored ? [[SESSION_HINT_KEY, stored]] : [])
  globalThis.document = { documentElement: { dataset: session ? { session } : {} } }
  globalThis.localStorage = {
    getItem: key => { if (storageThrows) throw new Error('blocked'); return store.get(key) ?? null },
    setItem: (key, value) => { if (storageThrows) throw new Error('blocked'); store.set(key, String(value)) },
    removeItem: key => { if (storageThrows) throw new Error('blocked'); store.delete(key) },
  }
  return store
}

afterEach(() => {
  delete globalThis.document
  delete globalThis.localStorage
})

test('the server-rendered marker wins over the remembered outcome', () => {
  setup({ session: 'present' })
  assert.equal(expectSignedIn(), true)
  setup({ session: 'absent', stored: '1' })
  assert.equal(expectSignedIn(), false, 'no cookie reached the server, so there is no session')
})

test('without a marker, the last session check on this browser decides', () => {
  const store = setup()
  assert.equal(expectSignedIn(), false)
  rememberSignedIn(true)
  assert.equal(store.get(SESSION_HINT_KEY), '1')
  assert.equal(expectSignedIn(), true)
  rememberSignedIn(false)
  assert.equal(store.has(SESSION_HINT_KEY), false)
  assert.equal(expectSignedIn(), false)
})

test('blocked storage and server-side rendering fall back to signed out without throwing', () => {
  setup({ stored: '1', storageThrows: true })
  assert.equal(expectSignedIn(), false)
  assert.doesNotThrow(() => rememberSignedIn(true))
  delete globalThis.document
  assert.equal(expectSignedIn(), false)
})

test('only routes that differ by auth state get the blank loading screen', () => {
  for (const path of ['/', '/settings', '/tags', '/trash', '/duplicates', '/share']) assert.ok(SIGNED_IN_PATHS.has(path), path)
  for (const path of ['/features', '/pricing', '/u/someone', '/privacy']) assert.ok(!SIGNED_IN_PATHS.has(path), path)
})

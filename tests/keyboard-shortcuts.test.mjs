import test from 'node:test'
import assert from 'node:assert/strict'
import { libraryShortcutAction, readShortcutsEnabled, saveShortcutsEnabled, SHORTCUTS_STORAGE_KEY } from '../src/utils/keyboardShortcuts.js'

test('library shortcuts recognize only their intended keys and modifiers', () => {
  assert.equal(libraryShortcutAction({ key: '/' }), 'search')
  assert.equal(libraryShortcutAction({ key: 'n' }), 'add')
  assert.equal(libraryShortcutAction({ key: '?', shiftKey: true }), 'help')
  for (const key of ['N', 'Escape', 'Enter', 'f', 'Dead', 'Process']) {
    assert.equal(libraryShortcutAction({ key }), null)
  }
  for (const flag of ['ctrlKey', 'metaKey', 'altKey', 'repeat', 'isComposing', 'defaultPrevented', 'shiftKey']) {
    assert.equal(libraryShortcutAction({ key: 'n', [flag]: true }), null, flag)
  }
  assert.equal(libraryShortcutAction({ key: 'n', keyCode: 229 }), null)
})

test('typing and interactive targets retain their own key handling', () => {
  assert.equal(libraryShortcutAction({ key: 'n', target: { isContentEditable: true } }), null)
  assert.equal(libraryShortcutAction({ key: '/', target: { closest() { return {} } } }), null)
  assert.equal(libraryShortcutAction({ key: '/', target: { closest() { return null } } }), 'search')
})

test('disable preference survives reload and unavailable storage is harmless', () => {
  const previousWindow = globalThis.window
  const values = new Map()
  try {
    globalThis.window = { localStorage: { getItem: (key) => values.get(key), setItem: (key, value) => values.set(key, value) } }
    assert.equal(readShortcutsEnabled(), true)
    saveShortcutsEnabled(false)
    assert.equal(values.get(SHORTCUTS_STORAGE_KEY), 'disabled')
    assert.equal(readShortcutsEnabled(), false)
    saveShortcutsEnabled(true)
    assert.equal(readShortcutsEnabled(), true)
    globalThis.window = { get localStorage() { throw new Error('Storage blocked') } }
    assert.equal(readShortcutsEnabled(), true)
    assert.doesNotThrow(() => saveShortcutsEnabled(false))
  } finally {
    if (previousWindow === undefined) delete globalThis.window
    else globalThis.window = previousWindow
  }
})

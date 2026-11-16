// Run after npm run build. All API traffic uses fixtures; no account writes.
import assert from 'node:assert/strict'
import { readdirSync, existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { preview } from 'vite'
import { chromium } from 'playwright-core'

const cache = process.env.PLAYWRIGHT_BROWSERS_PATH || (process.platform === 'win32'
  ? join(process.env.LOCALAPPDATA, 'ms-playwright') : join(homedir(), '.cache/ms-playwright'))
const executablePath = process.env.LAYOUT_CHROMIUM_PATH || readdirSync(cache)
  .filter(name => /^chromium-\d+$/.test(name))
  .sort((a, b) => Number(b.split('-')[1]) - Number(a.split('-')[1]))
  .flatMap(name => ['chrome-win64/chrome.exe', 'chrome-linux64/chrome', 'chrome-linux/chrome', 'chrome-mac-arm64/Chromium.app/Contents/MacOS/Chromium', 'chrome-mac/Chromium.app/Contents/MacOS/Chromium']
    .map(suffix => join(cache, name, suffix))).find(existsSync)
assert.ok(executablePath, 'Install Chromium or set LAYOUT_CHROMIUM_PATH')
const server = await preview({ preview: { host: '127.0.0.1', port: 0, open: false } })
const browser = await chromium.launch({ executablePath, headless: true })
const origin = server.resolvedUrls.local[0]
try {
  for (const theme of ['slate', 'midnight', 'light']) {
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } })
    const page = await context.newPage()
    const errors = []
    let signedIn = true
    let atLimit = false
    page.on('pageerror', error => errors.push(error.message))
    await context.addInitScript(value => localStorage.setItem('tagstash-theme', value), theme)
    await context.route('**/*', route => {
      const url = new URL(route.request().url())
      if (url.origin !== new URL(origin).origin) return route.abort()
      if (!url.pathname.startsWith('/api/')) return route.continue()
      if (['/api/bookmarks/meta', '/api/bookmarks/meta-description'].includes(url.pathname)) return route.fulfill({ status: 400, json: { error: 'Metadata lookup refused by fixture' } })
      assert.equal(route.request().method(), 'GET', `Shortcuts must not write to ${url.pathname}`)
      if (url.pathname === '/api/auth/me') return route.fulfill({ status: signedIn ? 200 : 401, json: signedIn ? { user: { id: 1, username: 'fixture', theme, membership_tier: 'free' } } : {} })
      const bookmarks = Array.from({ length: atLimit ? 50 : 1 }, (_, id) => ({ id: id + 1, title: `Bookmark ${id}`, url: `https://example.test/${id}`, tags: [] }))
      const data = url.pathname.startsWith('/api/profiles/') ? { profile: { username: 'fixture' }, bookmarks, tags: [] } : { bookmarks, tags: [], plans: [] }
      return route.fulfill({ json: data })
    })
    const visit = path => page.goto(new URL(path, origin).href)
    const main = page.locator('main')
    const search = page.getByRole('textbox', { name: 'Search bookmarks', exact: true })
    const help = page.locator('summary').filter({ hasText: /^Keyboard shortcuts/ })
    const focusMain = () => main.focus()
    await visit('/')
    await search.waitFor()
    await page.getByRole('button', { name: 'Decline', exact: true }).click()
    await focusMain()
    await page.keyboard.press('/')
    assert.equal(await search.evaluate(el => el === document.activeElement), true)
    assert.equal(await search.inputValue(), '', 'The shortcut must not enter a slash')
    await page.keyboard.type('n?')
    assert.equal(await search.inputValue(), 'n?', 'Typing must not activate shortcuts')
    assert.equal(await page.locator('#add-bookmark-form').count(), 0)
    await search.fill('')
    await focusMain()
    await page.keyboard.press('?')
    assert.equal(await help.evaluate(el => el === document.activeElement && el.parentElement.open), true)
    await focusMain()
    await page.keyboard.press('n')
    const addHeading = page.getByRole('heading', { name: 'Add a bookmark', exact: true })
    await addHeading.waitFor()
    await page.waitForFunction(() => document.activeElement?.textContent === 'Add a bookmark')
    await page.locator('#url').fill('https://example.test/n?')
    await page.locator('#title').fill('n? /')
    assert.equal(await page.locator('#title').inputValue(), 'n? /')
    await focusMain()
    await page.keyboard.press('n')
    assert.equal(await page.locator('#title').inputValue(), 'n? /', 'Reopening preserves the draft')
    await page.getByRole('button', { name: 'Cancel', exact: true }).first().click()
    await page.getByRole('button', { name: 'Add bookmark', exact: true }).focus()
    await page.keyboard.press('n')
    assert.equal(await page.locator('#add-bookmark-form').count(), 0, 'Focused buttons keep native key handling')
    for (const key of ['Control+n', 'Meta+n', 'Alt+n', 'Shift+n']) {
      await focusMain()
      // Synthetic events avoid browser-level commands opening windows or menus.
      await main.evaluate((el, shortcut) => {
        const [modifier, key] = shortcut.split('+')
        el.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true,
          ctrlKey: modifier === 'Control', metaKey: modifier === 'Meta', altKey: modifier === 'Alt', shiftKey: modifier === 'Shift' }))
      }, key)
      assert.equal(await page.locator('#add-bookmark-form').count(), 0, key)
    }
    await page.evaluate(() => {
      const editable = document.createElement('div')
      editable.contentEditable = 'true'
      editable.id = 'shortcut-editor-fixture'
      document.querySelector('main').append(editable)
      editable.focus()
    })
    await page.keyboard.type('n/?')
    assert.equal(await page.locator('#shortcut-editor-fixture').innerText(), 'n/?')
    assert.equal(await page.locator('#add-bookmark-form').count(), 0)
    await page.locator('#shortcut-editor-fixture').evaluate(el => el.remove())
    await help.evaluate(el => { el.parentElement.open = true })
    await page.getByRole('link', { name: 'Enable or disable shortcuts in Preferences' }).click()
    const enable = page.getByRole('checkbox', { name: 'Enable keyboard shortcuts', exact: true })
    await enable.uncheck()
    await page.reload()
    await enable.waitFor()
    assert.equal(await enable.isChecked(), false)
    await visit('/')
    await search.waitFor()
    for (const key of ['n', '/', '?']) {
      await focusMain()
      await page.keyboard.press(key)
      assert.equal(await main.evaluate(el => el === document.activeElement), true)
    }
    assert.equal(await page.locator('#add-bookmark-form').count(), 0)
    await visit('/settings?tab=preferences')
    await enable.check()
    atLimit = true
    await visit('/')
    await search.waitFor()
    await page.waitForFunction(() => document.querySelector('[aria-controls="add-bookmark-form"]')?.disabled)
    await focusMain()
    await page.keyboard.press('n')
    assert.equal(await page.locator('#add-bookmark-form').count(), 0, 'Free limit applies to shortcut')
    await page.setViewportSize({ width: 375, height: 900 })
    await help.evaluate(el => { el.parentElement.open = true })
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, 'Shortcut help fits on mobile')
    await visit('/u/fixture')
    await search.waitFor()
    assert.equal(await help.count(), 0, 'Owner shortcuts stay off public profiles')
    await focusMain()
    await page.keyboard.press('/')
    assert.equal(await search.evaluate(el => el === document.activeElement), false)
    signedIn = false
    await visit('/')
    await page.locator('.hero-demo').waitFor()
    await focusMain()
    await page.keyboard.press('n')
    assert.equal(await page.locator('#add-bookmark-form').count(), 0)
    await page.setViewportSize({ width: 375, height: 900 })
    signedIn = true
    await visit('/settings?tab=preferences')
    await enable.waitFor()
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true)
    assert.deepEqual(errors, [])
    await context.close()
    console.log(`${theme}: shortcuts, typing guards, preference persistence, plan limit and route scope passed`)
  }
} finally {
  await browser.close()
  await server.close()
}

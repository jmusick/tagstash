// Run after npm run build. Uses only fixture API responses; no D1 or live account.
import assert from 'node:assert/strict'
import { readdirSync, existsSync, mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { preview } from 'vite'
import { chromium } from 'playwright-core'

const cache = process.env.PLAYWRIGHT_BROWSERS_PATH || (process.platform === 'win32'
  ? join(process.env.LOCALAPPDATA, 'ms-playwright') : join(homedir(), '.cache/ms-playwright'))
const executablePath = process.env.LAYOUT_CHROMIUM_PATH || readdirSync(cache)
  .filter((name) => /^chromium-\d+$/.test(name))
  .sort((a, b) => Number(b.split('-')[1]) - Number(a.split('-')[1]))
  .flatMap((name) => ['chrome-win64/chrome.exe', 'chrome-linux64/chrome', 'chrome-linux/chrome', 'chrome-mac-arm64/Chromium.app/Contents/MacOS/Chromium', 'chrome-mac/Chromium.app/Contents/MacOS/Chromium']
    .map((suffix) => join(cache, name, suffix))).find(existsSync)
assert.ok(executablePath, 'Install Chromium or set LAYOUT_CHROMIUM_PATH')
const server = await preview({ preview: { host: '127.0.0.1', port: 0, open: false } })
const browser = await chromium.launch({ executablePath, headless: true })
const origin = server.resolvedUrls.local[0]
const tags = ['art', 'code', 'design', 'food', 'games', 'music', 'news', 'science', 'travel']
  .map((name, id) => ({ id: id + 1, name, count: 3 }))
const bookmarks = Array.from({ length: 21 }, (_, i) => ({
  id: i + 1, title: `Bookmark ${String(i + 1).padStart(2, '0')}`,
  url: `https://example.test/${i + 1}`, created_at: `2026-10-${String(i + 1).padStart(2, '0')} 12:00:00`,
  description: 'A saved page for the mobile library check.', tags: i === 0 ? [] : [tags[i % tags.length]],
  is_favorite: i === 1 ? 1 : 0, note: i === 2 ? 'Remember this page' : null,
}))
const screenshotDir = process.env.LAYOUT_SCREENSHOT_DIR
if (screenshotDir) mkdirSync(resolve(screenshotDir), { recursive: true })
try {
  for (const theme of ['slate', 'midnight', 'light']) {
    const context = await browser.newContext({ viewport: { width: 375, height: 812 }, isMobile: true, hasTouch: true })
    const page = await context.newPage()
    const errors = []
    page.on('pageerror', (error) => errors.push(error.message))
    await page.route('**/*', async (route) => {
      const url = new URL(route.request().url())
      if (url.origin !== new URL(origin).origin) return route.abort()
      if (!url.pathname.startsWith('/api/')) return route.continue()
      assert.equal(route.request().method(), 'GET', 'Layout checks must never write data')
      const data = url.pathname === '/api/auth/me'
        ? { user: { id: 1, username: 'layoutfixture', membership_tier: 'free', theme } }
        : url.pathname === '/api/bookmarks' ? { bookmarks }
          : url.pathname === '/api/bookmarks/tags/all' ? { tags }
            : url.pathname.startsWith('/api/profiles/') ? { profile: { username: 'layoutfixture' }, bookmarks, tags } : {}
      return route.fulfill({ json: data })
    })
    await page.goto(origin)
    await page.locator('.bookmark-card').first().waitFor()
    await page.evaluate(() => document.fonts.ready)
    await page.getByRole('button', { name: 'Decline', exact: true }).click()
    const filters = page.locator('.browser-filters-toggle')
    assert.ok((await filters.boundingBox()).y < 400, `${theme}: filters are near search`)
    assert.ok((await page.locator('.bookmark-card').first().boundingBox()).y < 600, `${theme}: first result stays in view`)
    assert.equal(await page.locator('#bookmark-filters').isVisible(), false)
    assert.equal(await page.locator('#library-plan-details').isVisible(), false)
    for (const action of await page.locator('.bookmark-card').first().locator('.icon-btn').all()) {
      const box = await action.boundingBox()
      assert.ok(box.width >= 44 && box.height >= 44, 'Row actions must be 44px targets')
    }
    await filters.click()
    if (screenshotDir) await page.screenshot({ path: join(screenshotDir, `${theme}-filters.png`) })
    await page.getByRole('button', { name: 'code, 3 bookmarks', exact: true }).click()
    await page.waitForFunction(() => document.querySelectorAll('.bookmark-card').length === 3)
    const chips = await page.locator('.tag-cloud-item').evaluateAll((items) => items.map((item) => item.getBoundingClientRect().y))
    assert.ok(new Set(chips).size < chips.length, 'Tags wrap with multiple tags on a row')
    await filters.click()
    assert.equal(await page.locator('.bookmark-card').count(), 3, 'Collapsing preserves filtering')
    await page.getByRole('button', { name: 'Clear all filters', exact: true }).click()
    await page.locator('.display-options summary').click()
    await page.locator('#sortBy').selectOption('alpha')
    await page.locator('#sortDirection').selectOption('asc')
    await page.locator('#itemsPerPage').selectOption('10')
    await page.waitForFunction(() => document.querySelectorAll('.bookmark-card').length === 10)
    assert.equal(await page.locator('.bookmark-title').first().innerText(), 'Bookmark 01')
    await page.locator('.display-options summary').click()
    await page.getByRole('button', { name: 'Next page', exact: true }).first().click()
    await page.waitForFunction(() => document.querySelector('.bookmark-title')?.textContent === 'Bookmark 11')
    await page.locator('.membership-mobile-toggle').click()
    assert.equal(await page.locator('#library-plan-details').isVisible(), true)
    await page.locator('.membership-mobile-toggle').click()
    await filters.click()
    await page.getByRole('button', { name: 'Without tags', exact: false }).click()
    await page.waitForFunction(() => document.querySelectorAll('.bookmark-card').length === 1)
    await filters.click()
    await page.getByRole('button', { name: 'Clear all filters', exact: true }).click()
    await page.evaluate(() => window.scrollTo(0, 0))
    if (screenshotDir) await page.screenshot({ path: join(screenshotDir, `${theme}-mobile.png`) })
    await page.getByRole('button', { name: 'Select bookmarks', exact: true }).click()
    const selectionLayout = await page.locator('.bookmark-card').first().evaluate((card) => ({
      width: card.getBoundingClientRect().width, scrollWidth: card.scrollWidth,
      areas: getComputedStyle(card).gridTemplateAreas,
    }))
    assert.ok(selectionLayout.areas.includes('actions actions actions actions'))
    assert.ok(selectionLayout.scrollWidth <= selectionLayout.width + 1, 'Selection fits on a phone')
    await page.getByRole('button', { name: 'Select bookmarks', exact: true }).click()
    await page.setViewportSize({ width: 320, height: 812 })
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, 'No narrow-phone overflow')
    await page.setViewportSize({ width: 1440, height: 1000 })
    assert.equal(await page.locator('#bookmark-filters').isVisible(), true, 'Desktop filters remain visible')
    const rack = await page.locator('.browser-filters').boundingBox()
    const results = await page.locator('.bookmarks-section').boundingBox()
    assert.ok(rack.x > results.x + results.width, 'Desktop keeps the two-column layout')
    if (screenshotDir) await page.screenshot({ path: join(screenshotDir, `${theme}-desktop.png`) })
    await page.goto(new URL('/u/layoutfixture', origin).href)
    await page.locator('.bookmark-card').first().waitFor()
    await page.setViewportSize({ width: 375, height: 812 })
    await page.locator('.browser-filters-toggle').click()
    await page.getByRole('button', { name: 'code, 3 bookmarks', exact: true }).click()
    await page.waitForURL('**/u/layoutfixture?tag=code')
    assert.equal(await page.locator('.bookmark-actions').count(), 0, 'Public cards have no owner actions')
    assert.deepEqual(errors, [])
    await context.close()
    console.log(`${theme}: phone controls, filtering, sorting, paging, desktop and public profile passed`)
  }
} finally {
  await browser.close()
  await new Promise((done) => server.httpServer.close(done))
}

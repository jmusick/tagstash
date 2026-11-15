// Run after npm run build. Fixture responses only; never writes to a live API.
import assert from 'node:assert/strict'
import { readdirSync, existsSync, readFileSync, mkdirSync } from 'node:fs'
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
const manifest = JSON.parse(readFileSync('dist/.vite/manifest.json', 'utf8'))
const server = await preview({ preview: { host: '127.0.0.1', port: 0, open: false } })
const browser = await chromium.launch({ executablePath, headless: true })
const origin = server.resolvedUrls.local[0]
const tags = ['design', 'reference', 'recipes'].map((name, i) => ({ id: i + 1, name, count: 1 }))
const bookmarks = [{ id: 1, title: 'Example bookmark', url: 'https://example.test/', tags: [tags[0]], created_at: '2026-10-01 12:00:00' }]
const screenshotDir = process.env.LAYOUT_SCREENSHOT_DIR
if (screenshotDir) mkdirSync(screenshotDir, { recursive: true })

try {
  for (const theme of ['slate', 'midnight', 'light']) {
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } })
    let signedIn = false
    const page = await context.newPage()
    const errors = []
    page.on('pageerror', error => errors.push(error.message))
    await context.addInitScript(value => localStorage.setItem('tagstash-theme', value), theme)
    await context.route('**/*', route => {
      const url = new URL(route.request().url())
      if (url.origin !== new URL(origin).origin) return route.abort()
      if (!url.pathname.startsWith('/api/')) return route.continue()
      if (route.request().method() !== 'GET') return route.fulfill({ status: 400, json: { error: 'Fixture refused this change' } })
      if (url.pathname === '/api/auth/me') return route.fulfill({ status: signedIn ? 200 : 401, json: signedIn ? { user: { id: 1, username: 'fixture', theme, membership_tier: 'free' } } : {} })
      const data = url.pathname === '/api/bookmarks' ? { bookmarks }
        : url.pathname === '/api/bookmarks/tags/all' ? { tags }
          : url.pathname === '/api/bookmarks/trash' ? { bookmarks: [], available: true }
            : url.pathname.startsWith('/api/profiles/') ? { profile: { username: 'fixture' }, bookmarks, tags }
              : { plans: [] }
      return route.fulfill({ json: data })
    })
    const visit = path => page.goto(new URL(path, origin).href)
    const noOverflow = async () => assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, 'No horizontal overflow')

    await visit('/')
    await page.locator('.tag-demo-tags').first().waitFor()
    await page.getByRole('button', { name: 'Decline', exact: true }).click()
    await page.evaluate(() => document.fonts.ready)
    for (const width of [1280, 375]) {
      await page.setViewportSize({ width, height: 900 })
      const demo = page.locator('.hero-demo .tag-demo')
      const initialHeight = (await demo.boundingBox()).height
      await demo.getByRole('button', { name: 'recipes', exact: true }).click()
      await demo.getByRole('button', { name: 'hiking', exact: true }).click()
      await demo.getByText('No bookmarks have all of those tags.').waitFor()
      assert.equal((await demo.boundingBox()).height, initialHeight, 'Demo reserves its height when filtering')
      await demo.getByRole('button', { name: 'Clear tags' }).click()
      assert.equal(await demo.locator('.tag-demo-item').count(), 6)
      if (screenshotDir) await demo.screenshot({ path: join(screenshotDir, `${theme}-demo-${width}.png`) })
      await noOverflow()
    }
    await visit('/pricing')
    const pro = page.locator('.pricing-plan--pro .features-button')
    await pro.waitFor()
    assert.equal(await pro.innerText(), 'Start free, upgrade from Settings')
    assert.equal(await pro.getAttribute('href'), '/?signup=1#account')
    await visit('/privacy')
    await page.locator('.privacy-content h2').first().waitFor()
    assert.equal(await page.locator('.privacy-content h2').first().evaluate(el => getComputedStyle(el).color), await page.locator('.privacy-content h1').evaluate(el => getComputedStyle(el).color))
    await visit('/missing-page')
    await page.getByRole('link', { name: 'Go to the homepage' }).waitFor()
    await noOverflow()
    await page.setViewportSize({ width: 1280, height: 900 })
    const missing = await page.locator('.not-found-content').boundingBox()
    assert.ok(Math.abs(missing.x + missing.width / 2 - 640) < 2, '404 content is centered across the full page')
    if (screenshotDir) await page.screenshot({ path: join(screenshotDir, `${theme}-404.png`), fullPage: true })
    await page.setViewportSize({ width: 375, height: 900 })
    await visit('/u/fixture?tag=design')
    const profileLinks = page.locator('.public-profile-links')
    await profileLinks.getByRole('link', { name: 'Make your own' }).waitFor()
    assert.match(await profileLinks.getByRole('link', { name: 'RSS feed for these tags' }).getAttribute('href'), /feed\.xml\?tag=design$/)
    await page.getByRole('button', { name: /Tags and filters/ }).click()
    await page.locator('.tag-cloud').getByRole('button', { name: 'Add reference to filter', exact: true }).click()
    await page.waitForFunction(() => document.querySelector('.public-profile-links a')?.href.includes('tag=reference'))
    assert.match(await profileLinks.getByRole('link', { name: 'RSS feed for these tags' }).getAttribute('href'), /tag=design&tag=reference$/)

    signedIn = true
    await visit('/')
    await page.locator('.bookmark-card').waitFor()
    await page.getByRole('button', { name: 'Add bookmark', exact: true }).click()
    assert.deepEqual(await page.locator('.add-bookmark-form label').allTextContents(), ['URL *', 'Title *', 'Tags', 'Description (optional)', 'Note (optional, private)'])
    await page.locator('.add-bookmark-form').getByRole('button', { name: 'Cancel', exact: true }).click()
    await page.getByRole('button', { name: 'Edit bookmark', exact: true }).click()
    assert.deepEqual(await page.locator('.bookmark-edit-form label').allTextContents(), ['URL', 'Title', 'Tags', 'Description', 'Note (private)'])
    await page.locator('.bookmark-edit-form').getByRole('button', { name: 'Cancel', exact: true }).click()
    await page.getByPlaceholder('Search titles, links, notes and tags').fill('nothing-matches')
    await page.getByText('No bookmarks match “nothing-matches” with the current filters.').waitFor()
    await page.getByRole('link', { name: 'Search tips', exact: true }).click()
    assert.equal(await page.locator('#search-tips').getAttribute('open'), '')
    assert.equal(await page.locator('#search-tips summary').evaluate(el => el === document.activeElement), true)

    await visit('/tags')
    await page.getByRole('heading', { name: 'Manage tags', exact: true }).waitFor()
    await page.locator('.tag-cloud').waitFor()
    assert.equal(await page.locator('.tag-cloud').count(), 1)
    assert.equal(await page.locator('.tags-plural-report').getAttribute('open'), null)
    await page.getByRole('button', { name: 'design, 1 bookmark', exact: true }).click()
    await page.getByLabel('New name', { exact: true }).fill('visual')
    await page.getByRole('button', { name: 'Rename Tag', exact: true }).click()
    await page.getByText('Fixture refused this change', { exact: true }).waitFor()
    await page.getByRole('button', { name: 'Merge tags', exact: true }).click()
    assert.equal(await page.locator('.tag-cloud').count(), 1)
    await page.getByRole('button', { name: 'design, 1 bookmark', exact: true }).click()
    await page.getByRole('button', { name: 'reference, 1 bookmark', exact: true }).click()
    assert.equal(await page.getByRole('button', { name: 'Merge Tags', exact: true }).isEnabled(), true)
    await page.setViewportSize({ width: 320, height: 900 })
    await noOverflow()
    if (screenshotDir) await page.screenshot({ path: join(screenshotDir, `${theme}-tags-polish.png`), fullPage: true })
    await visit('/trash')
    await page.getByRole('heading', { name: 'Your trash is empty' }).waitFor()
    await page.getByText(/You can restore them here/).waitFor()
    await visit('/duplicates')
    await page.getByRole('heading', { name: 'No duplicates found' }).waitFor()
    await page.getByText(/Your live bookmarks have no matching URLs/).waitFor()
    await visit('/missing-page')
    await page.getByRole('link', { name: 'Search your bookmarks' }).waitFor()
    await noOverflow()
    assert.deepEqual(errors, [])
    await context.close()
    console.log(`${theme}: forms, tags, search recovery, demo, pricing, privacy, profiles and empty pages passed`)
  }

  // Hold each public route chunk open to exercise the actual Suspense fallback.
  for (const name of ['Features', 'Pricing', 'Developers']) {
    const context = await browser.newContext()
    const page = await context.newPage()
    let release
    const pending = new Promise(resolve => { release = resolve })
    const file = manifest[`src/components/${name}Page.jsx`].file
    await page.route(`**/${file}`, async route => { await pending; await route.continue() })
    await page.route('**/api/**', route => route.fulfill({ status: 401, json: {} }))
    try {
      await page.goto(new URL(`/${name.toLowerCase()}`, origin).href, { waitUntil: 'domcontentloaded' })
      await page.locator('.route-loading-main[aria-busy="true"]').waitFor()
      assert.equal(await page.locator('.route-loading .public-header').isVisible(), true)
      release()
      await page.locator('.route-loading').waitFor({ state: 'detached' })
      assert.equal(await page.locator('main h1').count(), 1)
    } finally { release(); await context.close() }
  }
  console.log('Features, Pricing and Developers: delayed route chunks retain page chrome and static placeholders')
} finally {
  await browser.close()
  await server.close()
}

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
// All account reads below are fixtures. No request reaches a live API.
const screenshotDir = process.env.LAYOUT_SCREENSHOT_DIR
if (screenshotDir) mkdirSync(resolve(screenshotDir), { recursive: true })
try {
  for (const theme of ['slate', 'midnight', 'light']) {
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } })
    const page = await context.newPage()
    const errors = []
    let admin = false
    let keyReads = 0
    let billingReads = 0
    let passwordChangeRecommended = false
    let passwordAttempts = 0
    const user = () => ({ id: 1, username: 'settingsfixture', email: 'fixture@example.test', theme,
      role: admin ? 'super_admin' : 'user', membership_tier: 'free', email_verified: 1,
      password_change_recommended: passwordChangeRecommended })
    page.on('pageerror', (error) => errors.push(error.message))
    await page.route('**/*', async (route) => {
      const url = new URL(route.request().url())
      if (url.origin !== new URL(origin).origin) return route.abort()
      if (!url.pathname.startsWith('/api/')) return route.continue()
      if (url.pathname === '/api/auth/password' && route.request().method() === 'PUT') {
        // Fixture responses only: exercise refused/successful changes without touching an account.
        passwordAttempts++
        if (passwordAttempts === 1) return route.fulfill({ status: 401, json: { error: 'Incorrect current password' } })
        passwordChangeRecommended = false
        return route.fulfill({ json: { message: 'Password updated successfully' } })
      }
      assert.equal(route.request().method(), 'GET', 'Settings navigation must never mutate account data')
      if (url.pathname === '/api/auth/api-keys') keyReads++
      if (url.pathname === '/api/billing/status') billingReads++
      return route.fulfill({ json: {
        user: user(), bookmarks: [], tags: [], apiKeys: [], plans: [], subscription: null,
        users: [], events: [],
      } })
    })
    const heading = page.locator('#settings-section-heading')
    const menu = page.locator('.settings-navigation-toggle')
    const nav = page.getByRole('navigation', { name: 'Settings sections', exact: true })
    const openMenu = async () => {
      if (await menu.isVisible() && await menu.getAttribute('aria-expanded') === 'false') await menu.click()
    }
    const choose = async (name) => {
      await openMenu()
      await nav.getByRole('link', { name, exact: true }).click()
      await heading.filter({ hasText: name }).waitFor()
      assert.equal(await heading.evaluate((el) => el === document.activeElement), true, 'Section selection focuses the heading')
    }
    await page.goto(new URL('/settings', origin).href)
    await heading.filter({ hasText: 'Preferences' }).waitFor()
    await page.getByRole('button', { name: 'Decline', exact: true }).click()
    assert.deepEqual(await nav.locator('.settings-nav-group h2').allTextContents(), ['Library', 'Account', 'Sharing & API', 'Billing', 'Danger zone'])
    assert.deepEqual(await nav.locator('.settings-nav-danger a').allTextContents(), ['Reset Library', 'Delete Account'])
    assert.equal(await menu.isVisible(), false)
    assert.equal(await nav.getByRole('link', { name: 'Admin', exact: true }).count(), 0)
    const links = await nav.getByRole('link').evaluateAll((items) => items.map((item) => ({ name: item.textContent, href: item.href })))
    // Every section supports a direct URL and survives a reload.
    for (const { name, href } of links) {
      await page.goto(href)
      await heading.filter({ hasText: name }).waitFor()
      assert.equal(await nav.getByRole('link', { name, exact: true }).getAttribute('aria-current'), 'page')
      await page.reload()
      await heading.filter({ hasText: name }).waitFor()
    }
    assert.ok(keyReads >= 2, 'Direct API key links load keys')
    assert.equal(billingReads, 2, 'Billing sync runs once per section entry')
    await choose('Username')
    await page.locator('#username-password').fill('unsaved-password')
    await choose('Email')
    await page.goBack()
    await heading.filter({ hasText: 'Username' }).waitFor()
    assert.equal(await page.locator('#username-password').inputValue(), '', 'Returning to a section clears credentials')
    await page.goForward()
    await heading.filter({ hasText: 'Email' }).waitFor()
    if (screenshotDir) await page.screenshot({ path: join(screenshotDir, `${theme}-settings-desktop.png`) })
    for (const path of ['/settings?tab=not-a-section', '/settings?tab=admin']) {
      await page.goto(new URL(path, origin).href)
      await heading.filter({ hasText: 'Preferences' }).waitFor()
    }
    for (const [hash, name] of [['api-keys', 'API Keys'], ['public-profile', 'Public Profile'], ['sessions', 'Sessions'], ['import-export', 'Import / Export']]) {
      await page.goto(new URL(`/settings#${hash}`, origin).href)
      await heading.filter({ hasText: name }).waitFor()
    }
    // Mobile: collapsed menu, natural Tab order through grouped links, Enter activation.
    await page.setViewportSize({ width: 320, height: 900 })
    await page.goto(new URL('/settings', origin).href)
    await heading.waitFor()
    assert.equal(await nav.isVisible(), false)
    await menu.focus()
    await page.keyboard.press('Enter')
    assert.equal(await nav.isVisible(), true)
    for (const { name } of links) {
      await page.keyboard.press('Tab')
      assert.equal(await page.evaluate(() => document.activeElement.textContent), name, 'Keyboard order follows the visible groups')
    }
    await page.keyboard.press('Enter')
    await heading.filter({ hasText: 'Delete Account' }).waitFor()
    assert.equal(await heading.evaluate((el) => el === document.activeElement), true)
    assert.equal(await nav.isVisible(), false)
    await page.keyboard.press('Tab')
    assert.equal(await page.evaluate(() => document.activeElement.id), 'delete-account-password')
    for (const width of [320, 768]) {
      await page.setViewportSize({ width, height: 1000 })
      for (const { name } of links) {
        await choose(name)
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, `${name} fits at ${width}px`)
      }
    }
    await openMenu()
    if (screenshotDir) await page.screenshot({ path: join(screenshotDir, `${theme}-settings-mobile-menu.png`) })
    admin = true
    await page.goto(new URL('/settings?tab=admin', origin).href)
    await heading.filter({ hasText: 'Admin' }).waitFor()
    await openMenu()
    assert.equal(await nav.getByRole('link', { name: 'Admin', exact: true }).count(), 1)
    admin = false
    passwordChangeRecommended = true
    await page.goto(new URL('/', origin).href)
    const advisory = page.locator('.password-change-notice')
    await advisory.waitFor()
    await page.reload()
    await advisory.waitFor()
    assert.match(await advisory.textContent(), /Only its first 72 bytes are checked/)
    assert.equal(await advisory.getAttribute('role'), 'status')
    for (const width of [320, 1440]) {
      await page.setViewportSize({ width, height: 1000 })
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, `Advisory fits at ${width}px`)
    }
    await advisory.getByRole('link', { name: 'Choose a new password' }).click()
    await heading.filter({ hasText: 'Password' }).waitFor()
    if (screenshotDir) await page.screenshot({ path: join(screenshotDir, `${theme}-password-advisory.png`) })
    await page.locator('#current-password').fill('legacy-password-fixture')
    await page.locator('#new-password').fill('replacement-password-fixture')
    await page.locator('#confirm-password').fill('replacement-password-fixture')
    await page.getByRole('button', { name: 'Update Password', exact: true }).click()
    await page.getByText('Incorrect current password', { exact: true }).waitFor()
    assert.equal(await advisory.isVisible(), true, 'A refused change keeps the advisory')
    await page.getByRole('button', { name: 'Update Password', exact: true }).click()
    await page.getByText('Password updated successfully!', { exact: true }).waitFor()
    assert.equal(await advisory.count(), 0, 'A successful change clears the advisory')
    await page.reload()
    await heading.filter({ hasText: 'Password' }).waitFor()
    assert.equal(await advisory.count(), 0, 'The replacement session has no advisory')
    assert.equal(passwordAttempts, 2)
    assert.deepEqual(errors, [])
    await context.close()
    console.log(`${theme}: settings groups, deep links, history, keyboard, mobile and admin checks passed`)
  }
} finally {
  await browser.close()
  await new Promise((done) => server.httpServer.close(done))
}

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
    page.setDefaultTimeout(8000)
    const errors = []
    page.on('pageerror', error => errors.push(error.message))
    let paid = true
    let accountId = 1
    const requests = []
    const saves = []
    const pending = []
    await context.addInitScript(value => localStorage.setItem('tagstash-theme', value), theme)
    const bookmarks = [1, 2].map(id => ({ id, title: `Bookmark ${id}`, url: `https://example.test/${id}`, description: 'Description', tags: [{ name: 'reading', id: 1 }] }))
    await context.route('**/*', async route => {
      const request = route.request()
      const url = new URL(request.url())
      if (url.origin !== new URL(origin).origin) return route.abort()
      if (!url.pathname.startsWith('/api/')) return route.continue()
      if (url.pathname === '/api/bookmarks/suggest-tags') {
        assert.equal(request.method(), 'POST')
        assert.equal(request.headers()['x-tagstash-client'], 'web')
        requests.push(request.postDataJSON())
        pending.push(route)
        return
      }
      if (url.pathname === '/api/auth/me') return route.fulfill({ json: { user: { id: accountId, username: 'fixture', theme, membership_tier: paid ? 'paid' : 'free' } } })
      if (['/api/bookmarks/meta', '/api/bookmarks/meta-description'].includes(url.pathname)) return route.fulfill({ json: {} })
      if (request.method() === 'POST' || request.method() === 'PUT') {
        assert.match(url.pathname, /^\/api\/bookmarks(?:\/\d+)?$/)
        saves.push(request.postDataJSON())
        return route.fulfill({ json: { bookmark: { id: 3 } } })
      }
      return route.fulfill({ json: { bookmarks, tags: [{ name: 'reading', id: 1 }], plans: [] } })
    })
    const visit = path => page.goto(new URL(path, origin).href)
    const waitCount = async count => {
      for (let i = 0; i < 100 && requests.length < count; i++) await page.waitForTimeout(10)
      assert.equal(requests.length, count)
    }
    const reply = async (status = 200, suggestions = ['react']) => {
      for (let i = 0; i < 100 && !pending.length; i++) await page.waitForTimeout(10)
      const route = pending.shift()
      assert.ok(route)
      await route.fulfill({ status, json: status === 200 ? { suggestions } : { error: 'Fixture refusal' } })
    }
    await visit('/')
    await page.getByRole('button', { name: 'Add bookmark', exact: true }).click()
    await page.getByRole('button', { name: 'Decline', exact: true }).click()
    const add = page.locator('#add-bookmark-form')
    const control = add.locator('.tag-recommendations')
    const suggest = control.getByRole('button', { name: 'Suggest tags', exact: true })
    const status = control.getByRole('status')
    await page.locator('#url').fill('https://example.test/new')
    await page.locator('#title').fill('React')
    await page.locator('#tags').fill('reading')
    await page.locator('#note').fill('SECRET NOTE')
    await waitCount(0)
    await suggest.dblclick()
    await status.filter({ hasText: 'Finding' }).waitFor()
    await waitCount(1)
    assert.deepEqual(requests[0], { url: 'https://example.test/new', title: 'React', description: '', selectedTags: ['reading'] })
    await reply(200, ['reading', 'React', 'react', 'performance'])
    const react = control.getByRole('button', { name: 'Add suggested tag React', exact: true })
    await react.waitFor()
    assert.equal(await control.locator('.tag-stock').count(), 2)
    await suggest.dispatchEvent('click')
    await waitCount(1) // Completed result reused without another inference.
    await react.focus()
    await page.keyboard.press('Enter')
    await add.getByRole('button', { name: 'Remove tag react', exact: true }).waitFor()
    // Accepting one keeps the rest without another inference; focus moves to the next.
    const performance = control.getByRole('button', { name: 'Add suggested tag performance', exact: true })
    assert.equal(await control.locator('.tag-stock').count(), 1)
    assert.equal(await performance.evaluate(el => el === document.activeElement), true)
    await suggest.dispatchEvent('click')
    await waitCount(1)
    assert.equal(saves.length, 0)
    // Removing an accepted tag brings its suggestion back.
    await add.getByRole('button', { name: 'Remove tag react', exact: true }).click()
    await react.waitFor()
    await performance.click()
    await react.click()
    await add.getByRole('button', { name: 'Remove tag performance', exact: true }).waitFor()
    assert.equal(await suggest.evaluate(el => el === document.activeElement), true)
    await status.filter({ hasText: 'All suggestions added' }).waitFor()
    await waitCount(1)
    for (const name of ['react', 'performance']) await add.getByRole('button', { name: `Remove tag ${name}`, exact: true }).click()
    await page.locator('#title').fill('React hooks')

    // Each input change invalidates a pending request, even if changed back.
    for (const selector of ['#url', '#title', '#description', '#tags']) {
      await suggest.click()
      await status.filter({ hasText: 'Finding' }).waitFor()
      const input = page.locator(selector)
      const before = await input.inputValue()
      await input.fill(before + 'x')
      await input.fill(before)
      await reply(200, ['stale'])
      await page.waitForTimeout(25)
      assert.equal(await control.getByRole('button', { name: 'Add suggested tag stale' }).count(), 0)
    }
    // An older request cannot override a newer one.
    await suggest.click()
    await status.filter({ hasText: 'Finding' }).waitFor()
    await page.locator('#title').fill('New input')
    await suggest.click()
    await status.filter({ hasText: 'Finding' }).waitFor()
    const older = pending.shift()
    await reply(200, ['newer'])
    await control.getByRole('button', { name: 'Add suggested tag newer' }).waitFor()
    await older.fulfill({ json: { suggestions: ['older'] } })
    await page.waitForTimeout(25)
    assert.equal(await control.getByRole('button', { name: 'Add suggested tag older' }).count(), 0)
    await page.locator('#title').fill('Errors and empty')
    for (const code of [200, 429, 503, 502, 403]) {
      await suggest.click()
      await status.filter({ hasText: 'Finding' }).waitFor()
      await reply(code, [])
      await status.filter({ hasText: code === 200 ? 'No matching' : code === 429 ? 'Too many' : code === 503 ? 'unavailable' : code === 403 ? 'Pro plan' : 'Could not' }).waitFor()
      if (code === 200) await page.locator('#title').fill('Retry states')
    }
    await page.setViewportSize({ width: 390, height: 844 })
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true)
    // Manual keyboard save remains available after inference failures.
    await page.locator('#tags').press('Enter')
    await add.waitFor({ state: 'detached' })
    assert.equal(saves.length, 1)
    assert.deepEqual(saves[0].tags, ['reading'])
    await page.setViewportSize({ width: 1280, height: 900 })

    // Closing/reopening, routes, and account changes cannot revive pending results.
    for (const mode of ['close', 'route', 'account']) {
      await page.getByRole('button', { name: 'Add bookmark', exact: true }).click()
      await page.locator('#url').fill('https://example.test/new')
      await page.locator('#title').fill('Late result')
      await suggest.click()
      await status.filter({ hasText: 'Finding' }).waitFor()
      // Let the request reach the interception before closing or reloading cancels it.
      for (let i = 0; i < 100 && !pending.length; i++) await page.waitForTimeout(10)
      if (mode === 'close') {
        await page.getByRole('button', { name: 'Cancel', exact: true }).first().click()
      } else if (mode === 'route') {
        await page.getByRole('navigation', { name: 'Main' }).getByRole('button', { name: 'Tags', exact: true }).click()
      } else {
        accountId++
        await page.reload()
      }
      await reply(200, ['late'])
      if (mode === 'route') await visit('/')
      await page.getByRole('button', { name: 'Add bookmark', exact: true }).click()
      assert.equal(await control.locator('.tag-stock').count(), 0)
      await page.getByRole('button', { name: 'Cancel', exact: true }).first().click()
    }

    // Edit accepts a tag into the existing editable pills and saves normally.
    const edit = page.locator('.bookmark-card').first()
    await edit.getByRole('button', { name: 'Edit bookmark', exact: true }).click()
    const editControl = edit.locator('.tag-recommendations')
    const editSuggest = editControl.getByRole('button', { name: 'Suggest tags', exact: true })
    await editSuggest.click()
    await editControl.getByRole('status').filter({ hasText: 'Finding' }).waitFor()
    await reply(200, ['reading', 'design'])
    await editControl.getByRole('button', { name: 'Add suggested tag design', exact: true }).click()
    await edit.getByRole('button', { name: 'Remove tag design', exact: true }).waitFor()
    await edit.locator('.bookmark-edit-actions').getByRole('button', { name: 'Save', exact: true }).click()
    await editControl.waitFor({ state: 'detached' })
    assert.deepEqual(saves[1].tags, ['reading', 'design'])
    await edit.getByRole('button', { name: 'Edit bookmark', exact: true }).click()
    await editSuggest.click()
    await editControl.getByRole('status').filter({ hasText: 'Finding' }).waitFor()
    await page.locator('.bookmark-card').nth(1).getByRole('button', { name: 'Edit bookmark', exact: true }).click()
    await reply(200, ['wrong-bookmark'])
    await page.waitForTimeout(25)
    assert.equal(await page.getByRole('button', { name: 'Add suggested tag wrong-bookmark' }).count(), 0)

    // The fiftieth tag is allowed; another suggestion cannot exceed the cap.
    bookmarks[0].tags = Array.from({ length: 49 }, (_, id) => ({ id: id + 10, name: `tag${id}` }))
    await page.reload()
    await edit.getByRole('button', { name: 'Edit bookmark', exact: true }).click()
    await editSuggest.click()
    await editControl.getByRole('status').filter({ hasText: 'Finding' }).waitFor()
    await reply(200, ['last-slot', 'overflow'])
    await editControl.getByRole('button', { name: 'Add suggested tag last-slot', exact: true }).click()
    await edit.getByRole('button', { name: 'Remove tag last-slot', exact: true }).waitFor()
    assert.equal(await editControl.getByRole('status').textContent(), 'A bookmark can have at most 50 tags.')
    const beforeCapClick = requests.length
    await editSuggest.dispatchEvent('click')
    assert.equal(requests.length, beforeCapClick)
    assert.equal(await editControl.locator('.tag-stock').count(), 0)

    paid = false
    await page.reload()
    await page.getByRole('button', { name: 'Add bookmark', exact: true }).click()
    await control.getByRole('link', { name: 'Upgrade to Pro', exact: true }).waitFor()
    assert.equal(await suggest.count(), 0)
    assert.deepEqual(errors, [])
    await context.close()
    console.log(`${theme}: explicit requests, deduplication, acceptance, stale responses, errors, saves, Pro controls and narrow layout passed`)
  }
} finally {
  await browser.close()
  await server.close()
}

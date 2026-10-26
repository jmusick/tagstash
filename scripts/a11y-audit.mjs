#!/usr/bin/env node
// Repeatable accessibility audit: axe-core driven through Playwright's Chromium
// against a LOCALLY served build, in all three themes (slate, midnight, light).
//
//   npm run build
//   npx wrangler pages dev dist --local --port 5000     # in another terminal
//   npm run test:a11y
//
// It seeds two local test users (an owner and a super admin) into the local D1
// database, logs in through the real login form, and scans:
//   anonymous : /, login error + sign-up + forgot-password states, the "finish deleting your
//               account" screen (form, error, pending) and the "account deleted" page,
//               /reset-password (form, recovery unavailable, success with keys revoked),
//               /features, /developers (also no-JS and mobile), /privacy, /support, a public profile (/u/<owner>)
//   owner     : / (bookmark list, untagged/domain/month filters and no matches, edit mode, add form,
//               a bookmark note collapsed and expanded, the Has note filter (active, no matches, no notes yet),
//               the add and edit forms with a note and a refused/invalid note save,
//               select mode: none selected, some selected, the tag form with a validation error and a
//               refused request, export formats, tabs blocked by the browser, the move-to-trash
//               confirmation, a refused delete, the "moved to the trash" result with Undo (and a
//               refused/successful Undo), and a selection cleared by a filter; the single-delete
//               "moved to the trash" notice with Undo and a refused Undo; every bulk and delete
//               request is answered by an interception so the seeded library is never changed),
//               /trash (empty, empty with the load failing, items, some selected, the delete-forever
//               and empty-trash confirmations, a refused delete forever, the per-item delete-forever
//               confirmation, a restore blocked at the free-plan limit with the upgrade prompt, a
//               refused restore and a successful restore; every trash request is answered by an
//               interception, so nothing is trashed or restored), /settings (every tab,
//               plus an error, a success banner, the import preview and API Keys loading,
//               empty, generating, show-once/active, revoked and creation-error states), /tags
//               (empty merge slots, a selected merge pair, the rename form with a
//               name error and a would-merge name, and both inline confirmations), and the
//               Settings -> Reset Library form (confirmation error, refused password, pending,
//               success), Settings -> Sessions (idle, confirm, pending, success,
//               error) and Settings -> Delete Account form with its confirmation error, a refused
//               password, the pending state and the hand-off to "finish deleting"
//   admin     : /settings -> Admin and Delete Account (the super admin refusal note)
// The cookie consent banner is visible in every scan by default (each theme/role
// runs in a fresh context). --check-third-parties adds two scans after consent.
// Exit code is 1 on any accessibility or style CSP violation.
// The reset, deletion and sign-out-everywhere states answer from intercepted requests
// (page.route), so seeded users keep their data and sessions.
//
// Configuration (flags or env):
//   --base-url <url>  | A11Y_BASE_URL         default http://127.0.0.1:5000 (localhost only)
//   --themes a,b      | A11Y_THEMES           default slate,midnight,light
//   --roles a,b       | A11Y_ROLES            default anon,owner,admin
//   --chromium <path> | A11Y_CHROMIUM_PATH    default: newest Chromium in the Playwright cache
//   --skip-seed       | A11Y_SKIP_SEED=1      do not (re)seed the test users
//   --check-third-parties                   also accept consent/load GA and require a working Turnstile test widget
//   A11Y_D1_PERSIST_TO                        wrangler --persist-to dir, if the server uses one
//
// Safety: refuses any non-loopback host, and only ever seeds with `wrangler d1
// execute --local`. Never point this at production.

import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { homedir, tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import bcrypt from 'bcryptjs'
import { chromium } from 'playwright-core'
import { API_DOC_ROUTES } from '../src/content/developersApi.js'
import { DEVELOPERS_META } from '../src/utils/pageMeta.js'
import { duplicateStates } from './a11y-duplicates.mjs'
import { noteStates } from './a11y-notes.mjs'

const require = createRequire(import.meta.url)
const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)))

// ---------------------------------------------------------------- config ----

function argValue(name) {
  const i = process.argv.indexOf(name)
  return i !== -1 ? process.argv[i + 1] : undefined
}
const setting = (flag, envName, fallback) => argValue(flag) ?? process.env[envName] ?? fallback
const list = (value) => value.split(',').map((s) => s.trim()).filter(Boolean)

const BASE_URL = setting('--base-url', 'A11Y_BASE_URL', 'http://127.0.0.1:5000').replace(/\/+$/, '')
const THEMES = list(setting('--themes', 'A11Y_THEMES', 'slate,midnight,light'))
const ROLES = list(setting('--roles', 'A11Y_ROLES', 'anon,owner,admin'))
// --contrast-report also prints the measured ratio of the banner/button/label elements fixed for #132 and #22.
const CONTRAST_REPORT = process.argv.includes('--contrast-report')
const REPORT_SELECTORS = /auth-error|settings-error|settings-success|import-note|tag-merge-slot-label|tag-edit-hint|tag-edit-confirm|cc-btn|cc-actions|preferred-badge|btn-danger/
const SKIP_SEED = process.argv.includes('--skip-seed') || process.env.A11Y_SKIP_SEED === '1'
const CHECK_THIRD_PARTIES = process.argv.includes('--check-third-parties')
const ANALYTICS_COLLECTION = /https:\/\/[^/]*(?:google-analytics\.com|analytics\.google\.com|googletagmanager\.com)\/(?:[\w-]+\/)*collect(?:\?|$)/

// Local-only test accounts. The admin email must equal SUPER_ADMIN_EMAIL in .dev.vars.
const TEST_PASSWORD = 'a11y-Audit-pass-1'
const OWNER = { username: 'a11yowner', email: 'a11y-owner@example.test' }
const ADMIN = { username: 'a11yadmin', email: process.env.A11Y_ADMIN_EMAIL || 'admin@example.test' }

// WCAG 2.0/2.1/2.2 A and AA, plus axe's best-practice rules (landmarks/`region`, etc.).
const AXE_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa', 'best-practice']

// Known exclusions. Every entry must say why; keep this empty if at all possible.
// { rule: 'axe-rule-id', selector: 'css selector', reason: '...' }
const KNOWN_EXCLUSIONS = []

const VIEWPORT = { width: 1280, height: 900 }

function assertLocal(url) {
  const { hostname } = new URL(url)
  const local = ['localhost', '127.0.0.1', '[::1]', '::1'].includes(hostname) || hostname.endsWith('.localhost')
  if (!local) {
    console.error(`Refusing to audit ${url}: only localhost/127.0.0.1/[::1] are allowed.`)
    process.exit(2)
  }
}

// -------------------------------------------------------------- chromium ----

function findChromium() {
  const explicit = setting('--chromium', 'A11Y_CHROMIUM_PATH')
  if (explicit) {
    if (!existsSync(explicit)) throw new Error(`A11Y_CHROMIUM_PATH does not exist: ${explicit}`)
    return explicit
  }
  const roots = [
    process.env.PLAYWRIGHT_BROWSERS_PATH,
    process.env.LOCALAPPDATA && join(process.env.LOCALAPPDATA, 'ms-playwright'),
    join(homedir(), '.cache', 'ms-playwright'),
    join(homedir(), 'Library', 'Caches', 'ms-playwright'),
  ].filter(Boolean)
  const exeNames = ['chrome-win64/chrome.exe', 'chrome-win/chrome.exe', 'chrome-linux64/chrome', 'chrome-linux/chrome',
    'chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
    'chrome-mac-x64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
    'chrome-mac/Chromium.app/Contents/MacOS/Chromium']
  for (const root of roots) {
    if (!existsSync(root)) continue
    const dirs = readdirSync(root)
      .filter((d) => /^chromium-\d+$/.test(d))
      .sort((a, b) => Number(b.split('-')[1]) - Number(a.split('-')[1]))
    for (const dir of dirs) {
      for (const exe of exeNames) {
        const candidate = join(root, dir, ...exe.split('/'))
        if (existsSync(candidate)) return candidate
      }
    }
  }
  throw new Error('No Chromium found in the Playwright cache. Set A11Y_CHROMIUM_PATH to a chrome executable.')
}

// ------------------------------------------------------------------ seed ----

const sqlString = (s) => `'${String(s).replaceAll("'", "''")}'`

function seedUsers() {
  const hash = bcrypt.hashSync(TEST_PASSWORD, 10)
  const emails = [OWNER.email, ADMIN.email].map(sqlString).join(', ')
  const owned = `(SELECT id FROM users WHERE email IN (${emails}))`
  const old = "datetime('now', '-60 days')"
  const user = (u, role, isPublic) =>
    `INSERT INTO users (username, email, password_hash, membership_tier, role, email_verified, profile_public, created_at)
     VALUES (${sqlString(u.username)}, ${sqlString(u.email)}, ${sqlString(hash)}, 'free', ${sqlString(role)}, 1, ${isPublic}, ${old});`
  const bookmarks = [
    ['Tag-first bookmarking guide', 'https://example.com/guide', 'A short guide to organising links with tags.', ['reading', 'guides']],
    ['Design systems handbook', 'https://example.com/design', 'Colour, type and spacing in practice.', ['design', 'reading']],
    ['Command line tools', 'https://example.org/cli', 'Handy terminal utilities.', ['tools', 'dev']],
    ['Accessibility checklist', 'https://example.com/a11y', 'WCAG in plain language.', ['design', 'guides']],
    ['Static site generators', 'https://example.org/ssg', 'Comparing build tools.', ['tools', 'dev']],
    ['Reading list for the weekend', 'https://reading.example.com/weekend', 'Long reads.', ['reading']],
    // Deliberately untagged, so the owner list's "Without tags" filter has something to show.
    ['Unsorted link to triage', 'https://example.com/triage', 'Saved without any tags yet.', []],
  ]
  const tagNames = [...new Set(bookmarks.flatMap((b) => b[3]))]
  const statements = [
    `DELETE FROM bookmark_tags WHERE bookmark_id IN (SELECT id FROM bookmarks WHERE user_id IN ${owned});`,
    `DELETE FROM bookmarks WHERE user_id IN ${owned};`,
    `DELETE FROM favorite_tags WHERE user_id IN ${owned};`,
    `DELETE FROM api_keys WHERE user_id IN ${owned};`,
    `DELETE FROM users WHERE email IN (${emails});`,
    user(OWNER, 'user', 1),
    user(ADMIN, 'super_admin', 0),
    ...tagNames.map((t) => `INSERT OR IGNORE INTO tags (name) VALUES (${sqlString(t)});`),
  ]
  for (const [index, [title, url, description, tags]] of bookmarks.entries()) {
    const saved = sqlString(index < 4 ? '2026-09-15T12:00:00Z' : '2026-08-15T12:00:00Z')
    statements.push(
      `INSERT INTO bookmarks (user_id, title, url, description, created_at, updated_at, is_favorite)
       VALUES ((SELECT id FROM users WHERE email = ${sqlString(OWNER.email)}), ${sqlString(title)}, ${sqlString(url)}, ${sqlString(description)}, ${saved}, ${saved}, ${index === 0 ? 1 : 0});`,
      ...tags.map(
        (t) => `INSERT INTO bookmark_tags (bookmark_id, tag_id) VALUES ((SELECT MAX(id) FROM bookmarks), (SELECT id FROM tags WHERE name = ${sqlString(t)}));`
      )
    )
  }
  statements.push(
    `INSERT INTO favorite_tags (user_id, tag_id) VALUES ((SELECT id FROM users WHERE email = ${sqlString(OWNER.email)}), (SELECT id FROM tags WHERE name = 'reading'));`
  )

  const dir = mkdtempSync(join(tmpdir(), 'a11y-seed-'))
  const file = join(dir, 'seed.sql')
  writeFileSync(file, statements.join('\n'))
  const wrangler = join(ROOT, 'node_modules', 'wrangler', 'bin', 'wrangler.js')
  const args = [wrangler, 'd1', 'execute', 'tagstash-db', '--local', '--file', file]
  if (process.env.A11Y_D1_PERSIST_TO) args.push('--persist-to', process.env.A11Y_D1_PERSIST_TO)
  const result = spawnSync(process.execPath, args, { cwd: ROOT, encoding: 'utf8' })
  rmSync(dir, { recursive: true, force: true })
  if (result.status !== 0) {
    console.error(result.stdout, result.stderr)
    throw new Error('Seeding the local D1 database failed (did you run `npm run setup:db`?).')
  }
}

// ------------------------------------------------------------------ scan ----

const axeSource = readFileSync(require.resolve('axe-core/axe.min.js'), 'utf8')
const axeVersion = require('axe-core/package.json').version
const contrastRows = new Set()
const results = [] // { theme, role, label, violations }
let scanCount = 0
let incompleteCount = 0
const styleCspViolations = []

// Install before any navigation, including the SSR-only context. Console messages
// catch CSP errors too; the DOM event supplies the effective directive and source.
async function watchStyleCsp(context) {
  await context.exposeBinding('reportStyleCspViolation', ({ frame }, details) => {
    styleCspViolations.push({ url: frame.url(), ...details })
  })
  await context.addInitScript(() => {
    document.addEventListener('securitypolicyviolation', (event) => {
      if (event.effectiveDirective.startsWith('style-src')) {
        window.reportStyleCspViolation({
          directive: event.effectiveDirective, blocked: event.blockedURI,
          source: event.sourceFile, line: event.lineNumber,
        })
      }
    })
  })
  context.on('page', (page) => {
    page.on('console', (message) => {
      if (/style-src/.test(message.text()) && /content security policy/i.test(message.text())) {
        styleCspViolations.push({ url: page.url(), console: message.text() })
      }
    })
  })
}

function isExcluded(rule, node) {
  return KNOWN_EXCLUSIONS.some((e) => e.rule === rule && node.target.some((t) => String(t).includes(e.selector)))
}

async function settle(page, ms = 450) {
  await page.mouse.move(0, 0)
  await page.waitForLoadState('load')
  await page.waitForTimeout(ms) // let colour transitions finish
}

function makeScanner(page, theme, role) {
  return async function scan(label, { checkTheme = true } = {}) {
    await settle(page)
    const actualTheme = await page.evaluate(() => document.documentElement.dataset.theme)
    if (checkTheme && actualTheme !== theme) {
      throw new Error(`[${theme}/${role}] ${label}: expected data-theme="${theme}" but the page has "${actualTheme}"`)
    }
    await page.evaluate(axeSource) // evaluate (not a script tag) so the page CSP is not involved
    const axeResult = await page.evaluate(
      ({ tags, types }) => window.axe.run(document, { runOnly: { type: 'tag', values: tags }, resultTypes: types }),
      { tags: AXE_TAGS, types: CONTRAST_REPORT ? ['violations', 'incomplete', 'passes'] : ['violations', 'incomplete'] }
    )
    if (CONTRAST_REPORT) {
      for (const rule of [...axeResult.passes, ...axeResult.violations]) {
        if (rule.id !== 'color-contrast') continue
        for (const node of rule.nodes) {
          const data = node.any?.[0]?.data
          const target = node.target.join(' ')
          if (data && REPORT_SELECTORS.test(target)) {
            const name = target.split(' ').pop().replace(/:nth-child\(\d+\)/g, '')
            contrastRows.add(`${theme} | ${name} | fg ${data.fgColor} on bg ${data.bgColor} | ${data.contrastRatio}:1`)
          }
        }
      }
    }
    const violations = axeResult.violations
      .map((v) => ({ ...v, nodes: v.nodes.filter((n) => !isExcluded(v.id, n)) }))
      .filter((v) => v.nodes.length > 0)
    scanCount += 1
    incompleteCount += axeResult.incomplete.length
    results.push({ theme, role, label, violations })
    const count = violations.reduce((n, v) => n + v.nodes.length, 0)
    console.log(`  ${count === 0 ? 'ok  ' : 'FAIL'} ${label}${count ? ` (${count} node${count === 1 ? '' : 's'})` : ''}`)
  }
}

// ------------------------------------------------------------- scenarios ----

async function newContext(browser, theme) {
  const context = await browser.newContext({ viewport: VIEWPORT, reducedMotion: 'reduce' })
  await watchStyleCsp(context)
  if (CHECK_THIRD_PARTIES) {
    // Load the actual Google scripts, but never send audit visits to the live GA
    // property. This covers beacon, fetch, XHR and image collection requests.
    await context.route(ANALYTICS_COLLECTION, (route) => route.fulfill({ status: 204 }))
  }
  await context.addInitScript((t) => {
    try { window.localStorage.setItem('tagstash-theme', t) } catch { /* storage unavailable */ }
  }, theme)
  return context
}

const go = async (page, path) => {
  const response = await page.goto(`${BASE_URL}${path}`, { waitUntil: 'load' })
  const styles = response.headers()['content-security-policy']?.split(';').map((s) => s.trim()).filter((s) => /^style-src(?:\s|-)/.test(s))
  if (JSON.stringify(styles) !== JSON.stringify(["style-src 'self'"])) {
    throw new Error(`${path}: expected the built site's style-src 'self' CSP; serve dist with Wrangler`)
  }
}

async function logIn(page, account) {
  await go(page, '/')
  await page.getByLabel('Email').fill(account.email)
  await page.getByLabel('Password', { exact: true }).fill(TEST_PASSWORD)
  await page.getByRole('button', { name: 'Log in', exact: true }).click()
  await page.getByRole('navigation', { name: 'Main' }).getByRole('button', { name: 'Settings' }).waitFor({ timeout: 15000 })
}

async function anonymous(browser, theme) {
  const context = await newContext(browser, theme)
  const page = await context.newPage()
  const scan = makeScanner(page, theme, 'anon')

  await go(page, '/')
  await page.locator('.cookie-consent').waitFor()
  await scan('/ (home, login form, consent banner)')

  await page.getByLabel('Email').fill('nobody@example.test')
  await page.getByLabel('Password', { exact: true }).fill('wrong-password')
  await page.getByRole('button', { name: 'Log in', exact: true }).click()
  await page.locator('.auth-error').waitFor()
  await scan('/ (login error banner)')

  await page.getByRole('button', { name: 'Create an account' }).click()
  await page.getByLabel('Username').waitFor()
  await scan('/ (create account form)')

  await go(page, '/?signup=0')
  await page.getByRole('button', { name: /forgot/i }).click()
  await page.locator('#forgot-email').waitFor()
  await scan('/ (forgot password form)')

  // Recovery responses are intercepted: no real credentials or API keys are changed.
  const recoveryPage = await context.newPage()
  await recoveryPage.addInitScript(() => {
    const timeout = window.setTimeout.bind(window)
    // Hold the success screen's 800ms redirect long enough for axe to scan it.
    window.setTimeout = (callback, delay, ...args) => timeout(callback, delay === 800 ? 60_000 : delay, ...args)
  })
  const recoveryScan = makeScanner(recoveryPage, theme, 'anon')
  const setReset = await interceptJson(recoveryPage, '**/api/auth/reset-password', {
    status: 503, body: { error: 'Account recovery is temporarily unavailable. Please try again later.' },
  })
  const setMe = await interceptJson(recoveryPage, '**/api/auth/me', { status: 401, body: { error: 'Access token required' } })
  await go(recoveryPage, '/reset-password?token=a11y-intercepted-reset')
  await recoveryPage.getByLabel('New password', { exact: true }).waitFor()
  await recoveryScan('/reset-password (form)')
  await recoveryPage.getByLabel('New password', { exact: true }).fill(TEST_PASSWORD)
  await recoveryPage.getByLabel('Confirm new password').fill(TEST_PASSWORD)
  await recoveryPage.getByRole('button', { name: 'Reset password', exact: true }).click()
  await recoveryPage.locator('.auth-error', { hasText: 'Account recovery is temporarily unavailable' }).waitFor()
  await recoveryScan('/reset-password (recovery unavailable)')
  setReset({ status: 200, body: { message: 'Password reset successfully. All API keys have been revoked.' } })
  setMe({ status: 200, body: { user: { id: 1, username: OWNER.username, email: OWNER.email, membership_tier: 'free', role: 'user', theme } } })
  await recoveryPage.getByRole('button', { name: 'Reset password', exact: true }).click()
  await recoveryPage.getByText('Password reset!', { exact: true }).waitFor()
  await recoveryScan('/reset-password (success, API keys revoked)')
  await recoveryPage.close()

  // Interrupted deletion. A login with the right password for a pending account answers
  // deletionPending; both calls are intercepted, so nothing here touches a real account.
  await go(page, '/?signup=0')
  await interceptJson(page, '**/api/auth/login', {
    status: 403, body: { error: 'Account deletion was started for this account but has not finished.', deletionPending: true },
  })
  const setResume = await interceptJson(page, '**/api/auth/resume-deletion', {
    status: 502, body: { error: 'Your subscription could not be closed right now.', deletionPending: true },
  })
  await page.getByLabel('Email').fill('pending-owner@example.test')
  await page.getByLabel('Password', { exact: true }).fill(TEST_PASSWORD)
  await page.getByRole('button', { name: 'Log in', exact: true }).click()
  await page.getByRole('heading', { name: 'Finish deleting your account' }).waitFor()
  await scan('/ (finish deleting your account)')
  await page.getByRole('button', { name: 'Finish deleting my account' }).click()
  await page.locator('.auth-error').waitFor()
  await scan('/ (finish deleting, still failing)')
  let releaseResume
  setResume({ status: 200, body: { deleted: true }, hold: new Promise((resolve) => { releaseResume = resolve }) })
  await page.getByRole('button', { name: 'Try again' }).click()
  await page.getByRole('button', { name: 'Finishing deletion…' }).waitFor()
  await scan('/ (finish deleting, pending)')
  releaseResume()
  await page.getByRole('heading', { name: 'Your account has been deleted' }).waitFor()
  await scan('/ (account deleted)')
  await page.unroute('**/api/auth/login')
  await page.unroute('**/api/auth/resume-deletion')

  if (theme === 'slate') {
    // The Pages Function's server-rendered markup before (or without) JavaScript: what crawlers and no-JS visitors get.
    // (Scripts are blocked rather than disabling JS outright, because axe itself must still run.)
    const bare = await browser.newContext({ viewport: VIEWPORT })
    await watchStyleCsp(bare)
    await bare.route('**/*.js', (route) => route.abort())
    const barePage = await bare.newPage()
    await go(barePage, '/')
    await makeScanner(barePage, theme, 'anon')('/ (server-rendered, JavaScript disabled)', { checkTheme: false })
    await go(barePage, '/developers')
    await barePage.getByRole('heading', { name: 'Tagstash REST API', exact: true }).waitFor()
    if (await barePage.title() !== DEVELOPERS_META.title) throw new Error('Prerendered API documentation head was not applied')
    if (await barePage.locator('.developers-endpoint').count() !== API_DOC_ROUTES.length) throw new Error('Prerendered API reference is incomplete')
    await makeScanner(barePage, theme, 'anon')('/developers (prerendered, JavaScript disabled)', { checkTheme: false })
    await bare.close()
  }

  for (const path of ['/features', '/developers', '/privacy', '/support', `/u/${OWNER.username}`]) {
    await go(page, path)
    await page.locator('main').first().waitFor()
    if (path.startsWith('/u/')) await page.locator('.bookmark-card').first().waitFor()
    if (path.startsWith('/u/') && await page.locator('#bookmark-domain, #bookmark-month').count()) {
      throw new Error('Owner domain/month controls must not appear on a public profile')
    }
    await scan(path.startsWith('/u/') ? '/u/<name> (public profile)' : path)
    if (path.startsWith('/u/')) {
      // Search operators work on public profiles too; note: is owner-only, so it is not offered.
      const tips = page.locator('.search-tips')
      await tips.locator('summary').click()
      if (!(await tips.evaluate((el) => el.open))) throw new Error('Search tips did not open on the public profile')
      if ((await tips.textContent()).includes('note:')) throw new Error('Public profile search tips must not mention note:')
      await page.getByRole('textbox', { name: 'Search bookmarks' }).fill('#reading -weekend')
      await page.waitForFunction(() => document.querySelectorAll('.bookmark-card').length === 2)
      await scan('/u/<name> (search tips open, operator query)')
    }
    if (path === '/developers') {
      if (await page.title() !== DEVELOPERS_META.title) throw new Error('API documentation head was not applied')
      await page.setViewportSize({ width: 390, height: 844 })
      if (await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth)) throw new Error('API documentation overflows on mobile')
      await page.locator('.developers-reference pre').first().focus()
      await scan('/developers (mobile, code block keyboard focus)')
      await page.getByRole('button', { name: 'Open menu', exact: true }).click()
      await scan('/developers (mobile menu open)')
      await page.keyboard.press('Escape')
      if (await page.getByRole('button', { name: 'Open menu', exact: true }).getAttribute('aria-expanded') !== 'false') throw new Error('API documentation menu did not close')
      await page.getByRole('link', { name: 'Public profile API', exact: true }).click()
      await page.getByRole('heading', { name: 'Public profile API', exact: true }).waitFor()
      await scan('/developers (mobile, public profile anchor)')
      await page.setViewportSize(VIEWPORT)
    }
  }
  if (CHECK_THIRD_PARTIES && theme === THEMES[0]) {
    await go(page, '/')
    await Promise.all([
      page.waitForResponse((response) =>
        response.url().startsWith('https://www.googletagmanager.com/gtag/js?') && response.ok(), { timeout: 30000 }),
      page.waitForRequest(ANALYTICS_COLLECTION, { timeout: 30000 }),
      page.getByRole('button', { name: 'Accept', exact: true }).click(),
    ])
    await page.waitForFunction(() => !!window.google_tag_manager)
    await scan('/ (consent accepted, live GA script loaded; collection intercepted)')
    await go(page, '/support')
    // The dummy token proves both the live api.js and its test iframe executed.
    // Fail rather than silently passing with an absent or unconfigured widget.
    await page.waitForFunction(() => window.turnstile?.getResponse() === 'XXXX.DUMMY.TOKEN.XXXX', null, { timeout: 30000 })
    await scan('/support (Turnstile test widget completed, consent accepted)')
  }
  await context.close()
}

// Answers an API call from the browser without it reaching the server (used so the deletion
// flows can be shown without deleting the seeded users). The returned function swaps the answer.
async function interceptJson(page, pattern, answer) {
  const state = { answer }
  await page.route(pattern, async (route) => {
    const { status, body, hold } = state.answer
    if (hold) await hold
    await route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) })
  })
  return (next) => { state.answer = next }
}

async function settingsTab(page, name) {
  await page.getByRole('tab', { name, exact: true }).click()
  await page.locator('#settings-tabpanel h2.sr-only', { hasText: name }).waitFor()
  await page.waitForLoadState('networkidle').catch(() => {})
}

async function apiKeyStates(page, scan) {
  // Keep the audit's keys in intercepted responses, never in the seeded user's account.
  const key = { id: 4242, name: 'Bookmark script', key_prefix: 'tsk_abcd', key_last4: 'abcd',
    created_at: '2026-10-23 12:00:00', last_used_at: '2026-10-23 12:01:00', revoked_at: null }
  let keys = []
  let releaseList
  const listPending = new Promise((resolve) => { releaseList = resolve })
  let releaseCreate
  const createPending = new Promise((resolve) => { releaseCreate = resolve })
  let refuseCreate = false
  await page.route('**/api/auth/api-keys', async (route) => {
    if (route.request().method() === 'GET') {
      await listPending
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ apiKeys: keys }) })
    } else {
      await createPending
      if (refuseCreate) {
        await route.fulfill({ status: 400, contentType: 'application/json', body: JSON.stringify({ error: 'Revoke a key before creating another.' }) })
      } else {
        keys = [key]
        await route.fulfill({ status: 201, contentType: 'application/json', body: JSON.stringify({ apiKey: `tsk_${'abcd'.repeat(12)}`, apiKeyMetadata: key }) })
      }
    }
  })
  await page.route('**/api/auth/api-keys/4242', async (route) => {
    keys = [{ ...key, revoked_at: '2026-10-23 12:02:00' }]
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ message: 'API key revoked' }) })
  })
  await page.getByRole('tab', { name: 'API Keys', exact: true }).click()
  await page.getByText('Loading API keys...', { exact: true }).waitFor()
  await scan('/settings -> API Keys (loading)')
  releaseList()
  await page.getByText('No API keys yet.', { exact: true }).waitFor()
  await scan('/settings -> API Keys (empty)')
  await page.getByLabel('Key Name (optional)').fill(key.name)
  await page.getByRole('button', { name: 'Generate API Key' }).click()
  await page.getByRole('button', { name: 'Generating...' }).waitFor()
  await scan('/settings -> API Keys (generating)')
  releaseCreate()
  await page.locator('.generated-key-box').waitFor()
  await page.locator('.api-key-item').waitFor()
  await scan('/settings -> API Keys (show-once key and active metadata)')
  await page.getByRole('button', { name: 'Revoke', exact: true }).click()
  await page.locator('.settings-success', { hasText: 'API key revoked' }).waitFor()
  await page.getByLabel('Show revoked keys').check()
  await page.locator('.api-key-revoked').waitFor()
  await scan('/settings -> API Keys (revoked key)')
  refuseCreate = true
  await page.getByRole('button', { name: 'Generate API Key' }).click()
  await page.locator('.settings-error', { hasText: 'Revoke a key' }).waitFor()
  await scan('/settings -> API Keys (creation error)')
  await page.unroute('**/api/auth/api-keys')
  await page.unroute('**/api/auth/api-keys/4242')
}

// The Trash view. Every trash request is answered by an interception (the list from fixtures,
// every action from a chosen answer), so the seeded library is never trashed or restored.
async function trashStates(page, scan, setBulk) {
  const stamp = (daysAgo) => new Date(Date.now() - daysAgo * 86400000).toISOString().slice(0, 19).replace('T', ' ')
  const item = (id, title, url, daysAgo, tagNames, description = null) => ({
    id, title, url, description, favicon_url: null, is_favorite: 0, is_private: 0,
    created_at: '2026-08-01 10:00:00', updated_at: '2026-08-01 10:00:00', deleted_at: stamp(daysAgo),
    tags: tagNames.map((name, index) => ({ id: id * 10 + index, name })),
  })
  const fixtures = [
    item(901, 'Old article on caching', 'https://www.example.com/caching', 0.01, ['reading', 'dev'], 'Deleted a moment ago, so 30 days left.'),
    item(902, 'Recipe for flatbread', 'https://example.org/flatbread', 12, ['food']),
    item(903, 'Conference talk video', 'https://example.net/talk', 29.5, []),
  ]
  const ok = (bookmarks) => ({ status: 200, body: { bookmarks, retentionDays: 30, available: true } })
  const setList = await interceptJson(page, '**/api/bookmarks/trash', ok([]))
  const setEmpty = await interceptJson(page, '**/api/bookmarks/trash/empty', { status: 500, body: { error: 'Blocked by the accessibility audit' } })
  const setOne = await interceptJson(page, /\/api\/bookmarks\/\d+\/(restore|permanent)$/, { status: 500, body: { error: 'Blocked by the accessibility audit' } })
  const refused = { status: 500, body: { error: 'Blocked by the accessibility audit' } }
  await setBulk(refused)
  const alertWith = (text) => page.getByRole('alert').filter({ hasText: text }).waitFor()
  const toolbar = page.getByRole('toolbar', { name: 'Actions for selected bookmarks in the trash' })

  await page.getByRole('navigation', { name: 'Main' }).getByRole('button', { name: 'Trash' }).click()
  await page.getByRole('heading', { name: 'Trash', level: 1 }).waitFor()
  await page.locator('.empty-state').waitFor()
  await scan('/trash (empty)')

  setList(ok(fixtures))
  await page.reload()
  await page.locator('.trash-card').first().waitFor()
  if ((await page.locator('.trash-card').count()) !== 3) throw new Error('The trash should list its three items')
  if (!/30 days left/.test(await page.locator('.trash-card').nth(0).textContent())) throw new Error('A just-deleted item should have 30 days left')
  if (!/1 day left/.test(await page.locator('.trash-card').nth(2).textContent())) throw new Error('An item deleted 29.5 days ago should have 1 day left')
  await scan('/trash (items)')

  await page.getByRole('checkbox', { name: 'Select Old article on caching' }).check()
  await page.getByRole('checkbox', { name: 'Select Recipe for flatbread' }).check()
  await page.waitForFunction(() => /^2 selected/.test(document.querySelector('.bulk-count')?.textContent || ''))
  await scan('/trash (some selected)')
  await toolbar.getByRole('button', { name: 'Select shown (3)' }).focus()
  await page.keyboard.press('End')
  if ((await page.evaluate(() => document.activeElement?.textContent || '')).trim() !== 'Empty trash') throw new Error('End should focus the last toolbar button')

  // Delete forever (selection): confirmation with the count, then a refusal.
  await toolbar.getByRole('button', { name: 'Delete forever', exact: true }).click()
  const purgeGroup = page.getByRole('group', { name: /Permanently delete 2 bookmarks\?/ })
  await purgeGroup.waitFor()
  if (!(await page.evaluate(() => document.activeElement?.textContent === 'Cancel'))) throw new Error('The delete forever confirmation should focus Cancel')
  await scan('/trash (delete forever confirmation)')
  await purgeGroup.getByRole('button', { name: 'Delete 2 bookmarks forever', exact: true }).click()
  await alertWith('Blocked by the accessibility audit')
  await scan('/trash (delete forever refused)')

  // Empty trash: the confirmation states how many are in the trash.
  await toolbar.getByRole('button', { name: 'Empty trash', exact: true }).click()
  const emptyGroup = page.getByRole('group', { name: /everything in the trash, 3 bookmarks\?/ })
  await emptyGroup.waitFor()
  await scan('/trash (empty trash confirmation)')
  await emptyGroup.getByRole('button', { name: 'Empty trash (3 bookmarks)', exact: true }).click()
  await alertWith('Blocked by the accessibility audit')
  await scan('/trash (empty trash refused)')

  // Per-item delete forever confirmation, cancelled (focus returns to its button).
  await page.getByRole('button', { name: 'Delete Conference talk video forever', exact: true }).click()
  const cardGroup = page.locator('.trash-card-confirm')
  await cardGroup.waitFor()
  await scan('/trash (delete one forever confirmation)')
  await cardGroup.getByRole('button', { name: 'Cancel', exact: true }).click()
  await page.waitForFunction(() => document.activeElement?.id === 'trash-forever-903', null, { timeout: 3000 })
    .catch(() => { throw new Error('Cancelling should return focus to the item\'s Delete forever button') })

  // Restore refused by the free-plan limit: the message and the upgrade prompt.
  await setBulk({ status: 403, body: { error: 'Restoring 2 bookmarks would go over the free plan\'s limit of 50 bookmarks, and you have room for 1 more. Nothing was restored. Restore fewer, or upgrade to paid for unlimited bookmarks.', limitReached: true, restored: 0, remainingSlots: 1 } })
  await toolbar.getByRole('button', { name: 'Restore', exact: true }).click()
  await alertWith('Nothing was restored')
  await page.getByRole('button', { name: 'Upgrade (Monthly)', exact: true }).waitFor()
  await scan('/trash (restore blocked at the free limit)')

  // A restore refused for another reason, from the item's own button.
  await page.getByRole('button', { name: 'Restore Recipe for flatbread', exact: true }).click()
  await alertWith('Blocked by the accessibility audit')
  await scan('/trash (restore refused)')

  // A successful bulk restore: the status message, and the list shrinks.
  await setBulk({ status: 200, body: { message: 'Restored 2 bookmarks', requested: 2, restored: 2, skipped: 0 } })
  setList(ok(fixtures.slice(2)))
  await toolbar.getByRole('button', { name: 'Restore', exact: true }).click()
  await page.getByRole('status').filter({ hasText: 'Restored 2 bookmarks.' }).waitFor()
  await page.waitForFunction(() => document.querySelectorAll('.trash-card').length === 1)
  await scan('/trash (restored)')

  // The trash itself failing to load.
  setList({ status: 500, body: { error: 'Blocked by the accessibility audit' } })
  await page.reload()
  await page.getByText('Failed to load the trash.', { exact: true }).waitFor()
  await scan('/trash (load error)')
  setList(ok([]))
  await page.getByRole('button', { name: 'Try again', exact: true }).click()
  await page.locator('.empty-state').filter({ hasText: 'The trash is empty' }).waitFor()

  setEmpty(refused)
  setOne(refused)
  await setBulk(refused)
}

async function owner(browser, theme) {
  const context = await newContext(browser, theme)
  const page = await context.newPage()
  const scan = makeScanner(page, theme, 'owner')
  await logIn(page, OWNER)

  await page.locator('.bookmark-card').first().waitFor()
  await scan('/ (bookmark list)')

  // Search operators (issue #74) with the Search tips disclosure open.
  const tips = page.locator('.search-tips')
  const searchBox = page.getByRole('textbox', { name: 'Search bookmarks' })
  const cardCount = (n) => page.waitForFunction((count) => document.querySelectorAll('.bookmark-card').length === count, n)
  await tips.locator('summary').click()
  if (!(await tips.evaluate((el) => el.open))) throw new Error('Search tips did not open')
  if (!(await tips.textContent()).includes('note:')) throw new Error('Owner search tips should mention note:')
  await searchBox.fill('#design -accessibility')
  await cardCount(1)
  await scan('/ (search tips open, operator query)')
  await searchBox.fill('match:OR #tools created:2026-09')
  await cardCount(5)
  await searchBox.fill('')
  await cardCount(7)
  await tips.locator('summary').click()

  // "Without tags" filter: active (only the untagged bookmark), then combined with a
  // search that matches nothing so the empty state is scanned too.
  const untaggedToggle = page.getByRole('button', { name: /^Without tags/ })
  await untaggedToggle.click()
  await page.locator('.bookmark-card').first().waitFor()
  if ((await untaggedToggle.getAttribute('aria-pressed')) !== 'true') throw new Error('Without tags toggle is not pressed')
  if ((await page.locator('.bookmark-card').count()) !== 1) throw new Error('Without tags should list exactly the one untagged bookmark')
  await scan('/ (bookmark list, Without tags filter active)')
  await page.getByRole('textbox', { name: 'Search bookmarks' }).fill('zzz-no-such-bookmark')
  await page.locator('.empty-state').waitFor()
  await scan('/ (Without tags filter, no matches)')
  await page.getByRole('button', { name: 'Clear all filters' }).click()
  await page.locator('.bookmark-card').nth(1).waitFor()
  if ((await untaggedToggle.getAttribute('aria-pressed')) !== 'false') throw new Error('Clear all filters should release Without tags')

  const domain = page.getByLabel('Domain', { exact: true })
  const month = page.getByLabel('Month saved', { exact: true })
  const search = page.getByRole('textbox', { name: 'Search bookmarks' })
  const expectCards = async (count) => {
    await page.waitForFunction((n) => document.querySelectorAll('.bookmark-card').length === n, count)
  }
  await domain.selectOption('example.com')
  await expectCards(5)
  const domainOptions = await domain.locator('option').allTextContents()
  if (domainOptions.join('|') !== 'All domains|example.com (5)|example.org (2)') {
    throw new Error('Domain picker must group subdomains with their site and count all five example.com bookmarks')
  }
  await scan('/ (domain filter active)')
  await page.getByRole('button', { name: 'Clear domain filter', exact: true }).click()
  await expectCards(7)
  await page.locator('.bookmark-card').filter({ hasText: 'Reading list for the weekend' })
    .getByRole('button', { name: 'Show other bookmarks from example.com', exact: true }).click()
  await expectCards(5)
  if (await domain.inputValue() !== 'example.com') throw new Error('Related on a subdomain must select the same site as the picker')
  await page.getByRole('button', { name: 'Clear domain filter', exact: true }).click()
  await expectCards(7)
  const monthValues = await month.locator('option').evaluateAll((options) => options.map((o) => o.value))
  if (monthValues.join(',') !== ',2026-09,2026-08') throw new Error('Month options should be newest first')
  await month.selectOption('2026-09')
  await expectCards(4)
  await scan('/ (month filter active)')
  await domain.selectOption('example.com')
  await expectCards(3)
  await page.locator('.sidebar').getByRole('button', { name: /^reading, / }).click()
  await expectCards(2)
  if (await domain.inputValue() !== 'example.com' || await month.inputValue() !== '2026-09') throw new Error('Picking a tag must preserve domain and month')
  await page.getByRole('button', { name: 'Show favorite bookmarks only', exact: true }).click()
  await expectCards(1)
  await search.fill('tag-first')
  await expectCards(1)
  await scan('/ (domain and month combined with tag, favorites and search)')
  await month.selectOption('2026-08')
  await page.locator('.empty-state').waitFor()
  await scan('/ (domain and month filters, no matches)')
  // Each filter can be cleared independently; Related replaces the full query.
  await page.getByRole('button', { name: 'Clear month filter', exact: true }).click()
  await expectCards(1)
  await month.selectOption('2026-09')
  await page.getByRole('button', { name: 'Show other bookmarks from example.com', exact: true }).first().click()
  await expectCards(5)
  if (await month.inputValue() || await search.inputValue()) throw new Error('Related must reset month and search')
  if (await page.locator('.active-tag-filter .tag-stock').count()) throw new Error('Related must reset tags')
  await untaggedToggle.click()
  await month.selectOption('2026-08')
  await expectCards(1)
  await scan('/ (domain and month combined with Without tags)')
  await page.getByRole('button', { name: 'Clear all filters' }).click()
  await expectCards(7)
  if (await domain.inputValue() || await month.inputValue()) throw new Error('Clear all filters must reset domain and month')

  await domain.selectOption('example.org')
  await month.selectOption('2026-09')
  await page.getByRole('button', { name: /Random bookmark/i }).click()
  await expectCards(1)
  await page.getByLabel('Tags', { exact: true }).first().waitFor()
  // Random clears the underlying controls in a React effect after rendering
  // the focused card. Wait for that effect, just as we wait for result updates.
  await page.waitForFunction(() => (
    document.querySelector('#bookmark-domain').value === '' && document.querySelector('#bookmark-month').value === ''
  ))
  await page.locator('.bookmark-edit-actions').getByRole('button', { name: 'Cancel' }).first().click()
  await expectCards(7)

  await page.getByRole('button', { name: 'Add bookmark' }).click()
  await page.locator('form').filter({ has: page.getByLabel('Title') }).first().waitFor()
  await scan('/ (add bookmark form)')
  await page.getByRole('button', { name: 'Cancel', exact: true }).first().click()

  await page.getByRole('button', { name: 'Edit bookmark' }).first().click()
  await page.getByLabel('Tags').first().waitFor()
  await scan('/ (edit mode)')
  await page.locator('.bookmark-edit-actions').getByRole('button', { name: 'Cancel' }).first().click()
  await expectCards(7)

  // Select mode. Every bulk request is answered by an interception (a refusal), so nothing
  // here can change the seeded library even if a click lands on a real action.
  const setBulk = await interceptJson(page, '**/api/bookmarks/bulk/**', { status: 500, body: { error: 'Blocked by the accessibility audit' } })
  const selectToggle = page.getByRole('button', { name: 'Select bookmarks', exact: true })
  await selectToggle.click()
  const toolbar = page.getByRole('toolbar', { name: 'Bulk actions for selected bookmarks' })
  await toolbar.waitFor()
  if ((await selectToggle.getAttribute('aria-pressed')) !== 'true') throw new Error('Select toggle should be pressed in select mode')
  if ((await page.getByRole('checkbox', { name: /^Select / }).count()) !== 7) throw new Error('Every bookmark should get a named checkbox in select mode')
  if (!/^0 selected/.test((await page.locator('.bulk-count').textContent()) || '')) throw new Error('Select mode should start with 0 selected')
  if (await toolbar.getByRole('button', { name: /^Delete/ }).isEnabled()) throw new Error('Actions should be disabled with nothing selected')
  await scan('/ (select mode, none selected)')

  await page.getByRole('checkbox', { name: 'Select Tag-first bookmarking guide' }).check()
  await page.getByRole('checkbox', { name: 'Select Design systems handbook' }).check()
  await page.waitForFunction(() => /^2 selected/.test(document.querySelector('.bulk-count')?.textContent || ''))
  await scan('/ (select mode, some selected)')

  // Keyboard: arrow keys move through the toolbar's enabled buttons.
  await toolbar.getByRole('button', { name: 'Select this page (7)' }).focus()
  await page.keyboard.press('End')
  if ((await page.evaluate(() => document.activeElement?.textContent || '')).trim() !== 'Done') throw new Error('End should focus the last toolbar button')

  await toolbar.getByRole('button', { name: 'Tags', exact: true }).click()
  await page.getByRole('group', { name: 'Change tags on 2 bookmarks' }).waitFor()
  if (!(await page.evaluate(() => document.activeElement?.id === 'bulk-add-tags'))) throw new Error('Opening the tag form should focus its first field')
  await scan('/ (select mode, tag form)')
  await page.getByLabel('Add tags', { exact: true }).fill('two words')
  await page.getByRole('button', { name: 'Apply to 2 bookmarks' }).click()
  await page.getByRole('alert').filter({ hasText: 'single word' }).waitFor()
  await scan('/ (select mode, tag form error)')
  await page.getByLabel('Add tags', { exact: true }).fill('audit-tag')
  await page.getByRole('button', { name: 'Apply to 2 bookmarks' }).click()
  await page.getByRole('alert').filter({ hasText: 'Blocked by the accessibility audit' }).waitFor()
  await scan('/ (select mode, tag form, server refused)')
  await page.getByRole('button', { name: 'Cancel', exact: true }).first().click()

  await toolbar.getByRole('button', { name: 'Export', exact: true }).click()
  await page.getByRole('group', { name: 'Export 2 selected bookmarks' }).waitFor()
  await scan('/ (select mode, export formats)')
  await page.getByRole('button', { name: 'Cancel', exact: true }).first().click()

  // Pop-up blocking: window.open is stubbed to refuse, so no tabs actually open.
  await page.evaluate(() => { window.open = () => null })
  await toolbar.getByRole('button', { name: 'Open in tabs', exact: true }).click()
  await page.getByRole('group', { name: '2 tabs blocked by your browser' }).waitFor()
  await scan('/ (select mode, tabs blocked by the browser)')
  await page.getByRole('button', { name: 'Close', exact: true }).click()

  await toolbar.getByRole('button', { name: 'Delete', exact: true }).click()
  const deleteGroup = page.getByRole('group', { name: /Move 2 bookmarks to the trash\?/ })
  await deleteGroup.waitFor()
  if (!(await page.evaluate(() => document.activeElement?.textContent === 'Cancel'))) throw new Error('The delete confirmation should focus Cancel')
  await scan('/ (select mode, move to trash confirmation)')
  await deleteGroup.getByRole('button', { name: 'Move 2 bookmarks to trash', exact: true }).click()
  await page.getByRole('alert').filter({ hasText: 'Blocked by the accessibility audit' }).waitFor()
  await scan('/ (select mode, delete refused by the server)')
  // The server now "moves them to the trash": the result offers Undo (refused once, then it works).
  await setBulk({ status: 200, body: { message: 'Moved 2 bookmarks to the trash', requested: 2, deleted: 2, skipped: 0, trashed: true, retentionDays: 30 } })
  await deleteGroup.getByRole('button', { name: 'Move 2 bookmarks to trash', exact: true }).click()
  await page.getByRole('status').filter({ hasText: 'Moved 2 bookmarks to the trash.' }).waitFor()
  await page.getByRole('button', { name: 'Undo', exact: true }).waitFor()
  await scan('/ (select mode, moved to the trash with Undo)')
  await setBulk({ status: 403, body: { error: 'Restoring 2 bookmarks would go over the free plan\'s limit of 50 bookmarks, and you have room for 1 more. Nothing was restored.', limitReached: true } })
  await page.getByRole('button', { name: 'Undo', exact: true }).click()
  await page.getByRole('alert').filter({ hasText: 'Nothing was restored' }).waitFor()
  await scan('/ (select mode, undo refused)')
  await setBulk({ status: 200, body: { message: 'Restored 2 bookmarks', requested: 2, restored: 2, skipped: 0 } })
  await page.getByRole('button', { name: 'Undo', exact: true }).click()
  await page.getByRole('status').filter({ hasText: 'Restored 2 bookmarks.' }).waitFor()
  await scan('/ (select mode, undo done)')
  await setBulk({ status: 500, body: { error: 'Blocked by the accessibility audit' } })
  await expectCards(7)

  // Changing a filter clears the selection and says so.
  await search.fill('guide')
  await page.waitForFunction(() => /^0 selected.*cleared/.test(document.querySelector('.bulk-count')?.textContent || ''))
  await scan('/ (select mode, selection cleared by a filter)')
  await search.fill('')
  await expectCards(7)
  await page.getByRole('button', { name: 'Done', exact: true }).click()
  if ((await page.getByRole('checkbox').count()) !== 0) throw new Error('Leaving select mode should remove the checkboxes')

  // Single delete: no confirm dialog, a notice with Undo. The DELETE is answered by an
  // interception (the seeded bookmark is never trashed); Undo goes to the bulk interception.
  let singleDelete = { status: 200, body: { message: 'Bookmark moved to the trash', trashed: true, retentionDays: 30 } }
  await page.route(/\/api\/bookmarks\/\d+$/, async (route) => {
    if (route.request().method() !== 'DELETE') return route.fallback()
    return route.fulfill({ status: singleDelete.status, contentType: 'application/json', body: JSON.stringify(singleDelete.body) })
  })
  await page.getByRole('button', { name: 'Move bookmark to the trash' }).first().click()
  await page.locator('.trash-notice').waitFor()
  if (!(await page.evaluate(() => document.activeElement?.classList.contains('trash-notice')))) throw new Error('Deleting should move focus to the notice')
  await scan('/ (moved to the trash notice with Undo)')
  await page.locator('.trash-notice').getByRole('button', { name: 'Undo', exact: true }).click()
  await page.getByRole('alert').filter({ hasText: 'Blocked by the accessibility audit' }).waitFor()
  await scan('/ (moved to the trash notice, undo refused)')
  await setBulk({ status: 200, body: { message: 'Restored 1 bookmark', requested: 1, restored: 1, skipped: 0 } })
  await page.locator('.trash-notice').getByRole('button', { name: 'Undo', exact: true }).click()
  await page.locator('.trash-notice').waitFor({ state: 'detached' })
  await setBulk({ status: 500, body: { error: 'Blocked by the accessibility audit' } })

  await page.getByRole('navigation', { name: 'Main' }).getByRole('button', { name: 'Settings' }).click()
  await page.getByRole('tab').first().waitFor()
  const tabNames = (await page.getByRole('tab').allTextContents()).filter((n) => n !== 'Admin')
  for (const name of tabNames) {
    await settingsTab(page, name)
    await scan(`/settings -> ${name}`)
  }

  // Error banner (client-side validation, nothing is sent).
  await settingsTab(page, tabNames[0])
  await page.locator('#settings-tabpanel form').first().evaluate((f) => { f.noValidate = true })
  await page.locator('#settings-tabpanel form').first().locator('button[type="submit"]').click()
  await page.locator('.settings-error').waitFor()
  await scan(`/settings -> ${tabNames[0]} (error banner)`)

  // Success banner: toggle the public profile off and back on.
  const profileTab = tabNames.find((n) => /public profile/i.test(n))
  if (profileTab) {
    await settingsTab(page, profileTab)
    const toggle = page.getByLabel('Make my profile public')
    await toggle.click()
    await page.locator('.settings-success').waitFor()
    await scan(`/settings -> ${profileTab} (success banner)`)
    await toggle.click()
    await page.locator('.settings-success', { hasText: 'enabled' }).waitFor()
  }

  await apiKeyStates(page, scan)

  // Import preview (shows .import-note).
  const importTab = tabNames.find((n) => /import/i.test(n))
  if (importTab) {
    await settingsTab(page, importTab)
    await page.locator('#import-source').selectOption('chrome')
    const html = '<!DOCTYPE NETSCAPE-Bookmark-file-1>\n<DL><p>\n<DT><A HREF="https://example.org/one" ADD_DATE="1">Example one</A>\n<DT><A HREF="https://example.org/two" ADD_DATE="1">Example two</A>\n</DL><p>'
    await page.locator('input[type="file"]').setInputFiles({ name: 'bookmarks.html', mimeType: 'text/html', buffer: Buffer.from(html) })
    await page.locator('.import-note').waitFor()
    await scan(`/settings -> ${importTab} (import preview)`)
  }

  await page.getByRole('navigation', { name: 'Main' }).getByRole('button', { name: 'Tags' }).click()
  await page.locator('.tag-merge-slot-label').first().waitFor()
  await page.locator('.tags-page .tag-stock').first().waitFor()
  await scan('/tags (empty merge slots)')

  const picks = page.locator('.tags-page .tag-cloud-chip-name')
  await picks.nth(0).click()
  await picks.nth(1).click()
  await page.locator('.tag-merge-preview').waitFor()
  await scan('/tags (merge pair selected)')
  await page.getByRole('button', { name: 'Clear Selection', exact: true }).click()

  // Rename / delete section: the form, a rename that would merge, both inline confirmations.
  // Every confirmation is cancelled, so the seeded tags are left as they were.
  const editSection = page.locator('section', { has: page.getByRole('heading', { name: 'Rename or Delete a Tag' }) })
  await editSection.locator('.tag-cloud-chip-name', { hasText: 'reading' }).click()
  const renameInput = editSection.getByLabel('New name')
  await renameInput.waitFor()
  await scan('/tags (rename form)')
  await renameInput.fill('two words')
  await editSection.locator('.tag-edit-hint--error').waitFor()
  await scan('/tags (rename name error)')
  await renameInput.fill('design')
  await editSection.locator('.tag-merge-preview').waitFor()
  await scan('/tags (rename would merge)')
  await editSection.getByRole('button', { name: 'Rename and Merge' }).click()
  await editSection.locator('.tag-edit-confirm').waitFor()
  await scan('/tags (rename merge confirmation)')
  await editSection.getByRole('button', { name: 'Cancel' }).click()
  await editSection.getByRole('button', { name: 'Delete Tag' }).click()
  await editSection.locator('.tag-edit-confirm').waitFor()
  await scan('/tags (delete confirmation)')
  await editSection.getByRole('button', { name: 'Cancel' }).click()

  await trashStates(page, scan, setBulk)
  await duplicateStates(page, scan, go)
  await noteStates(page, scan, go)

  // Reset Library (its idle form is scanned with the other tabs above). The reset request is
  // intercepted, so the seeded owner's library is never wiped.
  await page.getByRole('navigation', { name: 'Main' }).getByRole('button', { name: 'Settings' }).click()
  await settingsTab(page, 'Reset Library')
  const resetButton = page.getByRole('button', { name: 'Reset my library' })
  const resetConfirmation = page.getByLabel(/^Type RESET to confirm/)
  await page.getByLabel('Password (for verification)').fill(TEST_PASSWORD)
  await resetConfirmation.fill('reset')
  await resetButton.click()
  await page.locator('.settings-error', { hasText: 'Type RESET' }).waitFor()
  await scan('/settings -> Reset Library (confirmation error)')

  const setReset = await interceptJson(page, '**/api/auth/reset-library', {
    status: 401, body: { error: 'Incorrect password' },
  })
  await resetConfirmation.fill('RESET')
  await resetButton.click()
  await page.locator('.settings-error', { hasText: 'Incorrect password' }).waitFor()
  await scan('/settings -> Reset Library (password refused)')

  let releaseReset
  setReset({ status: 200, body: { reset: true, removed: { bookmarks: 7, tagLinks: 12, favoriteTags: 1 } }, hold: new Promise((resolve) => { releaseReset = resolve }) })
  await resetButton.click()
  await page.getByRole('button', { name: 'Resetting library...' }).waitFor()
  await scan('/settings -> Reset Library (pending)')
  releaseReset()
  await page.locator('.settings-success', { hasText: 'Your library has been reset' }).waitFor()
  await scan('/settings -> Reset Library (success)')
  await page.unroute('**/api/auth/reset-library')

  // Sign out everywhere: intercept every request so the seed's sessions are never revoked.
  // The idle panel was scanned in the tab loop. Verify the confirmation also supports Cancel.
  await settingsTab(page, 'Sessions')
  const signOutButton = page.getByRole('button', { name: 'Sign out of all devices', exact: true })
  await signOutButton.click()
  await page.getByRole('group', { name: 'Sign out everywhere now?' }).waitFor()
  await scan('/settings -> Sessions (confirm sign out everywhere)')
  await page.getByRole('button', { name: 'Cancel', exact: true }).click()
  await signOutButton.waitFor()
  // Cancellation restores focus after React has committed the trigger button.
  await page.waitForFunction(() => document.activeElement?.textContent === 'Sign out of all devices')
  await signOutButton.click()
  const setSignOut = await interceptJson(page, '**/api/auth/logout-everywhere', {
    status: 503, body: { error: 'Signing out of all devices is temporarily unavailable. Please try again later.' },
  })
  const confirmSignOut = page.getByRole('button', { name: 'Confirm sign out', exact: true })
  await confirmSignOut.click()
  await page.locator('.settings-error', { hasText: 'temporarily unavailable' }).waitFor()
  await scan('/settings -> Sessions (sign out everywhere error)')
  let releaseSignOut
  setSignOut({ status: 200, body: { message: 'Signed out of all devices' }, hold: new Promise((resolve) => { releaseSignOut = resolve }) })
  await confirmSignOut.click()
  await page.getByRole('button', { name: 'Signing out...', exact: true }).waitFor()
  await scan('/settings -> Sessions (sign out everywhere pending)')
  releaseSignOut()
  await page.getByRole('status', { name: '' }).filter({ hasText: 'You are signed out of all devices' }).waitFor()
  await page.getByRole('button', { name: 'Log in', exact: true }).waitFor()
  await scan('/ (signed out of all devices success)')
  await page.unroute('**/api/auth/logout-everywhere')
  // Clear the browser's cookie only, then sign back in for the remaining deletion scenarios.
  await context.clearCookies()
  await logIn(page, OWNER)

  // Delete Account (its idle form is scanned with the other tabs above). The delete request is
  // intercepted, so the seeded owner is never deleted. Order matters: the last step signs the
  // page out locally.
  await page.getByRole('navigation', { name: 'Main' }).getByRole('button', { name: 'Settings' }).click()
  await settingsTab(page, 'Delete Account')
  const deleteButton = page.getByRole('button', { name: 'Permanently delete my account' })
  const confirmation = page.getByLabel(/^Type DELETE to confirm/)
  await page.getByLabel('Password (for verification)').fill(TEST_PASSWORD)
  await confirmation.fill('delete')
  await deleteButton.click()
  await page.locator('.settings-error', { hasText: 'Type DELETE' }).waitFor()
  await scan('/settings -> Delete Account (confirmation error)')

  const setDelete = await interceptJson(page, '**/api/auth/delete-account', {
    status: 401, body: { error: 'Incorrect password' },
  })
  await confirmation.fill('DELETE')
  await deleteButton.click()
  await page.locator('.settings-error', { hasText: 'Incorrect password' }).waitFor()
  await scan('/settings -> Delete Account (password refused)')

  let releaseDelete
  setDelete({ status: 401, body: { error: 'Incorrect password' }, hold: new Promise((resolve) => { releaseDelete = resolve }) })
  await deleteButton.click()
  await page.getByRole('button', { name: 'Deleting account...' }).waitFor()
  await scan('/settings -> Delete Account (pending)')
  releaseDelete()
  await page.locator('.settings-error', { hasText: 'Incorrect password' }).waitFor()

  // The deletion starts but cannot finish: the session ends and the home page offers to finish it.
  setDelete({ status: 503, body: { error: 'Account data could not be removed.', deletionPending: true } })
  await deleteButton.click()
  await page.getByRole('heading', { name: 'Finish deleting your account' }).waitFor()
  await scan('/ (finish deleting, session ended by an interrupted deletion)')
  await context.close()
}

async function admin(browser, theme) {
  const context = await newContext(browser, theme)
  const page = await context.newPage()
  const scan = makeScanner(page, theme, 'admin')
  await logIn(page, ADMIN)
  await page.getByRole('navigation', { name: 'Main' }).getByRole('button', { name: 'Settings' }).click()
  await settingsTab(page, 'Admin')
  await page.locator('.admin-user-row, .admin-users, table').first().waitFor().catch(() => {})
  await scan('/settings -> Admin')
  await settingsTab(page, 'Delete Account')
  await page.locator('.settings-suspended-notice').waitFor()
  await scan('/settings -> Delete Account (super admin cannot self-delete)')
  await context.close()
}

const RUNNERS = { anon: anonymous, owner, admin }

// ------------------------------------------------------------------ main ----

function formatNode(violation, node) {
  const target = node.target.join(' ')
  let detail = ''
  const data = node.any?.[0]?.data
  if (violation.id === 'color-contrast' && data) {
    detail = `  fg ${data.fgColor} on bg ${data.bgColor}: ${data.contrastRatio}:1 (needs ${data.expectedContrastRatio}:1)`
  }
  return `      ${target}${detail}`
}

function summarize() {
  const failing = results.filter((r) => r.violations.length > 0)
  console.log('\n=== axe summary ===')
  console.log(`Scans: ${scanCount} (${THEMES.join(', ')} x ${ROLES.join(', ')}); axe-core ${axeVersion}`)
  console.log(`Rules: ${AXE_TAGS.join(', ')}`)
  if (KNOWN_EXCLUSIONS.length) {
    console.log('Known exclusions:')
    for (const e of KNOWN_EXCLUSIONS) console.log(`  - ${e.rule} @ ${e.selector}: ${e.reason}`)
  }
  if (CONTRAST_REPORT) {
    console.log('\nMeasured contrast (theme | element | colours | ratio):')
    for (const row of [...contrastRows].sort()) console.log(`  ${row}`)
  }
  console.log(`Needs-review (axe "incomplete") results, not counted as failures: ${incompleteCount}`)
  if (failing.length === 0) {
    console.log('\nPASS: no violations.')
    return 0
  }
  const total = failing.reduce((n, r) => n + r.violations.reduce((m, v) => m + v.nodes.length, 0), 0)
  console.log(`\nFAIL: ${total} violating node(s) in ${failing.length} scan(s).\n`)
  for (const r of failing) {
    console.log(`[${r.theme}/${r.role}] ${r.label}`)
    for (const v of r.violations) {
      console.log(`  ${v.id} (${v.impact}): ${v.help}`)
      for (const n of v.nodes) console.log(formatNode(v, n))
    }
  }
  return 1
}

assertLocal(BASE_URL)
for (const t of THEMES) if (!['slate', 'midnight', 'light'].includes(t)) throw new Error(`Unknown theme: ${t}`)
for (const r of ROLES) if (!RUNNERS[r]) throw new Error(`Unknown role: ${r} (use anon, owner, admin)`)
if (CHECK_THIRD_PARTIES && !ROLES.includes('anon')) throw new Error('--check-third-parties requires the anon role')

try {
  const probe = await fetch(`${BASE_URL}/api/health`).catch(() => null)
  if (!probe?.ok) throw new Error(`No Tagstash server answering at ${BASE_URL}. Build and serve first (see the header of this file).`)
  if (!SKIP_SEED) {
    console.log('Seeding local test users...')
    seedUsers()
  }
  const executablePath = findChromium()
  console.log(`Chromium: ${executablePath}\nTarget:   ${BASE_URL}\n`)
  const browser = await chromium.launch({ executablePath, headless: true })
  let failedRun = false
  try {
    for (const theme of THEMES) {
      for (const role of ROLES) {
        console.log(`[${theme}] ${role}`)
        try {
          await RUNNERS[role](browser, theme)
        } catch (error) {
          failedRun = true
          console.log(`  ERROR ${error.message.split('\n')[0]}`)
          results.push({ theme, role, label: `scenario aborted: ${error.message.split('\n')[0]}`, violations: [] })
        }
      }
    }
  } finally {
    await browser.close()
  }
  const code = summarize()
  console.log(`\nStyle CSP: ${styleCspViolations.length} violation event(s)/console error(s).`)
  for (const violation of styleCspViolations) console.log(JSON.stringify(violation))
  if (failedRun) console.log('\nOne or more scenarios aborted before finishing (see ERROR lines above) - treating the audit as failed.')
  process.exit(code || (failedRun || styleCspViolations.length ? 1 : 0))
} catch (error) {
  console.error(error.message)
  process.exit(2)
}

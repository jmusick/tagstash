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
//               /features, /privacy, /support, a public profile (/u/<owner>)
//   owner     : / (bookmark list, untagged/domain/month filters and no matches, edit mode, add form), /settings (every tab,
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
    await bare.close()
  }

  for (const path of ['/features', '/privacy', '/support', `/u/${OWNER.username}`]) {
    await go(page, path)
    await page.locator('main').first().waitFor()
    if (path.startsWith('/u/')) await page.locator('.bookmark-card').first().waitFor()
    if (path.startsWith('/u/') && await page.locator('#bookmark-domain, #bookmark-month').count()) {
      throw new Error('Owner domain/month controls must not appear on a public profile')
    }
    await scan(path.startsWith('/u/') ? '/u/<name> (public profile)' : path)
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

async function owner(browser, theme) {
  const context = await newContext(browser, theme)
  const page = await context.newPage()
  const scan = makeScanner(page, theme, 'owner')
  await logIn(page, OWNER)

  await page.locator('.bookmark-card').first().waitFor()
  await scan('/ (bookmark list)')

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

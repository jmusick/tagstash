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
//   anonymous : /, login error + sign-up + forgot-password states, /features,
//               /privacy, /support, a public profile (/u/<owner>)
//   owner     : / (bookmark list, "Without tags" filter, edit mode, add form), /settings (every tab,
//               plus an error, a success banner and the import preview), /tags
//               (empty merge slots and a selected merge pair)
//   admin     : /settings -> Admin
// The cookie consent banner is visible in every scan (each theme/role runs in a
// fresh browser context with no stored choice). Exit code is 1 on any violation.
//
// Configuration (flags or env):
//   --base-url <url>  | A11Y_BASE_URL         default http://127.0.0.1:5000 (localhost only)
//   --themes a,b      | A11Y_THEMES           default slate,midnight,light
//   --roles a,b       | A11Y_ROLES            default anon,owner,admin
//   --chromium <path> | A11Y_CHROMIUM_PATH    default: newest Chromium in the Playwright cache
//   --skip-seed       | A11Y_SKIP_SEED=1      do not (re)seed the test users
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
const REPORT_SELECTORS = /auth-error|settings-error|settings-success|import-note|tag-merge-slot-label|cc-btn|cc-actions|preferred-badge|btn-danger/
const SKIP_SEED = process.argv.includes('--skip-seed') || process.env.A11Y_SKIP_SEED === '1'

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
    ['Command line tools', 'https://example.com/cli', 'Handy terminal utilities.', ['tools', 'dev']],
    ['Accessibility checklist', 'https://example.com/a11y', 'WCAG in plain language.', ['design', 'guides']],
    ['Static site generators', 'https://example.com/ssg', 'Comparing build tools.', ['tools', 'dev']],
    ['Reading list for the weekend', 'https://example.com/weekend', 'Long reads.', ['reading']],
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
  for (const [title, url, description, tags] of bookmarks) {
    statements.push(
      `INSERT INTO bookmarks (user_id, title, url, description, created_at, updated_at)
       VALUES ((SELECT id FROM users WHERE email = ${sqlString(OWNER.email)}), ${sqlString(title)}, ${sqlString(url)}, ${sqlString(description)}, ${old}, ${old});`,
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
  await context.addInitScript((t) => {
    try { window.localStorage.setItem('tagstash-theme', t) } catch { /* storage unavailable */ }
  }, theme)
  return context
}

const go = async (page, path) => {
  await page.goto(`${BASE_URL}${path}`, { waitUntil: 'load' })
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

  if (theme === 'slate') {
    // The Pages Function's server-rendered markup before (or without) JavaScript: what crawlers and no-JS visitors get.
    // (Scripts are blocked rather than disabling JS outright, because axe itself must still run.)
    const bare = await browser.newContext({ viewport: VIEWPORT })
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
    await scan(path.startsWith('/u/') ? '/u/<name> (public profile)' : path)
  }
  await context.close()
}

async function settingsTab(page, name) {
  await page.getByRole('tab', { name, exact: true }).click()
  await page.locator('#settings-tabpanel h2.sr-only', { hasText: name }).waitFor()
  await page.waitForLoadState('networkidle').catch(() => {})
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
  if (failedRun) console.log('\nOne or more scenarios aborted before finishing (see ERROR lines above) - treating the audit as failed.')
  process.exit(code || (failedRun ? 1 : 0))
} catch (error) {
  console.error(error.message)
  process.exit(2)
}

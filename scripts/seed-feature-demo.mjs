import { hash } from 'bcryptjs'
import { mkdir, writeFile } from 'node:fs/promises'
import { execFileSync } from 'node:child_process'
import { resolve } from 'node:path'

const workDirectory = process.env.TAGSTASH_DEMO_WORK_DIR
if (!workDirectory) throw new Error('Set TAGSTASH_DEMO_WORK_DIR to a project working directory outside the source checkout')
const demoPath = name => resolve(workDirectory, name)

// Deliberately local-only. Never use this fixture account in a deployed database.
const email = 'features-demo@example.test'
const username = 'tagstash-demo'
const password = 'TagstashDemo2026!'
const bookmarks = [
  ['A complete guide to CSS Grid', 'https://css-tricks.com/snippets/css/complete-guide-grid/', 'Layout ideas for the next website. A handy reference for rows, columns, and gaps.', ['design', 'reference', 'web'], 1, 0],
  ['Practical Typography', 'https://practicaltypography.com/', 'A reference for making type easier to read. Keep for design projects.', ['design', 'reference'], 1, 0],
  ['MDN: CSS custom properties', 'https://developer.mozilla.org/en-US/docs/Web/CSS/Using_CSS_custom_properties', 'Reusable colors and spacing for a consistent website.', ['web', 'reference'], 0, 0],
  ['The ten essentials for hiking', 'https://www.rei.com/learn/expert-advice/ten-essentials.html', 'Packing checklist for a day on the trail: navigation, layers, food, and water.', ['hiking', 'reference'], 1, 0],
  ['Find your next trail', 'https://www.alltrails.com/', 'Ideas for an easy weekend hike with friends.', ['hiking', 'weekend'], 0, 0],
  ['Leave No Trace: the seven principles', 'https://lnt.org/why/7-principles/', 'A refresher before the next camping trip.', ['hiking', 'reference', 'weekend'], 0, 0],
  ['Serious Eats: recipes and cooking techniques', 'https://www.seriouseats.com/', 'Find a new weeknight recipe and learn the techniques behind it.', ['recipes', 'weeknight'], 1, 0],
  ['Budget Bytes', 'https://www.budgetbytes.com/', 'Simple dinner ideas for a busy week. Look for one-pot meals.', ['recipes', 'weeknight'], 0, 0],
  ['King Arthur: baking guides', 'https://www.kingarthurbaking.com/learn', 'Bread and baking projects for a slow weekend.', ['recipes', 'weekend', 'reference'], 0, 0],
  ['Open Library', 'https://openlibrary.org/', 'Reading ideas to return to after work.', ['reading', 'weekend'], 0, 0],
  ['Smashing Magazine', 'https://www.smashingmagazine.com/', 'Articles about accessible interfaces and thoughtful web design.', ['design', 'web', 'reading'], 0, 0],
  ['A List Apart', 'https://alistapart.com/', 'Essays on designing and building for the web.', ['design', 'web', 'reading'], 0, 0],
  ['Personal trip planning notes', 'https://example.com/trip-notes', 'Fictional demo note: compare two routes before the weekend. Keep this bookmark private.', ['hiking', 'weekend'], 0, 1],
  ['Draft website moodboard', 'https://example.com/draft-moodboard', 'Fictional demo project: early ideas that are not ready to share.', ['design', 'inspiration'], 0, 1],
  ['Web design inspiration', 'https://www.awwwards.com/', 'A few visual ideas to discuss. Merge the inspiration label into design in the tag demo.', ['inspiration', 'web'], 0, 0],
]
const quote = value => `'${String(value).replaceAll("'", "''")}'`
const uid = `(SELECT id FROM users WHERE email = ${quote(email)})`
const statements = [
  `INSERT INTO users (username, email, password_hash, membership_tier, role, email_verified, profile_public, theme, link_target) VALUES (${quote(username)}, ${quote(email)}, ${quote(await hash(password, 10))}, 'free', 'user', 1, 0, 'slate', 'new') ON CONFLICT(email) DO NOTHING;`,
]
for (const [index, [title, url, description, tags, favorite, privateFlag]] of bookmarks.entries()) {
  const bid = `(SELECT id FROM bookmarks WHERE user_id = ${uid} AND url = ${quote(url)} LIMIT 1)`
  statements.push(`INSERT INTO bookmarks (user_id, title, url, description, is_favorite, is_private, created_at) SELECT ${uid}, ${quote(title)}, ${quote(url)}, ${quote(description)}, ${favorite}, ${privateFlag}, ${quote(`2026-09-${String(30 - index).padStart(2, '0')} 12:00:00`)} WHERE NOT EXISTS (SELECT 1 FROM bookmarks WHERE user_id = ${uid} AND url = ${quote(url)});`)
  for (const tag of tags) {
    statements.push(`INSERT INTO tags (name) VALUES (${quote(tag)}) ON CONFLICT(name) DO NOTHING;`)
    statements.push(`INSERT OR IGNORE INTO bookmark_tags (bookmark_id, tag_id) VALUES (${bid}, (SELECT id FROM tags WHERE name = ${quote(tag)}));`)
  }
}
statements.push(`INSERT OR IGNORE INTO favorite_tags (user_id, tag_id) VALUES (${uid}, (SELECT id FROM tags WHERE name = 'design'));`)
await mkdir(workDirectory, { recursive: true })
await writeFile(demoPath('seed.sql'), statements.join('\n'))
execFileSync(process.execPath, ['node_modules/wrangler/bin/wrangler.js', 'd1', 'execute', 'tagstash-db', '--local', '--file', demoPath('seed.sql')], { stdio: 'pipe' })
await writeFile(demoPath('import.html'), `<!DOCTYPE NETSCAPE-Bookmark-file-1>
<META HTTP-EQUIV="Content-Type" CONTENT="text/html; charset=UTF-8">
<TITLE>Weekend reading</TITLE>
<H1>Weekend reading</H1>
<DL><p>
<DT><A HREF="https://www.gutenberg.org/" TAGS="reading,weekend">Project Gutenberg</A>
<DD>Free ebooks for the weekend reading list.
<DT><A HREF="https://standardebooks.org/" TAGS="reading,design">Standard Ebooks</A>
<DD>Carefully formatted public-domain books.
</DL><p>`)
console.log(`Local demo ready: ${username}; ${bookmarks.length} bookmarks, overlapping tags, favorites, two private bookmarks, and an HTML import fixture.`)
console.log(`Sign in at http://localhost:3000/ with ${email} / ${password}`)

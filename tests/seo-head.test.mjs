import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { onRequestGet as profilePage } from '../functions/u/[username].js';
import { onRequestGet as sitemap } from '../functions/sitemap.xml.js';
import { applyPageHead } from '../scripts/page-head.mjs';
import { PRIVACY_META, SUPPORT_META, DEVELOPERS_META } from '../src/utils/pageMeta.js';
import { createAuthEnv } from './helpers/auth-env.mjs';

// Minimal stand-in for the Workers HTMLRewriter: only the <head> append is needed here.
class FakeRewriter {
  constructor() { this.handlers = {}; }
  on(selector, handler) { this.handlers[selector] = handler; return this; }
  async transform(response) {
    let appended = '';
    this.handlers.head?.element({ append: (content) => { appended += content; } });
    return new Response((await response.text()).replace('</head>', `${appended}</head>`), response);
  }
}

const shell = '<!doctype html><html><head><title>x</title></head><body><div id="root"></div></body></html>';
// Accounts default to old enough for the indexing bar; tests add the bookmarks they need.
const insertUser = (env, username, { isPublic = 1, updatedAt = '2026-10-01 00:00:00', createdAt = '2025-01-01 00:00:00' } = {}) =>
  Number(env.sqlite.prepare(
    `INSERT INTO users (username, email, password_hash, email_verified, profile_public, created_at, updated_at)
     VALUES (?, ?, 'x', 1, ?, ?, ?)`,
  ).run(username, `${username}@example.com`, isPublic, createdAt, updatedAt).lastInsertRowid);
const insertBookmark = (env, userId, { isPrivate = 0, createdAt, updatedAt = createdAt }) =>
  env.sqlite.prepare(
    `INSERT INTO bookmarks (user_id, title, url, is_private, created_at, updated_at) VALUES (?, 't', 'https://example.com/', ?, ?, ?)`,
  ).run(userId, isPrivate, createdAt, updatedAt);

const getProfile = (env, username, search = '') => {
  globalThis.HTMLRewriter = FakeRewriter;
  return profilePage({
    request: new Request(`https://tagsta.sh/u/${username}${search}`),
    env,
    params: { username },
    next: async () => new Response(shell, { headers: { 'Content-Type': 'text/html' } }),
  });
};

test('a missing profile is a real 404 that keeps the SPA shell and noindex', async () => {
  const env = await createAuthEnv();
  try {
    const response = await getProfile(env, 'doesnotexist');
    assert.equal(response.status, 404);
    assert.equal(response.headers.get('X-Robots-Tag'), 'noindex');
    assert.equal(response.headers.get('Content-Type'), 'text/html');
    const html = await response.text();
    assert.match(html, /<div id="root"><\/div>/);
    assert.match(html, /<meta name="robots" content="noindex" \/>/);
    assert.ok(!html.includes('application/ld+json'));
  } finally { env.sqlite.close(); }
});

test('a profile that is not public is indistinguishable from a missing one', async () => {
  const env = await createAuthEnv();
  try {
    insertUser(env, 'hidden', { isPublic: 0 });
    assert.equal((await getProfile(env, 'hidden')).status, 404);
  } finally { env.sqlite.close(); }
});

test('a failed lookup is a 503, not a 404 that would drop a real profile', async () => {
  const env = { DB: { prepare() { throw new Error('D1 unavailable'); } } };
  const response = await getProfile(env, 'someone');
  assert.equal(response.status, 503);
  assert.equal(response.headers.get('X-Robots-Tag'), 'noindex');
  assert.equal(response.headers.get('Retry-After'), '60');
});

test('a public profile above the indexing bar stays 200 and indexable', async () => {
  const env = await createAuthEnv();
  try {
    const visible = insertUser(env, 'visible');
    for (let i = 0; i < 5; i += 1) insertBookmark(env, visible, { createdAt: '2026-01-02 10:00:00' });
    const response = await getProfile(env, 'visible');
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('X-Robots-Tag'), null);
    assert.ok(!(await response.text()).includes('name="robots"'));
  } finally { env.sqlite.close(); }
});

test('canonical, og:url and JSON-LD use the stored username casing, whatever the URL casing', async () => {
  const env = await createAuthEnv();
  try {
    insertUser(env, 'JustinM');
    for (const requested of ['justinm', 'JUSTINM', 'JustinM']) {
      const response = await getProfile(env, requested, '?tag=css');
      assert.equal(response.status, 200);
      const html = await response.text();
      assert.ok(html.includes('<link rel="canonical" href="https://tagsta.sh/u/JustinM" />'), html);
      assert.ok(html.includes('<meta property="og:url" content="https://tagsta.sh/u/JustinM" />'));
      const block = html.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/);
      const person = JSON.parse(block[1]).mainEntity;
      assert.equal(person.name, 'JustinM');
      assert.equal(person.url, 'https://tagsta.sh/u/JustinM');
    }
  } finally { env.sqlite.close(); }
});

test('sitemap lastmod follows the newest public bookmark, not users.updated_at', async () => {
  const env = await createAuthEnv();
  try {
    const active = insertUser(env, 'active', { updatedAt: '2026-10-11 09:00:00' });
    for (let i = 0; i < 4; i += 1) insertBookmark(env, active, { createdAt: '2026-01-02 10:00:00' });
    insertBookmark(env, active, { createdAt: '2026-02-03 10:00:00', updatedAt: '2026-03-04 10:00:00' });
    // Newer, but private: must not leak into lastmod.
    insertBookmark(env, active, { isPrivate: 1, createdAt: '2026-09-09 10:00:00' });
    // Below the bar (fewer than 5 public bookmarks): listed nowhere, whatever their dates.
    const privateOnly = insertUser(env, 'privateonly', { updatedAt: '2026-10-11 09:00:00' });
    for (let i = 0; i < 5; i += 1) insertBookmark(env, privateOnly, { isPrivate: 1, createdAt: '2026-09-09 10:00:00' });
    insertUser(env, 'empty', { updatedAt: '2026-10-11 09:00:00' });
    insertUser(env, 'notpublic', { isPublic: 0 });

    const xml = await (await sitemap({ request: new Request('https://tagsta.sh/sitemap.xml'), env })).text();
    assert.match(xml, /<loc>https:\/\/tagsta\.sh\/u\/active<\/loc><lastmod>2026-03-04<\/lastmod><\/url>/);
    assert.ok(!xml.includes('privateonly'));
    assert.ok(!xml.includes('/u/empty'));
    assert.ok(!xml.includes('notpublic'));
    assert.ok(!xml.includes('2026-10-11'));
    assert.ok(!/changefreq|priority/.test(xml));
    assert.match(xml, /<loc>https:\/\/tagsta\.sh\/features<\/loc><lastmod>/);
  } finally { env.sqlite.close(); }
});

test('sitemap still works before the is_private migration is applied', async () => {
  const env = await createAuthEnv();
  try {
    env.sqlite.exec('DROP INDEX idx_bookmarks_user_private; ALTER TABLE bookmarks DROP COLUMN is_private');
    const user = insertUserWithoutPrivateColumn(env);
    for (let i = 0; i < 5; i += 1) {
      env.sqlite.prepare(`INSERT INTO bookmarks (user_id, title, url, created_at, updated_at) VALUES (?, 't', 'https://example.com/', '2026-05-06 00:00:00', '2026-05-06 00:00:00')`).run(user);
    }
    const xml = await (await sitemap({ request: new Request('https://tagsta.sh/sitemap.xml'), env })).text();
    assert.match(xml, /\/u\/legacy<\/loc><lastmod>2026-05-06<\/lastmod>/);
  } finally { env.sqlite.close(); }
});

function insertUserWithoutPrivateColumn(env) {
  return Number(env.sqlite.prepare(
    `INSERT INTO users (username, email, password_hash, email_verified, profile_public, created_at) VALUES ('legacy', 'legacy@example.com', 'x', 1, 1, '2025-01-01 00:00:00')`,
  ).run().lastInsertRowid);
}

test('prerendered public pages carry their own head, not the homepage one', () => {
  const index = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
  for (const meta of [PRIVACY_META, SUPPORT_META, DEVELOPERS_META]) {
    const html = applyPageHead(index, meta);
    const url = `https://tagsta.sh${meta.path}`;
    assert.ok(html.includes(`<title>${meta.title}</title>`));
    assert.ok(html.includes(`<meta name="description" content="${meta.description}" />`));
    assert.ok(html.includes(`<link rel="canonical" href="${url}" />`));
    assert.ok(html.includes(`<meta property="og:url" content="${url}" />`));
    assert.ok(html.includes(`<meta property="og:title" content="${meta.title}" />`));
    assert.ok(html.includes(`<meta property="og:description" content="${meta.description}" />`));
    assert.ok(html.includes(`<meta name="twitter:title" content="${meta.title}" />`));
    assert.ok(!html.includes('href="https://tagsta.sh/"'));
    assert.ok(!html.includes('Tag-Based Bookmark Manager</title>'));
  }
});

test('page head rewriting escapes markup and refuses a shell it cannot rewrite', () => {
  const index = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
  const html = applyPageHead(index, { title: 'A "quoted" <b> $& title', description: "it's <i>", path: '/x' });
  assert.ok(html.includes('<title>A &quot;quoted&quot; &lt;b&gt; $&amp; title</title>'));
  assert.ok(html.includes('content="it&#39;s &lt;i&gt;"'));
  assert.throws(() => applyPageHead('<html><head></head></html>', PRIVACY_META), /Could not rewrite/);
});

test('index.html head: apple-touch-icon, og image dimensions and linked WebSite id', () => {
  const index = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
  assert.match(index, /<link rel="apple-touch-icon" href="\/apple-touch-icon\.png" \/>/);
  assert.match(index, /og:image:width" content="1200"/);
  assert.match(index, /og:image:height" content="630"/);
  assert.match(index, /og:image:alt" content="[^"]+"/);
  assert.match(index, /"@id": "https:\/\/tagsta\.sh\/#website"/);
  assert.equal(JSON.parse(readFileSync(new URL('../public/manifest.json', import.meta.url), 'utf8')).background_color, '#1b1a20');
});

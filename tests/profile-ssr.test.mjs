import test from 'node:test';
import assert from 'node:assert/strict';
import { onRequestGet as profilePage, renderProfileBookmarks, safeHttpUrl, SSR_BOOKMARK_LIMIT } from '../functions/u/[username].js';
import { createAuthEnv } from './helpers/auth-env.mjs';

// Minimal stand-in for the Workers HTMLRewriter: the <head> append and the before-#root insert.
class FakeRewriter {
  constructor() { this.handlers = {}; }
  on(selector, handler) { this.handlers[selector] = handler; return this; }
  async transform(response) {
    let appended = '';
    let before = '';
    this.handlers.head?.element({ append: (content) => { appended += content; } });
    this.handlers['#root']?.element({ before: (content) => { before += content; } });
    const html = (await response.text())
      .replace('</head>', `${appended}</head>`)
      .replace('<div id="root">', () => `${before}<div id="root">`);
    return new Response(html, response);
  }
}

const shell = '<!doctype html><html><head><title>x</title></head><body><div id="root"></div></body></html>';
const OLD = '2025-01-01 00:00:00';

const insertUser = (env, username, { isPublic = 1, verified = 1, createdAt = OLD, suspended = false } = {}) =>
  Number(env.sqlite.prepare(
    `INSERT INTO users (username, email, password_hash, email_verified, profile_public, created_at, suspended_at)
     VALUES (?, ?, 'x', ?, ?, ?, ?)`,
  ).run(username, `${username}@example.com`, verified, isPublic, createdAt, suspended ? OLD : null).lastInsertRowid);

const insertBookmark = (env, userId, { title = 't', url = 'https://example.com/', isPrivate = 0, createdAt = '2026-01-01 00:00:00', tags = [] } = {}) => {
  const id = Number(env.sqlite.prepare(
    'INSERT INTO bookmarks (user_id, title, url, is_private, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
  ).run(userId, title, url, isPrivate, createdAt, createdAt).lastInsertRowid);
  for (const name of tags) {
    env.sqlite.prepare('INSERT OR IGNORE INTO tags (name) VALUES (?)').run(name);
    env.sqlite.prepare('INSERT INTO bookmark_tags (bookmark_id, tag_id) SELECT ?, id FROM tags WHERE name = ?').run(id, name);
  }
  return id;
};

const getProfile = (env, username) => {
  globalThis.HTMLRewriter = FakeRewriter;
  return profilePage({
    request: new Request(`https://tagsta.sh/u/${encodeURIComponent(username)}`),
    env,
    params: { username: encodeURIComponent(username) },
    next: async () => new Response(shell, { headers: { 'Content-Type': 'text/html' } }),
  });
};

// The snapshot sits right before an untouched, empty #root (React owns #root).
const rootOf = (html) => {
  const match = html.match(/<body>([\s\S]*)<div id="root"><\/div><\/body>/);
  assert.ok(match, '#root stays empty and last in <body>');
  return match[1];
};

test('an indexable profile server-renders its newest public bookmarks with ugc links and tags', async () => {
  const env = await createAuthEnv();
  try {
    const user = insertUser(env, 'Reader');
    for (let i = 1; i <= 5; i += 1) {
      insertBookmark(env, user, { title: `Public ${i}`, url: `https://www.site${i}.example/page`, createdAt: `2026-01-0${i} 10:00:00`, tags: ['zeta', 'alpha'] });
    }
    insertBookmark(env, user, { title: 'Secret plans', url: 'https://private.example/', isPrivate: 1, createdAt: '2026-02-01 00:00:00', tags: ['secrettag'] });

    const response = await getProfile(env, 'reader');
    assert.equal(response.status, 200);
    const html = await response.text();
    const root = rootOf(html);
    assert.ok(root.startsWith('<div id="ssr-profile">'), 'snapshot is a sibling container before #root');
    assert.ok(root.includes('<h1>@Reader&#39;s bookmarks</h1>'), 'heading uses the stored casing');
    assert.ok(root.includes('<a class="footer-privacy-link" href="/support?report=Reader" rel="nofollow">Report this profile</a>'));
    assert.ok(root.includes('<p class="results-count">5 bookmarks</p>'));
    assert.equal((root.match(/<article class="bookmark-card">/g) || []).length, 5);
    // Newest first, like the profile page's default sort.
    const titles = [...root.matchAll(/rel="ugc nofollow noopener">([^<]*)<\/a>/g)].map((m) => m[1]);
    assert.deepEqual(titles, ['Public 5', 'Public 4', 'Public 3', 'Public 2', 'Public 1']);
    assert.ok(root.includes('<a href="https://www.site5.example/page" rel="ugc nofollow noopener">Public 5</a>'));
    assert.ok(root.includes('<span class="bookmark-url">site5.example</span>'));
    assert.ok(root.includes('<div class="tags"><span class="tag-stock">alpha</span><span class="tag-stock">zeta</span></div>'));
    // Private bookmarks and their tags never appear.
    assert.ok(!html.includes('Secret plans'));
    assert.ok(!html.includes('private.example'));
    assert.ok(!root.includes('secrettag'));
    // Head metadata is unchanged by the body snapshot.
    assert.ok(html.includes('<link rel="canonical" href="https://tagsta.sh/u/Reader" />'));
    assert.ok(!html.includes('name="robots"'));
  } finally { env.sqlite.close(); }
});

test(`the snapshot is capped at the ${SSR_BOOKMARK_LIMIT} most recent bookmarks`, async () => {
  const env = await createAuthEnv();
  try {
    const user = insertUser(env, 'hoarder');
    const total = SSR_BOOKMARK_LIMIT + 5;
    for (let i = 0; i < total; i += 1) {
      const day = new Date(Date.UTC(2025, 0, 1) + i * 86400000).toISOString().slice(0, 10);
      insertBookmark(env, user, { title: `B${i}`, createdAt: `${day} 00:00:00` });
    }
    const root = rootOf(await (await getProfile(env, 'hoarder')).text());
    assert.equal((root.match(/<article class="bookmark-card">/g) || []).length, SSR_BOOKMARK_LIMIT);
    assert.ok(root.includes(`${SSR_BOOKMARK_LIMIT} most recent of ${total} bookmarks`));
    assert.ok(root.includes(`>B${total - 1}<`), 'newest included');
    assert.ok(!root.includes('>B4<'), 'oldest dropped');
  } finally { env.sqlite.close(); }
});

test('hostile titles, tags and URLs are escaped and only http(s) URLs become links', async () => {
  const env = await createAuthEnv();
  try {
    const user = insertUser(env, 'mallory');
    const hostileTitle = `</script><script>alert(1)</script>"'><img src=x onerror=alert(2)>`;
    insertBookmark(env, user, { title: hostileTitle, url: 'javascript:alert(document.cookie)', createdAt: '2026-01-09 00:00:00', tags: ['"><svg/onload=alert(3)>'] });
    insertBookmark(env, user, { title: 'data link', url: 'data:text/html,<script>alert(4)</script>', createdAt: '2026-01-08 00:00:00' });
    insertBookmark(env, user, { title: 'quote breaker', url: 'https://evil.example/"onmouseover="alert(5)\'<x>', createdAt: '2026-01-07 00:00:00' });
    insertBookmark(env, user, { title: 'vbscript', url: ' JaVaScRiPt:alert(6)', createdAt: '2026-01-06 00:00:00' });
    insertBookmark(env, user, { title: 'not a url', url: 'no scheme here', createdAt: '2026-01-05 00:00:00' });

    const response = await getProfile(env, 'mallory');
    assert.equal(response.status, 200);
    const root = rootOf(await response.text());

    assert.ok(!/<script/i.test(root), 'no script element');
    assert.ok(!/<img src=x|<svg/i.test(root), 'no injected elements');
    // Every "<" from user content is escaped, so any tag left is ours: none may carry a handler.
    assert.ok(!/<[^>]*\son[a-z]+\s*=/i.test(root), 'no event-handler attributes');
    const cards = (root.match(/<article class="bookmark-card">[\s\S]*?<\/article>/g) || []).join('');
    const hrefs = [...cards.matchAll(/href="([^"]*)"/g)].map((m) => m[1]);
    assert.equal(hrefs.length, 1, 'only the https bookmark is linked');
    assert.ok(hrefs.every((href) => /^https?:\/\//.test(href)), 'every bookmark href is http(s)');
    assert.ok(!root.includes('data:text/html'));

    // The javascript: bookmark keeps its escaped title but is rendered unlinked.
    assert.ok(root.includes('<h3 class="bookmark-title">&lt;/script&gt;&lt;script&gt;alert(1)&lt;/script&gt;&quot;&#39;&gt;&lt;img src=x onerror=alert(2)&gt;</h3>'));
    assert.ok(root.includes('<span class="tag-stock">&quot;&gt;&lt;svg/onload=alert(3)&gt;</span>'));
    // A valid https URL with quotes is emitted percent-encoded/escaped inside the attribute.
    const quoteLink = root.match(/<a href="([^"]*)" rel="ugc nofollow noopener">quote breaker<\/a>/);
    assert.ok(quoteLink, 'https link kept');
    assert.ok(quoteLink[1].startsWith('https://evil.example/'));
    assert.ok(!/[<>"]/.test(quoteLink[1]));
    for (const title of ['data link', 'vbscript', 'not a url']) {
      assert.ok(root.includes(`<h3 class="bookmark-title">${title}</h3>`), `${title} rendered unlinked`);
    }
  } finally { env.sqlite.close(); }
});

test('renderProfileBookmarks escapes the username', () => {
  const html = renderProfileBookmarks('</h1><script>x</script>"', [{ title: 't', url: 'https://a.example/', tags: '[]' }], 1);
  assert.ok(!html.includes('<script>'));
  assert.ok(html.includes('@&lt;/h1&gt;&lt;script&gt;x&lt;/script&gt;&quot;&#39;s bookmarks'));
  assert.ok(html.includes('href="/support?report=%3C%2Fh1%3E%3Cscript%3Ex%3C%2Fscript%3E%22"'));
  assert.equal(safeHttpUrl('javascript:alert(1)'), null);
  assert.equal(safeHttpUrl('//evil.example'), null);
  assert.equal(safeHttpUrl('HTTPS://ok.example').href, 'https://ok.example/');
});

test('profiles below the bar, not public, suspended or missing render no bookmark list', async () => {
  const env = await createAuthEnv();
  try {
    const cases = [
      ['fewbookmarks', {}, 4, 200],
      ['unverified', { verified: 0 }, 5, 200],
      ['newcomer', { createdAt: new Date().toISOString().replace('T', ' ').slice(0, 19) }, 5, 200],
      ['notpublic', { isPublic: 0 }, 5, 404],
      ['suspended', { suspended: true }, 5, 404],
    ];
    for (const [username, options, count, status] of cases) {
      const id = insertUser(env, username, options);
      for (let i = 0; i < count; i += 1) insertBookmark(env, id, { title: `visible-${username}` });
    }
    // A below-bar profile whose 5th bookmark is private still doesn't qualify.
    const mixed = insertUser(env, 'mixed');
    for (let i = 0; i < 4; i += 1) insertBookmark(env, mixed, { title: 'visible-mixed' });
    insertBookmark(env, mixed, { title: 'visible-mixed', isPrivate: 1 });
    cases.push(['mixed', {}, 5, 200], ['doesnotexist', {}, 0, 404]);

    for (const [username, , , status] of cases) {
      const response = await getProfile(env, username);
      assert.equal(response.status, status, username);
      const html = await response.text();
      assert.match(html, /<body><div id="root"><\/div><\/body>/, `${username}: empty root, no snapshot`);
      assert.ok(!html.includes('ssr-profile'), username);
      assert.ok(!html.includes('bookmark-card'), username);
      assert.ok(!html.includes(`visible-${username}`), username);
    }
  } finally { env.sqlite.close(); }
});

test('a failed snapshot query degrades to metadata only, not a 503', async () => {
  const env = await createAuthEnv();
  try {
    const user = insertUser(env, 'flaky');
    for (let i = 0; i < 5; i += 1) insertBookmark(env, user, { tags: ['css'] });
    const realDb = env.DB;
    let snapshotQueries = 0;
    const failing = {
      ...env,
      DB: {
        prepare(sql) {
          if (sql.includes('WITH recent AS')) {
            snapshotQueries += 1;
            throw new Error('D1 hiccup');
          }
          return realDb.prepare(sql);
        },
      },
    };
    const response = await getProfile(failing, 'flaky');
    assert.equal(snapshotQueries, 1);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('X-Robots-Tag'), null);
    const html = await response.text();
    assert.match(html, /<body><div id="root"><\/div><\/body>/);
    assert.ok(!html.includes('ssr-profile'));
    assert.ok(html.includes('tagged with css'));
    assert.ok(html.includes('application/ld+json'));
  } finally { env.sqlite.close(); }
});

test('below-bar profiles never run the snapshot query', async () => {
  const env = await createAuthEnv();
  try {
    insertUser(env, 'quiet');
    const realDb = env.DB;
    const seen = [];
    const spy = { ...env, DB: { prepare(sql) { seen.push(sql); return realDb.prepare(sql); } } };
    assert.equal((await getProfile(spy, 'quiet')).status, 200);
    assert.ok(!seen.some((sql) => sql.includes('WITH recent AS')));
  } finally { env.sqlite.close(); }
});

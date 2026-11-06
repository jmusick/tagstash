import test from 'node:test';
import assert from 'node:assert/strict';
import { onRequestGet as feed, onRequestHead as feedHead } from '../functions/u/[username]/feed.xml.js';
import { onRequestGet as profilePage } from '../functions/u/[username].js';
import { FEED_ITEM_LIMIT, FEED_MAX_TAG_FILTERS, profileFeedCacheKey, renderProfileFeed } from '../functions/_lib/profileFeed.js';
import { profileFeedUrl } from '../src/utils/profileFeed.js';
import { createAuthEnv } from './helpers/auth-env.mjs';

// RSS feed per public profile and tag (issue #94): GET /u/:username/feed.xml?tag=x.

const OLD = '2025-01-01 00:00:00';

const insertUser = (env, username, { isPublic = 1, verified = 1, createdAt = OLD, suspended = false } = {}) =>
  Number(env.sqlite.prepare(
    `INSERT INTO users (username, email, password_hash, email_verified, profile_public, created_at, suspended_at)
     VALUES (?, ?, 'x', ?, ?, ?, ?)`,
  ).run(username, `${username}@example.com`, verified, isPublic, createdAt, suspended ? OLD : null).lastInsertRowid);

const insertBookmark = (env, userId, {
  title = 't', url = 'https://example.com/', description = null, note = null, isPrivate = 0,
  deletedAt = null, createdAt = '2026-01-01 00:00:00', tags = [],
} = {}) => {
  const id = Number(env.sqlite.prepare(
    `INSERT INTO bookmarks (user_id, title, url, description, note, is_private, deleted_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(userId, title, url, description, note, isPrivate, deletedAt, createdAt, createdAt).lastInsertRowid);
  for (const name of tags) {
    env.sqlite.prepare('INSERT OR IGNORE INTO tags (name) VALUES (?)').run(name);
    env.sqlite.prepare('INSERT INTO bookmark_tags (bookmark_id, tag_id) SELECT ?, id FROM tags WHERE name = ?').run(id, name);
  }
  return id;
};

const getFeed = (env, path, { method = 'GET', waitUntil } = {}) => {
  const url = new URL(path, 'https://tagsta.sh');
  const username = url.pathname.split('/')[2];
  const handler = method === 'HEAD' ? feedHead : feed;
  return handler({
    request: new Request(url, { method }),
    env,
    params: { username },
    ...(waitUntil ? { waitUntil } : {}),
  });
};

const itemsOf = (xml) => [...xml.matchAll(/<item>([\s\S]*?)<\/item>/g)].map((m) => m[1]);
const field = (item, name) => item.match(new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`))?.[1];

class FakeCache {
  constructor() { this.entries = new Map(); this.puts = []; this.deletes = []; }
  async match(request) {
    const entry = this.entries.get(request.url);
    return entry ? new Response(entry.body, { status: entry.status, headers: entry.headers }) : undefined;
  }
  async put(request, response) {
    const control = response.headers.get('Cache-Control') || '';
    if (/no-store|private/i.test(control) || !/(s-maxage|max-age)=[1-9]/.test(control)) {
      throw new TypeError('Cache API refused: response is not cacheable');
    }
    this.puts.push(request.url);
    this.entries.set(request.url, { status: response.status, headers: [...response.headers], body: await response.text() });
  }
  async delete(request) {
    this.deletes.push(request.url);
    return this.entries.delete(request.url);
  }
}

const countQueries = (env) => {
  const state = { count: 0 };
  const prepare = env.DB.prepare.bind(env.DB);
  env.DB.prepare = (sql) => { state.count += 1; return prepare(sql); };
  return state;
};

test('a public profile serves RSS 2.0 of its newest public bookmarks, never private, trashed or notes', async () => {
  const env = await createAuthEnv();
  try {
    const user = insertUser(env, 'Reader');
    insertBookmark(env, user, { title: 'Older', url: 'https://old.example/', createdAt: '2026-01-01 08:00:00', tags: ['zeta', 'alpha'] });
    insertBookmark(env, user, {
      title: 'Newer', url: 'https://new.example/a?b=1&c=2', description: 'A described page',
      note: 'SECRET-NOTE-TEXT', createdAt: '2026-01-02 09:30:00', tags: ['alpha'],
    });
    insertBookmark(env, user, { title: 'Private one', url: 'https://private.example/', isPrivate: 1, createdAt: '2026-02-01 00:00:00', tags: ['secrettag'] });
    insertBookmark(env, user, { title: 'Trashed one', url: 'https://trash.example/', deletedAt: '2026-02-02 00:00:00', createdAt: '2026-02-02 00:00:00' });

    const response = await getFeed(env, '/u/reader/feed.xml');
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('Content-Type'), 'application/rss+xml; charset=utf-8');
    assert.equal(response.headers.get('X-Robots-Tag'), 'noindex');
    assert.equal(response.headers.get('X-Content-Type-Options'), 'nosniff');
    assert.equal(response.headers.get('Access-Control-Allow-Origin'), '*');
    assert.equal(response.headers.get('Cache-Control'), 'public, max-age=0, s-maxage=60');
    assert.match(response.headers.get('Strict-Transport-Security'), /max-age=/);

    const xml = await response.text();
    assert.ok(xml.startsWith('<?xml version="1.0" encoding="UTF-8"?>\n<rss version="2.0"'));
    assert.ok(xml.includes("<title>@Reader&apos;s bookmarks - Tagstash</title>"), 'stored casing');
    assert.ok(xml.includes('<link>https://tagsta.sh/u/Reader</link>'));
    assert.ok(xml.includes('<atom:link href="https://tagsta.sh/u/Reader/feed.xml" rel="self" type="application/rss+xml" />'));
    assert.ok(xml.includes('<lastBuildDate>Fri, 02 Jan 2026 09:30:00 GMT</lastBuildDate>'));

    const items = itemsOf(xml);
    assert.deepEqual(items.map((item) => field(item, 'title')), ['Newer', 'Older'], 'newest first, public only');
    assert.equal(field(items[0], 'link'), 'https://new.example/a?b=1&amp;c=2');
    assert.equal(field(items[0], 'description'), 'A described page');
    assert.equal(field(items[0], 'pubDate'), 'Fri, 02 Jan 2026 09:30:00 GMT');
    assert.match(field(items[0], 'guid'), /^https:\/\/tagsta\.sh\/u\/Reader#bookmark-\d+$/);
    assert.ok(items[0].includes('<guid isPermaLink="false">'));
    assert.equal(field(items[1], 'description'), undefined, 'no empty description element');
    assert.deepEqual([...items[1].matchAll(/<category>([^<]*)<\/category>/g)].map((m) => m[1]), ['alpha', 'zeta']);

    for (const leaked of ['SECRET-NOTE-TEXT', 'Private one', 'secrettag', 'Trashed one']) {
      assert.ok(!xml.includes(leaked), `${leaked} must not appear`);
    }
  } finally { env.sqlite.close(); }
});

test('missing, private and suspended profiles get the same 404; a bad encoding is a 404 too', async () => {
  const env = await createAuthEnv();
  try {
    insertBookmark(env, insertUser(env, 'hidden', { isPublic: 0 }), { title: 'h' });
    insertBookmark(env, insertUser(env, 'banned', { suspended: true }), { title: 'b' });
    const bodies = new Set();
    for (const path of ['/u/nobody/feed.xml', '/u/hidden/feed.xml', '/u/banned/feed.xml', '/u/%E0%A4%A/feed.xml']) {
      const response = await getFeed(env, path);
      assert.equal(response.status, 404, path);
      assert.equal(response.headers.get('Cache-Control'), 'no-store', path);
      assert.equal(response.headers.get('X-Robots-Tag'), 'noindex', path);
      bodies.add(`${response.headers.get('Content-Type')}|${await response.text()}`);
    }
    assert.equal(bodies.size, 1, 'one indistinguishable response');
  } finally { env.sqlite.close(); }
});

test('?tag= narrows the feed with AND semantics, case-insensitively, and names the tags', async () => {
  const env = await createAuthEnv();
  try {
    const user = insertUser(env, 'cook');
    insertBookmark(env, user, { title: 'Soup', createdAt: '2026-01-01 00:00:00', tags: ['Recipes', 'soup'] });
    insertBookmark(env, user, { title: 'Bread', createdAt: '2026-01-02 00:00:00', tags: ['recipes'] });
    insertBookmark(env, user, { title: 'Private soup', isPrivate: 1, createdAt: '2026-01-03 00:00:00', tags: ['recipes', 'soup'] });
    insertBookmark(env, user, { title: 'Unrelated', createdAt: '2026-01-04 00:00:00', tags: ['travel'] });

    let xml = await (await getFeed(env, '/u/cook/feed.xml?tag=%20RECIPES%20')).text();
    assert.deepEqual(itemsOf(xml).map((item) => field(item, 'title')), ['Bread', 'Soup'], 'legacy mixed-case tag matches');
    assert.ok(xml.includes('<title>@cook&apos;s bookmarks tagged recipes - Tagstash</title>'));
    assert.ok(xml.includes('<link>https://tagsta.sh/u/cook?tag=recipes</link>'));

    xml = await (await getFeed(env, '/u/cook/feed.xml?tag=recipes&tag=soup&tag=recipes')).text();
    assert.deepEqual(itemsOf(xml).map((item) => field(item, 'title')), ['Soup']);
    assert.ok(xml.includes('tagged recipes + soup'));
    assert.ok(xml.includes('href="https://tagsta.sh/u/cook/feed.xml?tag=recipes&amp;tag=soup"'));

    xml = await (await getFeed(env, '/u/cook/feed.xml?tag=nothing')).text();
    assert.equal(itemsOf(xml).length, 0, 'an unknown tag is an empty feed, not an error');

    const tooMany = Array.from({ length: FEED_MAX_TAG_FILTERS + 1 }, (_, i) => `tag=t${i}`).join('&');
    const rejected = await getFeed(env, `/u/cook/feed.xml?${tooMany}`);
    assert.equal(rejected.status, 400);
  } finally { env.sqlite.close(); }
});

test(`the feed is capped at the newest ${FEED_ITEM_LIMIT} bookmarks`, async () => {
  const env = await createAuthEnv();
  try {
    const user = insertUser(env, 'hoarder');
    for (let i = 0; i < FEED_ITEM_LIMIT + 5; i += 1) {
      insertBookmark(env, user, { title: `B${i}`, createdAt: `2026-01-01 00:${String(Math.floor(i / 60)).padStart(2, '0')}:${String(i % 60).padStart(2, '0')}` });
    }
    const items = itemsOf(await (await getFeed(env, '/u/hoarder/feed.xml')).text());
    assert.equal(items.length, FEED_ITEM_LIMIT);
    assert.equal(field(items[0], 'title'), `B${FEED_ITEM_LIMIT + 4}`);
  } finally { env.sqlite.close(); }
});

test('hostile titles, tags and URLs are escaped, control characters dropped, unsafe links replaced', () => {
  const xml = renderProfileFeed({
    origin: 'https://tagsta.sh',
    username: 'o\'brien<x>',
    tags: ['a&b'],
    bookmarks: [
      { id: 1, title: '</title><script>alert(1)</script>\u0001\u0008', url: 'javascript:alert(1)', description: ']]> & <b>', created_at: 'bogus', tags: '["<t>"]' },
      { id: 2, title: '', url: 'https://ok.example/', created_at: '2026-01-01 00:00:00', tags: 'not json' },
    ],
  });
  assert.ok(!/<script|<\/title><script|<b>|<t>|\u0001|\u0008/.test(xml));
  assert.ok(xml.includes('&lt;/title&gt;&lt;script&gt;alert(1)&lt;/script&gt;'));
  const [first, second] = itemsOf(xml);
  assert.equal(field(first, 'link'), 'https://tagsta.sh/u/o&apos;brien%3Cx%3E?tag=a%26b', 'javascript: links fall back to the profile');
  assert.equal(field(first, 'pubDate'), undefined, 'unparseable dates are left out');
  assert.equal(field(first, 'category'), '&lt;t&gt;');
  assert.equal(field(second, 'title'), 'https://ok.example/', 'an untitled bookmark uses its URL');
  assert.equal(field(second, 'category'), undefined);
});

test('HEAD answers with the GET status and headers but no body; a D1 failure is a 503', async () => {
  const env = await createAuthEnv();
  try {
    insertBookmark(env, insertUser(env, 'probe'), { title: 'p' });
    const head = await getFeed(env, '/u/probe/feed.xml', { method: 'HEAD' });
    assert.equal(head.status, 200);
    assert.equal(head.headers.get('Content-Type'), 'application/rss+xml; charset=utf-8');
    assert.equal(await head.text(), '');
    assert.equal((await getFeed(env, '/u/nobody/feed.xml', { method: 'HEAD' })).status, 404);

    const broken = await getFeed({ DB: { prepare() { throw new Error('d1 down'); } } }, '/u/probe/feed.xml');
    assert.equal(broken.status, 503);
    assert.equal(broken.headers.get('Retry-After'), '60');
    assert.equal(broken.headers.get('Cache-Control'), 'no-store');
  } finally { env.sqlite.close(); }
});

test('the edge cache stores 200s under a canonical key and serves hits without D1', async () => {
  const env = await createAuthEnv();
  const cache = new FakeCache();
  globalThis.caches = { default: cache };
  try {
    insertBookmark(env, insertUser(env, 'Alice'), { title: 'cached', tags: ['poe2'] });
    const miss = await getFeed(env, '/u/ALICE/feed.xml?utm_source=x');
    assert.equal(miss.headers.get('X-Tagstash-Cache'), 'MISS');
    assert.deepEqual(cache.puts, ['https://tagsta.sh/u/alice/feed.xml']);

    const queries = countQueries(env);
    const hit = await getFeed(env, '/u/alice/feed.xml');
    assert.equal(hit.headers.get('X-Tagstash-Cache'), 'HIT');
    assert.equal(hit.headers.get('X-Robots-Tag'), 'noindex', 'headers are rebuilt on hits');
    assert.equal(hit.headers.get('Access-Control-Allow-Origin'), '*');
    assert.equal(queries.count, 0);
    assert.equal(await hit.text(), await miss.text());

    await getFeed(env, '/u/alice/feed.xml?tag=POE2');
    assert.ok(cache.puts.includes('https://tagsta.sh/u/alice/feed.xml?tag=poe2'));
    assert.equal((await getFeed(env, '/u/nobody/feed.xml')).status, 404);
    assert.equal(cache.puts.length, 2, '404s are never stored');
    assert.equal(profileFeedCacheKey('https://tagsta.sh', 'Alice', ['poe2']).url, 'https://tagsta.sh/u/alice/feed.xml?tag=poe2');

    // With waitUntil the put runs after the response.
    let pending;
    await getFeed(env, '/u/alice/feed.xml?tag=other', { waitUntil: (promise) => { pending = promise; } });
    await pending;
    assert.ok(cache.puts.includes('https://tagsta.sh/u/alice/feed.xml?tag=other'));
  } finally { delete globalThis.caches; env.sqlite.close(); }
});

test('the profile page advertises its feed to visible profiles only, and the client builds the same URL', async () => {
  const env = await createAuthEnv();
  const shell = '<!doctype html><html><head><title>x</title></head><body><div id="root"></div></body></html>';
  globalThis.HTMLRewriter = class {
    constructor() { this.handlers = {}; }
    on(selector, handler) { this.handlers[selector] = handler; return this; }
    async transform(response) {
      let appended = '';
      this.handlers.head?.element({ append: (content) => { appended += content; } });
      return new Response((await response.text()).replace('</head>', `${appended}</head>`), response);
    }
  };
  const page = async (username) => (await profilePage({
    request: new Request(`https://tagsta.sh/u/${username}`),
    env,
    params: { username },
    next: async () => new Response(shell, { headers: { 'Content-Type': 'text/html' } }),
  })).text();
  try {
    insertUser(env, 'NewUser', { verified: 0 });
    const html = await page('newuser');
    assert.ok(html.includes('<link rel="alternate" type="application/rss+xml" title="@NewUser&#39;s bookmarks - Tagstash" href="https://tagsta.sh/u/NewUser/feed.xml" />'), 'below-bar profiles get it too');
    assert.ok(!(await page('nobody')).includes('application/rss+xml'));
  } finally { delete globalThis.HTMLRewriter; env.sqlite.close(); }

  assert.equal(profileFeedUrl('a b', ['x&y', 'z'], 'https://tagsta.sh'), 'https://tagsta.sh/u/a%20b/feed.xml?tag=x%26y&tag=z');
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { createHash } from 'node:crypto';
import { API_DOC_ROUTES, API_DOC_LIMITS, API_DOC_POLICY, API_DOC_BUDGETS } from '../src/content/developersApi.js';
import { TRASH_RETENTION_DAYS } from '../src/utils/trash.js';
import { createAuthEnv } from './helpers/auth-env.mjs';
import { call } from './helpers/api.mjs';
import { onRequest as pageMiddleware } from '../functions/_middleware.js';
import { onRequestGet as sitemap } from '../functions/sitemap.xml.js';

const source = readFileSync(new URL('../functions/api/[[path]].js', import.meta.url), 'utf8');
const serverConstant = name => {
  const value = new RegExp(`^const ${name} = (\\{[\\s\\S]*?^\\}|[^;\\n]+);`, 'm').exec(source)?.[1];
  assert.ok(value, `Worker constant ${name} exists`);
  return JSON.parse(JSON.stringify(runInNewContext(`(${value})`)));
};

test('developer reference limits and budgets match the Worker', () => {
  const limits = serverConstant('INPUT_LIMITS');
  for (const [name, value] of Object.entries(API_DOC_LIMITS)) assert.equal(value, limits[name], name);
  assert.deepEqual(API_DOC_BUDGETS, serverConstant('USER_RATE_LIMITS'));
  for (const [name, constant] of Object.entries({ freeBookmarks: 'FREE_BOOKMARK_LIMIT', activeKeys: 'MAX_ACTIVE_API_KEYS_PER_USER',
    jsonBytes: 'MAX_JSON_BODY_BYTES', importBytes: 'MAX_IMPORT_BODY_BYTES', profileCacheSeconds: 'PROFILE_CACHE_TTL_SECONDS' })) {
    assert.equal(API_DOC_POLICY[name], serverConstant(constant), name);
  }
  assert.equal(API_DOC_POLICY.retentionDays, TRASH_RETENTION_DAYS);
});

const key = `tsk_${'a1'.repeat(24)}`;
const headers = { Authorization: `Bearer ${key}` };
async function setup() {
  const env = await createAuthEnv();
  env.sqlite.prepare(`INSERT INTO api_keys (user_id, name, key_hash, key_prefix, key_last4)
    VALUES (1, 'Docs contract', ?, 'tsk_a1a1', 'a1a1')`).run(createHash('sha256').update(key).digest('hex'));
  env.sqlite.exec(`
    INSERT INTO bookmarks (id, user_id, title, url, deleted_at) VALUES
      (1, 1, 'Reference', 'https://example.com/', NULL),
      (2, 1, 'Reading', 'https://example.org/', NULL),
      (3, 1, 'Trashed', 'https://trash.example/', CURRENT_TIMESTAMP);
    INSERT INTO tags (id, name) VALUES (1, 'reference'), (2, 'reading');
    INSERT INTO bookmark_tags (bookmark_id, tag_id) VALUES (1, 1), (2, 2), (3, 1);
  `);
  return env;
}

const bookmarkBody = { title: 'New reference', url: 'https://new.example/', description: 'Description', tags: ['reference'] };
const bodies = {
  'POST /api/bookmarks': bookmarkBody,
  'PUT /api/bookmarks/:id': bookmarkBody,
  'PUT /api/bookmarks/tags/:tagId': { name: 'renamed' },
  'POST /api/bookmarks/tags/merge': { sourceTagId: 1, targetTagId: 2 },
  'POST /api/bookmarks/bulk/delete': { ids: [1, 2] },
  'POST /api/bookmarks/bulk/tags': { ids: [1, 2], add: ['new'], remove: ['reference'] },
  'POST /api/bookmarks/bulk/restore': { ids: [3] },
  'POST /api/bookmarks/bulk/purge': { ids: [3] },
  'POST /api/bookmarks/meta': { url: 'https://example.com/' },
  'POST /api/bookmarks/meta-description': { url: 'https://example.com/' },
  'POST /api/bookmarks/import': { bookmarks: [bookmarkBody] },
};

for (const route of API_DOC_ROUTES) {
  const name = `${route.method} ${route.path}`;
  test(`documented personal-key route: ${name}`, async () => {
    const env = await setup();
    const previousFetch = globalThis.fetch;
    // Metadata reads the real parser, without external network requests.
    globalThis.fetch = async () => new Response('<head><title>Reference</title><meta name="description" content="Description"></head>',
      { headers: { 'Content-Type': 'text/html' } });
    try {
      const trashId = /\/(restore|permanent)$/.test(route.path);
      let path = route.path.replace('/api/', '').replace(':tagId', '1').replace(':id', trashId ? '3' : '1');
      if (path.endsWith('/by-url')) path += '?url=https%3A%2F%2Fexample.com%2F';
      const response = await call(env, path, { method: route.method, headers, body: bodies[name] });
      const body = await response.json();
      assert.equal(response.status, route.status, JSON.stringify(body));
      for (const field of route.fields) {
        assert.ok(Object.hasOwn(body, field), `${name} response must include documented ${field}`);
        assert.ok(route.response.includes(`${field}:`), `${field} must appear in the displayed response shape`);
      }
      assert.equal(response.headers.get('Cache-Control'), 'no-store');
      assert.equal((await call(env, path, { method: route.method, body: bodies[name] })).status, 401);
    } finally {
      globalThis.fetch = previousFetch;
      env.sqlite.close();
    }
  });
}

test('documented public profile contract stays keyless, filtered, cacheable and cross-origin', async () => {
  const env = await setup();
  try {
    env.sqlite.exec("UPDATE users SET profile_public = 1; UPDATE bookmarks SET is_private = 1 WHERE id = 2;");
    const response = await call(env, 'profiles/sessiontester?tag=REFERENCE&tag=reference');
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('Access-Control-Allow-Origin'), '*');
    assert.equal(response.headers.get('Cache-Control'), 'public, max-age=0, s-maxage=60');
    const body = await response.json();
    assert.deepEqual(Object.keys(body).sort(), ['appliedTags', 'bookmarks', 'profile', 'tags']);
    assert.deepEqual(Object.keys(body.profile).sort(), ['indexable', 'member_since', 'username']);
    assert.deepEqual(body.appliedTags, ['reference']);
    assert.equal(body.bookmarks.length, 1);
    assert.deepEqual(Object.keys(body.bookmarks[0]).sort(), ['created_at', 'description', 'favicon_url', 'id', 'tags', 'title', 'updated_at', 'url']);
    assert.deepEqual(body.tags, [{ name: 'reference', count: 1 }]);
  } finally { env.sqlite.close(); }
});

test('documented bulk tag cap applies before removals, and removals still run', async () => {
  const env = await setup();
  try {
    // Bookmark 1 starts with one tag; bring it exactly to the documented cap.
    for (let i = 1; i < API_DOC_LIMITS.tagsPerBookmark; i += 1) {
      const { lastInsertRowid } = env.sqlite.prepare('INSERT INTO tags (name) VALUES (?)').run(`cap${i}`);
      env.sqlite.prepare('INSERT INTO bookmark_tags (bookmark_id, tag_id) VALUES (1, ?)').run(lastInsertRowid);
    }
    const response = await call(env, 'bookmarks/bulk/tags', { method: 'POST', headers,
      body: { ids: [1], add: ['new'], remove: ['reference'] } });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.overLimit, 1);
    assert.equal(body.tagsAdded, 0);
    assert.equal(body.tagsRemoved, 1);
    const { bookmark } = await (await call(env, 'bookmarks/1', { headers })).json();
    assert.equal(bookmark.tags.length, API_DOC_LIMITS.tagsPerBookmark - 1);
    assert.ok(!bookmark.tags.some(tag => ['reference', 'new'].includes(tag.name)));
  } finally { env.sqlite.close(); }
});

test('/developers is an indexable page and appears in the sitemap', async () => {
  const response = await pageMiddleware({ request: new Request('https://tagsta.sh/developers'), next: async () =>
    new Response('<html></html>', { headers: { 'Content-Type': 'text/html' } }) });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('X-Robots-Tag'), null);
  const xml = await (await sitemap({ request: new Request('https://tagsta.sh/sitemap.xml'), env: {} })).text();
  assert.ok(xml.includes('<loc>https://tagsta.sh/developers</loc>'));
});

import test from 'node:test';
import assert from 'node:assert/strict';
import bcrypt from 'bcryptjs';
import { onRequest } from '../functions/api/[[path]].js';
import { createAuthEnv } from './helpers/auth-env.mjs';

const PUBLIC_CACHE_CONTROL = 'public, max-age=0, s-maxage=60';
const OLD = '2025-01-01 00:00:00';
const webHeaders = { Origin: 'https://tagsta.sh', 'X-Tagstash-Client': 'web' };
const OTHER_PASSWORD = 'other-user-password';

// A stand-in for Workers' caches.default: keyed on the request URL only (like the real Cache
// API for a keyless GET), refuses what the real put refuses (no positive TTL, no-store,
// private, Vary: *) and, like the real thing, hands back a fresh Response on each match.
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
    if (response.headers.get('Vary') === '*') throw new TypeError('Vary: * is not cacheable');
    this.puts.push({ url: request.url, control, status: response.status });
    this.entries.set(request.url, { status: response.status, headers: [...response.headers], body: await response.text() });
  }
  async delete(request) {
    this.deletes.push(request.url);
    return this.entries.delete(request.url);
  }
}

const withCache = async (fn) => {
  const cache = new FakeCache();
  globalThis.caches = { default: cache };
  try { await fn(cache); } finally { delete globalThis.caches; }
};

const call = (env, path, { method = 'GET', headers = {}, body, waitUntil } = {}) =>
  onRequest({
    env,
    ...(waitUntil ? { waitUntil } : {}),
    request: new Request(`https://tagsta.sh/api/${path}`, {
      method, headers: { 'Content-Type': 'application/json', ...headers },
      ...(body ? { body: JSON.stringify(body) } : {}),
    }),
  });

// Counts D1 round trips so a cache hit can be shown to skip them.
const countQueries = (env) => {
  const state = { count: 0 };
  const prepare = env.DB.prepare.bind(env.DB);
  env.DB.prepare = (sql) => { state.count += 1; return prepare(sql); };
  return state;
};

const insertUser = async (env, username, { isPublic = 1, password } = {}) =>
  Number(env.sqlite.prepare(
    `INSERT INTO users (username, email, password_hash, email_verified, profile_public, created_at)
     VALUES (?, ?, ?, 1, ?, ?)`,
  ).run(username, `${username}@example.com`, password ? await bcrypt.hash(password, 4) : 'x', isPublic, OLD)
    .lastInsertRowid);

// Bookmark with tags, private or public.
const addBookmark = (env, userId, title, tagNames = [], { isPrivate = 0 } = {}) => {
  const id = Number(env.sqlite.prepare(
    `INSERT INTO bookmarks (user_id, title, url, is_private, created_at, updated_at)
     VALUES (?, ?, ?, ?, '2026-03-04 10:00:00', '2026-03-04 10:00:00')`,
  ).run(userId, title, `https://example.com/${userId}/${title}`, isPrivate).lastInsertRowid);
  for (const name of tagNames) {
    env.sqlite.prepare('INSERT OR IGNORE INTO tags (name) VALUES (?)').run(name);
    const tag = env.sqlite.prepare('SELECT id FROM tags WHERE name = ?').get(name);
    env.sqlite.prepare('INSERT INTO bookmark_tags (bookmark_id, tag_id) VALUES (?, ?)').run(id, tag.id);
  }
  return id;
};

const sessionFor = async (env, email, password) => {
  const response = await call(env, 'auth/login', { method: 'POST', headers: webHeaders, body: { email, password } });
  assert.equal(response.status, 200, `login as ${email}`);
  return { ...webHeaders, Cookie: response.headers.get('Set-Cookie').split(';')[0] };
};

// sessiontester (from the helper) is the configured super admin.
const setup = async () => {
  const env = await createAuthEnv();
  env.SUPER_ADMIN_EMAIL = 'session@example.com';
  const alice = await insertUser(env, 'Alice', { password: OTHER_PASSWORD });
  addBookmark(env, alice, 'one', ['poe2', 'guides']);
  addBookmark(env, alice, 'two', ['poe2']);
  addBookmark(env, alice, 'secret', ['hidden'], { isPrivate: 1 });
  return { env, alice };
};

const assertPublicHeaders = (response, label) => {
  assert.equal(response.status, 200, label);
  assert.equal(response.headers.get('Cache-Control'), PUBLIC_CACHE_CONTROL, label);
  assert.equal(response.headers.get('Access-Control-Allow-Origin'), '*', label);
  assert.equal(response.headers.get('Access-Control-Allow-Credentials'), null, label);
  assert.equal(response.headers.get('Vary'), 'Origin', label);
  assert.equal(response.headers.get('X-Content-Type-Options'), 'nosniff', label);
  assert.equal(response.headers.get('Referrer-Policy'), 'no-referrer', label);
  assert.equal(response.headers.get('X-Frame-Options'), 'DENY', label);
  assert.equal(response.headers.get('Content-Security-Policy'), "default-src 'none'; frame-ancestors 'none'", label);
  assert.equal(response.headers.get('Strict-Transport-Security'), 'max-age=63072000; includeSubDomains', label);
  assert.match(response.headers.get('Content-Type'), /application\/json/, label);
  assert.equal(response.headers.get('Set-Cookie'), null, label);
};

test('without a Cache API a successful profile still gets the shared-cache Cache-Control, and nothing else does', async () => {
  const { env } = await setup();
  const realError = console.error;
  try {
    assert.equal(globalThis.caches, undefined);
    const ok = await call(env, 'profiles/alice');
    assertPublicHeaders(ok, 'profile 200');
    assert.equal(ok.headers.get('X-Tagstash-Cache'), null);
    assert.equal((await ok.json()).bookmarks.length, 2);

    for (const [label, path] of [
      ['missing profile', 'profiles/nobody'],
      ['health', 'health'],
      ['other route', 'nope'],
      ['bookmarks (unauthenticated)', 'bookmarks'],
    ]) {
      const response = await call(env, path);
      assert.equal(response.headers.get('Cache-Control'), 'no-store', label);
    }

    // Private and suspended profiles: 404, no-store.
    await insertUser(env, 'hidden', { isPublic: 0 });
    assert.equal((await call(env, 'profiles/hidden')).headers.get('Cache-Control'), 'no-store');
    const suspended = await insertUser(env, 'banned');
    env.sqlite.prepare("UPDATE users SET suspended_at = CURRENT_TIMESTAMP WHERE id = ?").run(suspended);
    const banned = await call(env, 'profiles/banned');
    assert.equal(banned.status, 404);
    assert.equal(banned.headers.get('Cache-Control'), 'no-store');

    // A handler failure is a 500, no-store.
    console.error = () => {};
    const broken = { DB: { prepare: () => ({ bind() { return this; }, async first() { throw new Error('boom'); }, async all() { throw new Error('boom'); } }) } };
    const crashed = await call(broken, 'profiles/alice');
    assert.equal(crashed.status, 500);
    assert.equal(crashed.headers.get('Cache-Control'), 'no-store');

    // Only GET: a POST to the same path never gets the public header.
    const post = await call(env, 'profiles/alice', { method: 'POST', body: {} });
    assert.equal(post.headers.get('Cache-Control'), 'no-store');
  } finally { console.error = realError; env.sqlite.close(); }
});

test('the first request misses and stores, later ones hit without touching D1, with full headers', async () => {
  const { env } = await setup();
  try {
    await withCache(async (cache) => {
      const miss = await call(env, 'profiles/alice');
      assertPublicHeaders(miss, 'miss');
      assert.equal(miss.headers.get('X-Tagstash-Cache'), 'MISS');
      const missBody = await miss.json();
      assert.deepEqual(Object.keys(missBody), ['profile', 'bookmarks', 'tags', 'appliedTags']);
      assert.equal(cache.puts.length, 1);
      assert.equal(cache.puts[0].url, 'https://tagsta.sh/api/profiles/alice');
      assert.equal(cache.puts[0].control, 'public, max-age=60, s-maxage=60');

      const queries = countQueries(env);
      const hit = await call(env, 'profiles/alice', { headers: { Origin: 'https://example.com' } });
      assertPublicHeaders(hit, 'hit');
      assert.equal(hit.headers.get('X-Tagstash-Cache'), 'HIT');
      assert.deepEqual(await hit.json(), missBody);
      assert.equal(queries.count, 0, 'a hit runs no queries');
      assert.equal(cache.puts.length, 1, 'a hit stores nothing');
    });
  } finally { env.sqlite.close(); }
});

test('the cache key ignores identity, Origin, case and unrelated query params, so no variant can leak or poison', async () => {
  const { env, alice } = await setup();
  try {
    await withCache(async (cache) => {
      const sessionHeaders = await sessionFor(env, 'Alice@example.com', OTHER_PASSWORD);
      // The owner, a bearer client, a cross-origin site and a scraper all share one entry.
      const first = await call(env, 'profiles/alice', { headers: { Cookie: sessionHeaders.Cookie } });
      assert.equal(first.headers.get('X-Tagstash-Cache'), 'MISS');
      const body = await first.text();
      assert.ok(!body.includes('secret') && !body.includes('hidden'), 'private bookmark never in the body');

      const variants = [
        ['profiles/alice', { Authorization: 'Bearer whatever' }],
        ['profiles/alice', { Origin: 'https://other.example' }],
        ['profiles/ALICE', {}],
        ['profiles/aLiCe?cachebust=123&utm_source=x', {}],
        ['profiles/alice?foo=bar&tag=', {}],
      ];
      for (const [path, headers] of variants) {
        const response = await call(env, path, { headers });
        assert.equal(response.headers.get('X-Tagstash-Cache'), 'HIT', path);
        assert.equal(await response.text(), body, path);
      }
      assert.equal(cache.puts.length, 1);

      // Web-client requests are still gated before the cache: a hostile origin gets a 403,
      // never the cached profile, and the 403 stays no-store and uncached.
      const hostile = await call(env, 'profiles/alice', { headers: { Origin: 'https://evil.example', 'X-Tagstash-Client': 'web' } });
      assert.equal(hostile.status, 403);
      assert.equal(hostile.headers.get('Cache-Control'), 'no-store');
      assert.equal(cache.puts.length, 1);

      // Owner edits are not visible until expiry/purge: documents the staleness window.
      addBookmark(env, alice, 'three', ['poe2']);
      assert.equal((await (await call(env, 'profiles/alice')).json()).bookmarks.length, 2);
    });
  } finally { env.sqlite.close(); }
});

test('tag filters get their own canonical entries, and the filter is honoured on hits', async () => {
  const { env } = await setup();
  try {
    await withCache(async (cache) => {
      const poe = await (await call(env, 'profiles/alice?tag=POE2')).json();
      assert.equal(poe.bookmarks.length, 2);
      assert.deepEqual(poe.appliedTags, ['poe2']);
      const guides = await (await call(env, 'profiles/alice?tag=guides')).json();
      assert.equal(guides.bookmarks.length, 1);
      const both = await call(env, 'profiles/alice?tag=poe2&tag=guides&tag=poe2');
      assert.deepEqual((await both.json()).appliedTags, ['poe2', 'guides']);
      const reversed = await (await call(env, 'profiles/alice?tag=guides&tag=poe2')).json();
      assert.deepEqual(reversed.appliedTags, ['guides', 'poe2'], 'order is echoed, so order is part of the key');

      // Same canonical filter hits, whatever the casing / duplication / extra params.
      const again = await call(env, 'profiles/alice?x=1&tag=%20POE2%20');
      assert.equal(again.headers.get('X-Tagstash-Cache'), 'HIT');
      assert.deepEqual((await again.json()).bookmarks.length, 2);
      const base = await (await call(env, 'profiles/alice')).json();
      assert.equal(base.bookmarks.length, 2);
      assert.deepEqual(base.appliedTags, []);

      assert.deepEqual([...cache.entries.keys()].sort(), [
        'https://tagsta.sh/api/profiles/alice',
        'https://tagsta.sh/api/profiles/alice?tag=guides',
        'https://tagsta.sh/api/profiles/alice?tag=guides&tag=poe2',
        'https://tagsta.sh/api/profiles/alice?tag=poe2',
        'https://tagsta.sh/api/profiles/alice?tag=poe2&tag=guides',
      ]);
    });
  } finally { env.sqlite.close(); }
});

test('only 200s are stored; 404s, over-long filters and odd paths are served uncached', async () => {
  const { env } = await setup();
  try {
    await withCache(async (cache) => {
      await insertUser(env, 'hidden', { isPublic: 0 });
      for (const name of ['nobody', 'hidden']) {
        const response = await call(env, `profiles/${name}`);
        assert.equal(response.status, 404);
        assert.equal(response.headers.get('Cache-Control'), 'no-store');
        assert.equal(response.headers.get('X-Tagstash-Cache'), null);
      }
      assert.equal((await call(env, 'profiles/%E0%A4%A')).status, 404);
      assert.equal(cache.puts.length, 0);

      const manyTags = Array.from({ length: 11 }, (_, i) => `tag=t${i}`).join('&');
      const many = await call(env, `profiles/alice?${manyTags}`);
      assert.equal(many.status, 200);
      assert.equal(many.headers.get('X-Tagstash-Cache'), null);
      const longTag = await call(env, `profiles/alice?tag=${'x'.repeat(101)}`);
      assert.equal(longTag.status, 200);
      assert.equal(cache.puts.length, 0, 'unbounded filters are never stored');

      const extra = await call(env, 'profiles/alice/extra');
      assert.equal(extra.headers.get('Cache-Control'), 'no-store');
      assert.equal(cache.puts.length, 0);
    });
  } finally { env.sqlite.close(); }
});

test('uses waitUntil for the put when the runtime provides it, and survives cache failures', async () => {
  const { env } = await setup();
  const realError = console.error;
  try {
    await withCache(async (cache) => {
      const pending = [];
      const response = await call(env, 'profiles/alice', { waitUntil: (promise) => pending.push(promise) });
      assert.equal(response.status, 200);
      await Promise.all(pending);
      assert.equal(cache.puts.length, 1);
    });

    console.error = () => {};
    globalThis.caches = { default: {
      async match() { throw new Error('cache down'); },
      async put() { throw new Error('cache down'); },
      async delete() { throw new Error('cache down'); },
    } };
    const degraded = await call(env, 'profiles/alice');
    assert.equal(degraded.status, 200);
    assert.equal((await degraded.json()).bookmarks.length, 2);
  } finally { delete globalThis.caches; console.error = realError; env.sqlite.close(); }
});

const warm = async (env, urls) => {
  for (const url of urls) assert.equal((await call(env, url)).status, 200, url);
};
const WARM = ['profiles/alice', 'profiles/alice?tag=poe2', 'profiles/alice?tag=guides'];
const KEYS = [
  'https://tagsta.sh/api/profiles/alice',
  'https://tagsta.sh/api/profiles/alice?tag=poe2',
  'https://tagsta.sh/api/profiles/alice?tag=guides',
];

test('turning the profile private purges the base and single-tag entries; the public tags only', async () => {
  const { env } = await setup();
  try {
    await withCache(async (cache) => {
      const owner = await sessionFor(env, 'Alice@example.com', OTHER_PASSWORD);
      await warm(env, WARM);
      assert.equal(cache.entries.size, 3);

      // Turning it on again (or a no-op "on") purges nothing.
      const stillOn = await call(env, 'auth/profile-public', { method: 'PUT', headers: owner, body: { profilePublic: true } });
      assert.equal(stillOn.status, 200);
      assert.equal(cache.deletes.length, 0);

      const off = await call(env, 'auth/profile-public', { method: 'PUT', headers: owner, body: { profilePublic: false } });
      assert.equal(off.status, 200);
      assert.deepEqual([...cache.deletes].sort(), [...KEYS].sort(), 'the private bookmark tag "hidden" is not enumerated');
      assert.equal(cache.entries.size, 0);
      for (const url of WARM) assert.equal((await call(env, url)).status, 404, url);
    });
  } finally { env.sqlite.close(); }
});

test('suspend and make-private purge; unsuspend does not need to', async () => {
  for (const action of ['suspend', 'make-private']) {
    const { env, alice } = await setup();
    try {
      await withCache(async (cache) => {
        const admin = await sessionFor(env, 'session@example.com', env.password);
        await warm(env, WARM);
        const response = await call(env, `auth/admin/users/${alice}/${action}`, { method: 'POST', headers: admin });
        assert.equal(response.status, 200, action);
        assert.equal((await response.json()).changed, true, action);
        assert.deepEqual([...cache.deletes].sort(), [...KEYS].sort(), action);
        for (const url of WARM) assert.equal((await call(env, url)).status, 404, `${action} ${url}`);

        // A no-op repeat changes nothing and purges nothing.
        cache.deletes.length = 0;
        const repeat = await call(env, `auth/admin/users/${alice}/${action}`, { method: 'POST', headers: admin });
        assert.equal((await repeat.json()).changed, false, action);
        assert.equal(cache.deletes.length, 0, action);
      });
    } finally { env.sqlite.close(); }
  }
});

test('renaming or deleting an account purges the old profile URL', async () => {
  const { env, alice } = await setup();
  try {
    await withCache(async (cache) => {
      const owner = await sessionFor(env, 'Alice@example.com', OTHER_PASSWORD);
      await warm(env, WARM);
      const rename = await call(env, 'auth/username', { method: 'PUT', headers: owner, body: { newUsername: 'alice2', password: OTHER_PASSWORD } });
      assert.equal(rename.status, 200);
      assert.deepEqual([...cache.deletes].sort(), [...KEYS].sort());
      assert.equal((await call(env, 'profiles/alice')).status, 404);
      assert.equal((await call(env, 'profiles/alice2')).status, 200);

      const admin = await sessionFor(env, 'session@example.com', env.password);
      cache.deletes.length = 0;
      const removed = await call(env, `auth/admin/users/${alice}`, { method: 'DELETE', headers: admin });
      assert.equal(removed.status, 200);
      assert.ok(cache.deletes.includes('https://tagsta.sh/api/profiles/alice2'));
      assert.ok(cache.deletes.includes('https://tagsta.sh/api/profiles/alice2?tag=poe2'), 'tags are collected before the delete removes them');
      assert.equal((await call(env, 'profiles/alice2')).status, 404);
    });
  } finally { env.sqlite.close(); }
});

import test from 'node:test';
import assert from 'node:assert/strict';
import bcrypt from 'bcryptjs';
import { onRequest } from '../functions/api/[[path]].js';
import { onRequestGet as profilePage } from '../functions/u/[username].js';
import { onRequestGet as sitemap } from '../functions/sitemap.xml.js';
import { createAuthEnv } from './helpers/auth-env.mjs';
import { call, loginHeaders } from './helpers/api.mjs';
import { TRASH_RETENTION_DAYS, daysLeftInTrash, describeDaysLeft } from '../src/utils/trash.js';

// Trash with restore (issue #61). Deleting moves a bookmark to the trash (`deleted_at`); it stays
// 30 days, can be restored (blocked when a free account would pass 50 live bookmarks), deleted
// forever, or emptied, and every read treats a trashed bookmark as gone. User 1 is the signed-in
// owner; user 2 ("other") has a public profile and shares the global `tags` table.

const OLD = '2025-01-01 00:00:00';
const WEB = { Origin: 'https://tagsta.sh', 'X-Tagstash-Client': 'web' };
const PASSWORD = 'other-user-password';

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

async function setup(options = {}) {
  const env = await createAuthEnv(options);
  env.sqlite.prepare(`INSERT INTO users (id, username, email, password_hash, email_verified, profile_public, created_at)
    VALUES (2, 'other', 'other@example.com', ?, 1, 1, ?)`).run(bcrypt.hashSync(PASSWORD, 4), OLD);
  return { env, headers: await loginHeaders(env) };
}

const sql = (env, text, ...args) => env.sqlite.prepare(text).all(...args).map((row) => ({ ...row }));
const one = (env, text, ...args) => env.sqlite.prepare(text).get(...args);

// Inserts a bookmark with tags; `deleted` is a SQLite datetime modifier ("-1 days") or null.
const add = (env, userId, n, { tags = [], deleted = null, isPrivate = 0, url } = {}) => {
  const id = Number(env.sqlite.prepare(
    `INSERT INTO bookmarks (user_id, title, url, is_private, created_at, updated_at${deleted ? ', deleted_at' : ''})
     VALUES (?, ?, ?, ?, '2026-03-04 10:00:00', '2026-03-04 10:00:00'${deleted ? ", datetime('now', ?)" : ''})`,
  ).run(userId, `title ${userId}-${n}`, url || `https://example.com/${userId}/${n}`, isPrivate, ...(deleted ? [deleted] : [])).lastInsertRowid);
  for (const name of tags) {
    env.sqlite.prepare('INSERT OR IGNORE INTO tags (name) VALUES (?)').run(name);
    env.sqlite.prepare('INSERT INTO bookmark_tags (bookmark_id, tag_id) SELECT ?, id FROM tags WHERE name = ?').run(id, name);
  }
  return id;
};
const fill = (env, userId, count, prefix = 'f') => Array.from({ length: count }, (_, i) => add(env, userId, `${prefix}${i}`));
const live = (env, userId = 1) => one(env, 'SELECT COUNT(*) AS n FROM bookmarks WHERE user_id = ? AND deleted_at IS NULL', userId).n;
const trashed = (env, userId = 1) => one(env, 'SELECT COUNT(*) AS n FROM bookmarks WHERE user_id = ? AND deleted_at IS NOT NULL', userId).n;
const tagNames = (env) => sql(env, 'SELECT name FROM tags ORDER BY name').map((row) => row.name);
const exists = (env, id) => Boolean(one(env, 'SELECT 1 AS x FROM bookmarks WHERE id = ?', id));

const api = (env, headers, path, method = 'GET', body) => call(env, `bookmarks/${path}`, { method, headers, body });
const list = async (env, headers) => (await (await api(env, headers, '')).json()).bookmarks;
const trashList = async (env, headers) => (await api(env, headers, 'trash')).json();
const bulk = (env, headers, action, ids) => api(env, headers, `bulk/${action}`, 'POST', { ids });

// A request that spends the purge throttle, so rows planted afterwards stay physically present and
// the test sees what the READ paths do, not what the purge removed.
const spendPurgeThrottle = (env, headers) => api(env, headers, 'tags/all');

// ---------------------------------------------------------------------------------------------

test('deleting moves a bookmark to the trash: hidden everywhere, tag links kept, restore brings it back', async () => {
  const { env, headers } = await setup();
  try {
    const id = add(env, 1, 'a', { tags: ['alpha', 'beta'] });
    add(env, 1, 'keep', { tags: ['alpha'] });
    const response = await api(env, headers, String(id), 'DELETE');
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { message: 'Bookmark moved to the trash', trashed: true, retentionDays: TRASH_RETENTION_DAYS });
    assert.ok(exists(env, id), 'the row is kept');
    assert.ok(one(env, 'SELECT deleted_at FROM bookmarks WHERE id = ?', id).deleted_at);
    assert.equal(sql(env, 'SELECT * FROM bookmark_tags WHERE bookmark_id = ?', id).length, 2, 'tag links are kept');
    assert.deepEqual(tagNames(env), ['alpha', 'beta'], 'no orphan cleanup while trashed');

    assert.deepEqual((await list(env, headers)).map((b) => b.title), ['title 1-keep']);
    assert.equal((await api(env, headers, String(id))).status, 404);
    assert.equal((await api(env, headers, String(id), 'PUT', { title: 'x', url: 'https://x.example/' })).status, 404);
    assert.equal((await api(env, headers, `${id}/favorite`, 'POST')).status, 404);
    assert.equal((await api(env, headers, `${id}/private`, 'POST')).status, 404);
    assert.equal((await api(env, headers, String(id), 'DELETE')).status, 404, 'already trashed');

    const inTrash = await trashList(env, headers);
    assert.equal(inTrash.available, true);
    assert.equal(inTrash.retentionDays, 30);
    assert.equal(inTrash.bookmarks.length, 1);
    assert.deepEqual(inTrash.bookmarks[0].tags.map((t) => t.name), ['alpha', 'beta']);
    assert.ok(inTrash.bookmarks[0].deleted_at);
    assert.ok(inTrash.bookmarks[0].expires_at > inTrash.bookmarks[0].deleted_at);

    const restored = await api(env, headers, `${id}/restore`, 'POST');
    assert.equal(restored.status, 200);
    assert.deepEqual((await list(env, headers)).find((b) => b.id === id).tags.map((t) => t.name), ['alpha', 'beta']);
    assert.equal((await trashList(env, headers)).bookmarks.length, 0);
    assert.equal((await api(env, headers, `${id}/restore`, 'POST')).status, 404, 'no longer in the trash');
  } finally { env.sqlite.close(); }
});

test('the retention window is exactly 30 days and one constant, whether or not the purge has run', async () => {
  assert.equal(TRASH_RETENTION_DAYS, 30);
  const { env, headers } = await setup();
  try {
    await spendPurgeThrottle(env, headers);
    const inside = add(env, 1, 'inside', { deleted: '-30 days', tags: ['t'] });
    env.sqlite.prepare("UPDATE bookmarks SET deleted_at = datetime('now', '-30 days', '+5 minutes') WHERE id = ?").run(inside);
    const outside = add(env, 1, 'outside', { tags: ['t'] });
    env.sqlite.prepare("UPDATE bookmarks SET deleted_at = datetime('now', '-30 days', '-5 minutes') WHERE id = ?").run(outside);

    const inTrash = await trashList(env, headers);
    assert.deepEqual(inTrash.bookmarks.map((b) => b.id), [inside]);
    assert.ok(exists(env, outside), 'the expired row has not been purged yet');
    assert.equal(trashed(env), 2);

    // Past 30 days it is gone for every operation, though the row is still there.
    assert.equal((await api(env, headers, `${outside}/restore`, 'POST')).status, 404);
    assert.equal((await api(env, headers, `${outside}/permanent`, 'DELETE')).status, 404);
    const mixed = await (await bulk(env, headers, 'restore', [inside, outside])).json();
    assert.equal(mixed.restored, 1);
    assert.equal(mixed.skipped, 1);
    assert.equal((await bulk(env, headers, 'purge', [outside])).status, 200);
    assert.ok(exists(env, outside));
    assert.deepEqual((await list(env, headers)).map((b) => b.id), [inside]);
  } finally { env.sqlite.close(); }
});

test('days left are rounded up and never negative', () => {
  const deleted = '2026-01-01 00:00:00';
  const at = (ms) => Date.parse('2026-01-01T00:00:00Z') + ms;
  const day = 24 * 60 * 60 * 1000;
  assert.equal(daysLeftInTrash(deleted, at(0)), 30);
  assert.equal(daysLeftInTrash(deleted, at(1000)), 30);
  assert.equal(daysLeftInTrash(deleted, at(day)), 29);
  assert.equal(daysLeftInTrash(deleted, at(29 * day + 1)), 1);
  assert.equal(daysLeftInTrash(deleted, at(30 * day)), 0);
  assert.equal(daysLeftInTrash(deleted, at(40 * day)), 0);
  assert.equal(daysLeftInTrash(null), 0);
  assert.equal(describeDaysLeft(1), '1 day left');
  assert.equal(describeDaysLeft(12), '12 days left');
  assert.match(describeDaysLeft(0), /soon/);
});

test('every read path skips trashed bookmarks: library, by-url, tag cloud, favorites, bulk tags, export', async () => {
  const { env, headers } = await setup();
  try {
    const gone = add(env, 1, 'gone', { tags: ['trashonly', 'shared'], url: 'https://gone.example/page' });
    add(env, 1, 'kept', { tags: ['shared'], url: 'https://kept.example/' });
    const root = add(env, 1, 'root', { url: 'https://root.example/' });
    await api(env, headers, String(gone), 'DELETE');
    await api(env, headers, String(root), 'DELETE');
    env.sqlite.prepare('UPDATE bookmarks SET is_favorite = 1').run();

    const library = await list(env, headers);
    assert.deepEqual(library.map((b) => b.title), ['title 1-kept']);
    assert.ok(library.every((b) => b.tags.every((t) => t.name !== 'trashonly')));

    // Duplicate detection (the extension and the add form): a trashed URL reads as not saved.
    assert.equal((await call(env, `bookmarks/by-url?url=${encodeURIComponent('https://gone.example/page')}`, { headers })).status, 404);
    assert.equal((await call(env, `bookmarks/by-url?url=${encodeURIComponent('https://root.example')}`, { headers })).status, 404);
    assert.equal((await call(env, `bookmarks/by-url?url=${encodeURIComponent('https://kept.example/')}`, { headers })).status, 200);

    // Tag cloud and counts.
    const { tags } = await (await api(env, headers, 'tags/all')).json();
    assert.deepEqual(tags.map((t) => [t.name, t.count]), [['shared', 1]]);

    // Favorites: the tag is not the caller's any more.
    const trashOnly = one(env, "SELECT id FROM tags WHERE name = 'trashonly'").id;
    assert.equal((await api(env, headers, `tags/${trashOnly}/favorite`, 'POST')).status, 404);

    // Bulk tag changes skip trashed ids like foreign ones.
    const result = await (await api(env, headers, 'bulk/tags', 'POST', { ids: [gone], add: ['sneaky'] })).json();
    assert.equal(result.matched, 0);
    assert.equal(result.skipped, 1);
    assert.equal(sql(env, "SELECT * FROM bookmark_tags bt JOIN tags t ON t.id = bt.tag_id WHERE t.name = 'sneaky'").length, 0);
    assert.equal((await api(env, headers, 'bulk/tags', 'POST', { ids: [gone], remove: ['trashonly'] })).status, 200);
    assert.equal(sql(env, 'SELECT * FROM bookmark_tags WHERE bookmark_id = ?', gone).length, 2, 'the trashed bookmark keeps its links');

    // Exports are built client-side from the library response, which has no trashed bookmarks.
    assert.ok(!JSON.stringify(library).includes('gone.example'));
  } finally { env.sqlite.close(); }
});

test('tag merge, rename and delete only see live bookmarks, but carry trashed ones along so restore is consistent', async () => {
  const { env, headers } = await setup();
  try {
    const liveA = add(env, 1, 'a', { tags: ['old', 'target'] });
    const trashedB = add(env, 1, 'b', { tags: ['old'] });
    const onlyTrashed = add(env, 1, 'c', { tags: ['ghost'] });
    await api(env, headers, String(trashedB), 'DELETE');
    await api(env, headers, String(onlyTrashed), 'DELETE');
    const id = (name) => one(env, 'SELECT id FROM tags WHERE name = ?', name).id;

    // A tag used only by trashed bookmarks is not the caller's: 404 for rename, delete and merge.
    assert.equal((await api(env, headers, `tags/${id('ghost')}`, 'PUT', { name: 'spirit' })).status, 404);
    assert.equal((await api(env, headers, `tags/${id('ghost')}`, 'DELETE')).status, 404);
    assert.equal((await api(env, headers, 'tags/merge', 'POST', { sourceTagId: id('ghost'), targetTagId: id('target') })).status, 404);
    assert.equal((await api(env, headers, 'tags/merge', 'POST', { sourceTagId: id('target'), targetTagId: id('ghost') })).status, 404);

    // Rename: the live bookmark and the trashed one both follow.
    const renamed = await api(env, headers, `tags/${id('old')}`, 'PUT', { name: 'new' });
    assert.equal(renamed.status, 200);
    assert.deepEqual(sql(env, `SELECT t.name FROM bookmark_tags bt JOIN tags t ON t.id = bt.tag_id WHERE bt.bookmark_id = ?`, trashedB).map((r) => r.name), ['new']);
    await api(env, headers, `${trashedB}/restore`, 'POST');
    assert.deepEqual((await list(env, headers)).find((b) => b.id === trashedB).tags.map((t) => t.name), ['new']);

    // Delete reports live bookmarks only, and a trashed bookmark does not get the tag back on restore.
    await api(env, headers, String(trashedB), 'DELETE');
    const deleted = await (await api(env, headers, `tags/${id('new')}`, 'DELETE')).json();
    assert.equal(deleted.removedFrom, 1);
    assert.equal(sql(env, 'SELECT * FROM bookmark_tags WHERE bookmark_id = ?', trashedB).length, 0);
    assert.ok(!tagNames(env).includes('new'), 'the orphaned tag row is dropped');
    assert.ok(liveA);
  } finally { env.sqlite.close(); }
});

test('the public profile API, SSR, sitemap and indexing bar never see trashed bookmarks', async () => {
  const { env, headers: ownerHeaders } = await setup();
  try {
    // User 2 is the profile owner: 6 public bookmarks (one more than the bar needs), signed in too.
    const ids = Array.from({ length: 6 }, (_, i) => add(env, 2, i, { tags: ['pub', i === 5 ? 'onlytrash' : 'misc'] }));
    add(env, 2, 'private', { isPrivate: 1, tags: ['secret'] });
    const login = await call(env, 'auth/login', { method: 'POST', headers: WEB, body: { email: 'other@example.com', password: PASSWORD } });
    const headers = { ...WEB, Cookie: login.headers.get('Set-Cookie').split(';')[0] };
    globalThis.HTMLRewriter = FakeRewriter;
    const page = async () => (await profilePage({
      request: new Request('https://tagsta.sh/u/other'), env, params: { username: 'other' },
      next: async () => new Response(shell, { headers: { 'Content-Type': 'text/html' } }),
    })).text();
    const map = async () => (await sitemap({ request: new Request('https://tagsta.sh/sitemap.xml'), env })).text();
    const profile = async (query = '') => (await call(env, `profiles/other${query}`)).json();

    let body = await profile();
    assert.equal(body.bookmarks.length, 6);
    assert.equal(body.profile.indexable, true);
    assert.match(await page(), /ssr-profile/);
    assert.match(await map(), /\/u\/other/);

    // Trash the one that carries the 'onlytrash' tag: API list, tag list, tag filter, SSR, top tags.
    assert.equal((await api(env, headers, String(ids[5]), 'DELETE')).status, 200);
    body = await profile();
    assert.deepEqual(body.bookmarks.map((b) => b.id).sort(), ids.slice(0, 5));
    assert.ok(!body.tags.some((t) => t.name === 'onlytrash'));
    assert.equal(body.tags.find((t) => t.name === 'pub').count, 5);
    assert.equal((await profile('?tag=onlytrash')).bookmarks.length, 0);
    const html = await page();
    assert.ok(!html.includes('title 2-5'), 'no trashed title in the SSR snapshot');
    assert.ok(!html.includes('onlytrash'));
    assert.match(html, /title 2-0/);

    // Five public bookmarks is still the bar; one more in the trash drops the profile below it.
    assert.equal(body.profile.indexable, true);
    assert.equal((await api(env, headers, String(ids[4]), 'DELETE')).status, 200);
    body = await profile();
    assert.equal(body.bookmarks.length, 4);
    assert.equal(body.profile.indexable, false, 'the indexing bar counts live public bookmarks only');
    assert.ok(!(await map()).includes('/u/other'));
    assert.match(await page(), /noindex/);

    // Restoring brings them back to the public surfaces.
    assert.equal((await api(env, headers, `${ids[4]}/restore`, 'POST')).status, 200);
    body = await profile();
    assert.equal(body.bookmarks.length, 5);
    assert.equal(body.profile.indexable, true);
    assert.match(await map(), /\/u\/other/);
  } finally { env.sqlite.close(); }
});

test('the admin user list counts live bookmarks only', async () => {
  const { env } = await setup();
  try {
    env.SUPER_ADMIN_EMAIL = 'session@example.com';
    const headers = await loginHeaders(env);
    add(env, 2, 'a');
    add(env, 2, 'b', { deleted: '-1 days' });
    const { users } = await (await call(env, 'auth/admin/users', { headers })).json();
    const other = users.find((u) => u.username === 'other');
    assert.equal(other.bookmark_count, 1);
    assert.equal(other.public_bookmark_count, 1);
  } finally { env.sqlite.close(); }
});

test('trashed bookmarks do not count toward the free limit; saves and imports use the freed slots', async () => {
  const { env, headers } = await setup();
  try {
    const ids = fill(env, 1, 50);
    const save = (n) => api(env, headers, '', 'POST', { title: `new ${n}`, url: `https://new.example/${n}` });
    assert.equal((await save(1)).status, 403);
    assert.equal((await api(env, headers, String(ids[0]), 'DELETE')).status, 200);
    assert.equal(live(env), 49);
    assert.equal((await save(2)).status, 201);
    assert.equal((await save(3)).status, 403);
    assert.equal(live(env), 50);
    assert.equal(trashed(env), 1);

    await bulk(env, headers, 'delete', ids.slice(1, 4));
    const imported = await (await api(env, headers, 'import', 'POST', {
      bookmarks: Array.from({ length: 6 }, (_, i) => ({ title: `i${i}`, url: `https://import.example/${i}` })),
    })).json();
    assert.equal(imported.imported, 3);
    assert.equal(imported.limitReached, true);
    assert.equal(live(env), 50);
  } finally { env.sqlite.close(); }
});

test('restoring is refused for a free account that would pass 50, enforced in the statement', async () => {
  const { env, headers } = await setup();
  try {
    const live49 = fill(env, 1, 49);
    const t1 = add(env, 1, 't1', { deleted: '-1 days' });
    const t2 = add(env, 1, 't2', { deleted: '-1 days', tags: ['kept-tag'] });

    // One fits (49 + 1), the second does not.
    assert.equal((await api(env, headers, `${t1}/restore`, 'POST')).status, 200);
    const refused = await api(env, headers, `${t2}/restore`, 'POST');
    assert.equal(refused.status, 403);
    const body = await refused.json();
    assert.equal(body.limitReached, true);
    assert.equal(body.restored, 0);
    assert.match(body.error, /free plan's limit of 50 bookmarks/);
    assert.match(body.error, /Upgrade to paid/);
    assert.equal(live(env), 50);
    assert.equal(trashed(env), 1, 'still in the trash, tags intact');
    assert.equal(sql(env, 'SELECT * FROM bookmark_tags WHERE bookmark_id = ?', t2).length, 1);

    // Make room and it restores; paid accounts have no limit.
    assert.equal((await api(env, headers, String(live49[0]), 'DELETE')).status, 200);
    assert.equal((await api(env, headers, `${t2}/restore`, 'POST')).status, 200);
    assert.equal(live(env), 50);
    await api(env, headers, String(live49[1]), 'DELETE');
    await api(env, headers, String(live49[2]), 'DELETE');
    env.sqlite.exec("UPDATE users SET membership_tier = 'paid' WHERE id = 1");
    fill(env, 1, 5, 'extra');
    const over = await bulk(env, headers, 'restore', [live49[1], live49[2]]);
    assert.equal(over.status, 200);
    assert.ok(live(env) > 50);
  } finally { env.sqlite.close(); }
});

test('bulk restore is all or nothing against the limit and says how much room is left', async () => {
  const { env, headers } = await setup();
  try {
    fill(env, 1, 47);
    const trash = Array.from({ length: 5 }, (_, i) => add(env, 1, `t${i}`, { deleted: '-2 days' }));

    // 47 + 5 > 50: nothing is restored, not even the 3 that would fit.
    const refused = await bulk(env, headers, 'restore', trash);
    assert.equal(refused.status, 403);
    const body = await refused.json();
    assert.equal(body.limitReached, true);
    assert.equal(body.restored, 0);
    assert.equal(body.remainingSlots, 3);
    assert.match(body.error, /Restoring 5 bookmarks would go over the free plan's limit of 50 bookmarks, and you have room for 3 more/);
    assert.match(body.error, /Nothing was restored/);
    assert.equal(live(env), 47);
    assert.equal(trashed(env), 5);

    // Exactly the room that is left restores all of them (the guard counts the batch once, not per row).
    const fits = await bulk(env, headers, 'restore', trash.slice(0, 3));
    assert.equal(fits.status, 200);
    assert.deepEqual(await fits.json(), { message: 'Restored 3 bookmarks', requested: 3, restored: 3, skipped: 0 });
    assert.equal(live(env), 50);

    // Ids that are not restorable (live, foreign, missing) are skipped and don't count toward the limit.
    const other = add(env, 2, 'theirs', { deleted: '-1 days' });
    const skipped = await bulk(env, headers, 'restore', [trash[0], other, 99999]);
    assert.equal(skipped.status, 200);
    assert.equal((await skipped.json()).restored, 0);
    assert.equal(one(env, 'SELECT deleted_at FROM bookmarks WHERE id = ?', other).deleted_at !== null, true, 'another account\'s trash is untouched');
  } finally { env.sqlite.close(); }
});

test('restores racing each other and racing saves cannot push a free account past 50', async () => {
  const { env, headers } = await setup({ queryLatency: true });
  try {
    fill(env, 1, 48);
    const trash = Array.from({ length: 6 }, (_, i) => add(env, 1, `t${i}`, { deleted: '-1 days' }));
    const results = await Promise.all(trash.map((id) => api(env, headers, `${id}/restore`, 'POST')));
    assert.deepEqual(results.map((r) => r.status).sort(), [200, 200, 403, 403, 403, 403]);
    assert.equal(live(env), 50);

    // A bulk restore and a save for the last free slot: exactly one wins.
    const { env: env2, headers: headers2 } = await setup({ queryLatency: true });
    try {
      fill(env2, 1, 49);
      const t = add(env2, 1, 't', { deleted: '-1 days' });
      const mixed = await Promise.all([
        bulk(env2, headers2, 'restore', [t]),
        api(env2, headers2, '', 'POST', { title: 'racer', url: 'https://racer.example/' }),
        bulk(env2, headers2, 'restore', [t]),
      ]);
      assert.equal(live(env2), 50);
      // Exactly one of the three did something: a restore that restored it, or the save.
      const outcomes = await Promise.all(mixed.map(async (r) => (r.status === 201 ? 1 : r.status === 200 ? (await r.json()).restored : 0)));
      assert.equal(outcomes.reduce((a, b) => a + b, 0), 1, mixed.map((r) => r.status).join());
    } finally { env2.sqlite.close(); }
  } finally { env.sqlite.close(); }
});

test('saving a URL that is in the trash replaces the trashed copy, and keeps one live bookmark', async () => {
  const { env, headers } = await setup();
  try {
    const old = add(env, 1, 'old', { tags: ['sole', 'common'], url: 'https://dup.example/', deleted: '-3 days' });
    add(env, 1, 'neighbor', { tags: ['common'] });
    const foreign = add(env, 2, 'theirs', { tags: ['sole'], url: 'https://dup.example/', deleted: '-3 days' });
    env.sqlite.prepare("INSERT INTO favorite_tags (user_id, tag_id) SELECT 2, id FROM tags WHERE name = 'common'").run();

    const response = await api(env, headers, '', 'POST', { title: 'Fresh', url: 'https://dup.example', tags: ['sole', 'extra'] });
    assert.equal(response.status, 201);
    const { bookmark } = await response.json();
    assert.ok(!exists(env, old), 'the trashed copy is gone for good');
    assert.equal(trashed(env), 0);
    assert.deepEqual(bookmark.tags.map((t) => t.name), ['sole', 'extra']);
    // The new bookmark got its tags even though "sole" was only on the purged copy.
    assert.deepEqual(sql(env, 'SELECT t.name FROM bookmark_tags bt JOIN tags t ON t.id = bt.tag_id WHERE bt.bookmark_id = ? ORDER BY t.name', bookmark.id).map((r) => r.name), ['extra', 'sole']);
    assert.ok(exists(env, foreign), 'another account\'s trashed copy of the URL is untouched');
    assert.deepEqual((await list(env, headers)).filter((b) => new URL(b.url).hostname === 'dup.example').length, 1);

    // The legacy root form (no trailing slash) is the same URL.
    const legacy = add(env, 1, 'legacy', { url: 'https://legacy.example', deleted: '-1 days' });
    assert.equal((await api(env, headers, '', 'POST', { title: 'L', url: 'https://legacy.example/' })).status, 201);
    assert.ok(!exists(env, legacy));
  } finally { env.sqlite.close(); }
});

test('a save refused at the free limit leaves the trashed copy alone', async () => {
  const { env, headers } = await setup();
  try {
    fill(env, 1, 50);
    const old = add(env, 1, 'old', { url: 'https://refused.example/', deleted: '-1 days', tags: ['keepme'] });
    const response = await api(env, headers, '', 'POST', { title: 'x', url: 'https://refused.example/', tags: ['keepme'] });
    assert.equal(response.status, 403);
    assert.ok(exists(env, old));
    assert.equal(sql(env, 'SELECT * FROM bookmark_tags WHERE bookmark_id = ?', old).length, 1);
  } finally { env.sqlite.close(); }
});

test('importing a URL that is in the trash replaces the trashed copy; refused rows keep theirs', async () => {
  const { env, headers } = await setup();
  try {
    const old = add(env, 1, 'old', { url: 'https://imp.example/a', deleted: '-1 days', tags: ['only-on-old'] });
    const untouched = add(env, 1, 'untouched', { url: 'https://imp.example/untouched', deleted: '-1 days' });
    const result = await (await api(env, headers, 'import', 'POST', {
      bookmarks: [{ title: 'A', url: 'https://imp.example/a', tags: ['only-on-old', 'x'] }, { title: 'B', url: 'https://imp.example/b' }],
    })).json();
    assert.equal(result.imported, 2);
    assert.equal(result.duplicates, 0);
    assert.ok(!exists(env, old));
    assert.ok(exists(env, untouched));
    const a = (await list(env, headers)).find((b) => b.url === 'https://imp.example/a');
    assert.deepEqual(a.tags.map((t) => t.name).sort(), ['only-on-old', 'x']);

    // At the limit the row is refused, so its trashed copy stays.
    const { env: full, headers: fullHeaders } = await setup();
    try {
      fill(full, 1, 50);
      const kept = add(full, 1, 'kept', { url: 'https://imp.example/a', deleted: '-1 days' });
      const refused = await api(full, fullHeaders, 'import', 'POST', { bookmarks: [{ title: 'A', url: 'https://imp.example/a' }] });
      assert.equal(refused.status, 403);
      assert.ok(exists(full, kept));
      // One slot short of the whole file: the admitted row replaces its trashed copy, the refused one doesn't.
      full.sqlite.prepare('DELETE FROM bookmarks WHERE id = (SELECT MIN(id) FROM bookmarks WHERE deleted_at IS NULL)').run();
      const kept2 = add(full, 1, 'kept2', { url: 'https://imp.example/z', deleted: '-1 days' });
      const partial = await (await api(full, fullHeaders, 'import', 'POST', {
        bookmarks: [{ title: 'A', url: 'https://imp.example/a' }, { title: 'Z', url: 'https://imp.example/z' }],
      })).json();
      assert.equal(partial.imported, 1);
      assert.ok(!exists(full, kept), 'the admitted row replaced its trashed copy');
      assert.ok(exists(full, kept2), 'the refused row left its trashed copy alone');
    } finally { full.sqlite.close(); }
  } finally { env.sqlite.close(); }
});

test('delete forever and empty trash remove only the caller\'s trashed bookmarks and orphaned tags', async () => {
  const { env, headers } = await setup();
  try {
    const a = add(env, 1, 'a', { tags: ['solo', 'shared', 'starred'], deleted: '-1 days' });
    const b = add(env, 1, 'b', { tags: ['solo2'], deleted: '-1 days' });
    const liveOne = add(env, 1, 'live', { tags: ['livetag'] });
    const theirs = add(env, 2, 'theirs', { tags: ['shared'], deleted: '-1 days' });
    env.sqlite.prepare("INSERT INTO favorite_tags (user_id, tag_id) SELECT 1, id FROM tags WHERE name = 'starred'").run();

    // Not trashed, not yours, missing: all skipped.
    const skipped = await bulk(env, headers, 'purge', [liveOne, theirs, 99999]);
    assert.equal((await skipped.json()).deleted, 0);
    assert.ok(exists(env, liveOne) && exists(env, theirs));
    assert.equal((await api(env, headers, `${liveOne}/permanent`, 'DELETE')).status, 404);

    const single = await api(env, headers, `${a}/permanent`, 'DELETE');
    assert.equal(single.status, 200);
    assert.ok(!exists(env, a));
    assert.ok(tagNames(env).includes('shared'), 'another account links it');
    assert.ok(tagNames(env).includes('starred'), 'an account favorites it');
    assert.ok(!tagNames(env).includes('solo'));
    assert.ok(tagNames(env).includes('solo2'));

    const emptied = await api(env, headers, 'trash/empty', 'POST');
    assert.equal(emptied.status, 200);
    assert.equal((await emptied.json()).deleted, 1);
    assert.ok(!exists(env, b));
    assert.ok(!tagNames(env).includes('solo2'));
    assert.ok(exists(env, liveOne) && exists(env, theirs));
    assert.deepEqual((await trashList(env, headers)).bookmarks, []);
    assert.equal((await api(env, headers, 'trash/empty', 'POST')).status, 200, 'emptying an empty trash is fine');
  } finally { env.sqlite.close(); }
});

test('expired trash is purged during requests: the owner\'s own, then a bounded, throttled sweep', async () => {
  const { env, headers } = await setup();
  const realNow = Date.now;
  try {
    const mine = add(env, 1, 'mine', { tags: ['expired-only'], deleted: '-31 days' });
    const fresh = add(env, 1, 'fresh', { deleted: '-29 days' });
    for (let i = 0; i < 150; i += 1) add(env, 2, `e${i}`, { deleted: '-40 days' });
    const theirsFresh = add(env, 2, 'fresh', { deleted: '-2 days' });

    await api(env, headers, 'tags/all'); // any bookmark route
    assert.ok(!exists(env, mine), 'the owner\'s own expired item went with their first request');
    assert.ok(!tagNames(env).includes('expired-only'), 'orphaned tag cleaned up with it');
    assert.ok(exists(env, fresh) && exists(env, theirsFresh), 'unexpired items are never purged');
    assert.equal(one(env, 'SELECT COUNT(*) AS n FROM bookmarks WHERE user_id = 2 AND deleted_at < datetime(\'now\', \'-30 days\')').n, 50, 'the global sweep removes at most 100 per run');

    await api(env, headers, 'tags/all');
    assert.equal(one(env, 'SELECT COUNT(*) AS n FROM bookmarks WHERE user_id = 2 AND deleted_at < datetime(\'now\', \'-30 days\')').n, 50, 'throttled: no second sweep right away');

    Date.now = () => realNow() + 11 * 60 * 1000;
    await api(env, headers, 'tags/all');
    assert.equal(one(env, 'SELECT COUNT(*) AS n FROM bookmarks WHERE user_id = 2 AND deleted_at < datetime(\'now\', \'-30 days\')').n, 0);
    assert.ok(exists(env, theirsFresh));
  } finally { Date.now = realNow; env.sqlite.close(); }
});

test('the purge runs after the response when the runtime offers waitUntil', async () => {
  const { env } = await setup();
  try {
    const headers = await loginHeaders(env);
    add(env, 1, 'old', { deleted: '-45 days' });
    const pending = [];
    const response = await call(env, 'bookmarks', { headers, waitUntil: (promise) => pending.push(promise) });
    assert.equal(response.status, 200);
    await Promise.all(pending);
    assert.equal(trashed(env), 0);
  } finally { env.sqlite.close(); }
});

test('account reset and account deletion remove trashed bookmarks too', async () => {
  for (const mode of ['reset', 'delete']) {
    const { env } = await setup();
    try {
      const login = await call(env, 'auth/login', { method: 'POST', headers: WEB, body: { email: 'session@example.com', password: env.password } });
      const headers = { ...WEB, Cookie: login.headers.get('Set-Cookie').split(';')[0] };
      add(env, 1, 'live', { tags: ['mine'] });
      add(env, 1, 'trashed', { tags: ['mine', 'only-trashed'], deleted: '-3 days' });
      add(env, 2, 'theirs', { tags: ['mine'] });
      const response = await call(env, mode === 'reset' ? 'auth/reset-library' : 'auth/delete-account', {
        method: 'POST', headers, body: { password: env.password, confirmation: mode === 'reset' ? 'RESET' : 'DELETE' },
      });
      assert.equal(response.status, 200, mode);
      assert.equal(one(env, 'SELECT COUNT(*) AS n FROM bookmarks WHERE user_id = 1').n, 0, `${mode}: live and trashed are gone`);
      assert.equal(sql(env, 'SELECT * FROM bookmark_tags WHERE bookmark_id NOT IN (SELECT id FROM bookmarks)').length, 0);
      assert.ok(!tagNames(env).includes('only-trashed'));
      assert.ok(tagNames(env).includes('mine'), 'another account still links it');
      assert.equal(one(env, 'SELECT COUNT(*) AS n FROM bookmarks WHERE user_id = 2').n, 1);
    } finally { env.sqlite.close(); }
  }
});

test('trash routes validate input and require authentication', async () => {
  const { env, headers } = await setup();
  try {
    for (const [method, path] of [['GET', 'trash'], ['POST', 'trash/empty'], ['POST', 'bulk/restore'], ['POST', 'bulk/purge'], ['POST', '1/restore'], ['DELETE', '1/permanent']]) {
      assert.equal((await api(env, {}, path, method, method === 'POST' ? { ids: [1] } : undefined)).status, 401, `${method} ${path}`);
    }
    for (const action of ['restore', 'purge']) {
      for (const body of [{}, { ids: [] }, { ids: ['1'] }, { ids: [0] }, { ids: Array(501).fill(1) }, { ids: [1.5] }]) {
        assert.equal((await api(env, headers, `bulk/${action}`, 'POST', body)).status, 400, `${action} ${JSON.stringify(body).slice(0, 30)}`);
      }
    }
    assert.equal((await api(env, headers, 'abc/restore', 'POST')).status, 400);
    assert.equal((await api(env, headers, 'abc/permanent', 'DELETE')).status, 400);
    assert.equal((await api(env, headers, 'trash', 'POST')).status, 404);
    assert.equal((await api(env, headers, 'trash/empty', 'GET')).status, 404);
  } finally { env.sqlite.close(); }
});

test('personal API keys reach the trash routes, and trashed bookmarks stay hidden from key reads', async () => {
  const { env, headers: session } = await setup();
  try {
    const created = await call(env, 'auth/api-keys', { method: 'POST', headers: session, body: { name: 'Script' } });
    assert.equal(created.status, 201);
    const keyHeaders = { Authorization: `Bearer ${(await created.json()).apiKey}` };
    const id = add(env, 1, 'a', { tags: ['t'] });
    add(env, 1, 'b');

    assert.equal((await api(env, keyHeaders, String(id), 'DELETE')).status, 200);
    assert.deepEqual((await list(env, keyHeaders)).map((b) => b.title), ['title 1-b']);
    assert.equal((await api(env, keyHeaders, String(id))).status, 404);
    assert.equal((await call(env, `bookmarks/by-url?url=${encodeURIComponent('https://example.com/1/a')}`, { headers: keyHeaders })).status, 404);
    const inTrash = await trashList(env, keyHeaders);
    assert.deepEqual(inTrash.bookmarks.map((b) => b.id), [id]);
    assert.equal((await api(env, keyHeaders, `${id}/restore`, 'POST')).status, 200);
    assert.equal((await list(env, keyHeaders)).length, 2);
    await api(env, keyHeaders, String(id), 'DELETE');
    assert.equal((await api(env, keyHeaders, 'trash/empty', 'POST')).status, 200);
    assert.equal(exists(env, id), false);
  } finally { env.sqlite.close(); }
});

test('before migration 0019 nothing breaks: deletes stay permanent and trash answers safely', async () => {
  const { env, headers } = await setup();
  try {
    env.sqlite.exec('DROP INDEX idx_bookmarks_user_deleted; DROP INDEX idx_bookmarks_trashed; ALTER TABLE bookmarks DROP COLUMN deleted_at;');
    const a = add(env, 1, 'a', { tags: ['solo'] });
    const b = add(env, 1, 'b');
    const c = add(env, 1, 'c');
    for (let i = 0; i < 5; i += 1) add(env, 2, i, { tags: ['pub'] });

    assert.equal((await list(env, headers)).length, 3);
    const single = await api(env, headers, String(a), 'DELETE');
    assert.equal(single.status, 200);
    assert.deepEqual(await single.json(), { message: 'Bookmark deleted successfully', trashed: false });
    assert.ok(!exists(env, a));
    const bulkResult = await (await bulk(env, headers, 'delete', [b])).json();
    assert.equal(bulkResult.trashed, false);
    assert.equal(bulkResult.deleted, 1);
    assert.ok(!exists(env, b));
    assert.ok(!tagNames(env).includes('solo'), 'permanent delete still cleans orphaned tags in bulk');

    const empty = await trashList(env, headers);
    assert.deepEqual(empty, { bookmarks: [], retentionDays: 30, available: false });
    for (const [path, method, body] of [['trash/empty', 'POST'], [`${c}/restore`, 'POST'], [`${c}/permanent`, 'DELETE'], ['bulk/restore', 'POST', { ids: [c] }], ['bulk/purge', 'POST', { ids: [c] }]]) {
      assert.equal((await api(env, headers, path, method, body)).status, 503, path);
    }
    assert.ok(exists(env, c));

    assert.equal((await api(env, headers, '', 'POST', { title: 's', url: 'https://saved.example/', tags: ['x'] })).status, 201);
    assert.equal((await api(env, headers, 'import', 'POST', { bookmarks: [{ title: 'i', url: 'https://i.example/' }] })).status, 200);
    assert.equal((await api(env, headers, 'tags/all')).status, 200);
    assert.equal((await call(env, 'profiles/other')).status, 200);
    assert.equal((await call(env, 'bookmarks/by-url?url=https://saved.example/', { headers })).status, 200);
    env.SUPER_ADMIN_EMAIL = 'session@example.com';
    assert.equal((await call(env, 'auth/admin/users', { headers })).status, 200);
  } finally { env.sqlite.close(); }
});

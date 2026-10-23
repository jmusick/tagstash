import test from 'node:test';
import assert from 'node:assert/strict';
import bcrypt from 'bcryptjs';
import { createAuthEnv } from './helpers/auth-env.mjs';
import { call, loginHeaders } from './helpers/api.mjs';
import { serializeBookmarks } from '../src/utils/bookmarkExport.js';
import { getOpenableUrls, openUrlsInTabs } from '../src/utils/bulkOpen.js';

// Bulk actions on the owner's library: POST /bookmarks/bulk/delete and /bookmarks/bulk/tags.
// The tags table is global, so user 1 (the requester) and user 2 share rows; every action may only
// change user 1's bookmarks and links, and a tags row goes only once nothing references it.
async function setup(options) {
  const env = await createAuthEnv(options);
  const { sqlite } = env;
  sqlite.prepare(`INSERT INTO users (id, username, email, password_hash, email_verified) VALUES (2, 'other', 'other@example.com', ?, 1)`)
    .run(bcrypt.hashSync('other-password-123', 4));
  const bookmark = (id, userId) => sqlite.prepare('INSERT INTO bookmarks (id, user_id, url, title) VALUES (?, ?, ?, ?)').run(id, userId, `https://e.com/${id}`, `b${id}`);
  const tag = (id, name) => sqlite.prepare('INSERT INTO tags (id, name) VALUES (?, ?)').run(id, name);
  const link = (b, t) => sqlite.prepare('INSERT INTO bookmark_tags (bookmark_id, tag_id) VALUES (?, ?)').run(b, t);

  // User 1: bookmarks 1-4. User 2: bookmarks 5-6.
  [1, 2, 3, 4].forEach((id) => bookmark(id, 1));
  [5, 6].forEach((id) => bookmark(id, 2));
  tag(10, 'shared'); // user 1 on 1, 2; user 2 on 5
  tag(11, 'solo'); // user 1 only, on 1 and 3
  tag(12, 'foreign'); // user 2 only, on 6
  tag(13, 'starred'); // user 1 on 4, and favorited by user 1
  link(1, 10); link(2, 10); link(5, 10);
  link(1, 11); link(3, 11);
  link(6, 12);
  link(4, 13);
  sqlite.prepare('INSERT INTO favorite_tags (user_id, tag_id) VALUES (1, 13)').run();

  return { env, headers: await loginHeaders(env) };
}

const rows = (env, sql, ...args) => env.sqlite.prepare(sql).all(...args);
const bookmarkIds = (env, userId) => rows(env, 'SELECT id FROM bookmarks WHERE user_id = ? ORDER BY id', userId).map((r) => r.id);
const linksOf = (env, userId) =>
  rows(env, `SELECT bt.bookmark_id AS b, t.name FROM bookmark_tags bt JOIN bookmarks bm ON bm.id = bt.bookmark_id
             JOIN tags t ON t.id = bt.tag_id WHERE bm.user_id = ? ORDER BY bt.bookmark_id, t.name`, userId)
  .map((r) => `${r.b}:${r.name}`);
const tagNames = (env) => rows(env, 'SELECT name FROM tags ORDER BY name').map((r) => r.name);
const snapshot = (env) => ({
  bookmarks: rows(env, 'SELECT * FROM bookmarks ORDER BY id'),
  links: rows(env, 'SELECT * FROM bookmark_tags ORDER BY bookmark_id, tag_id'),
  tags: rows(env, 'SELECT * FROM tags ORDER BY id'),
  favorites: rows(env, 'SELECT * FROM favorite_tags ORDER BY user_id, tag_id'),
});

const bulkDelete = (env, headers, body) => call(env, 'bookmarks/bulk/delete', { method: 'POST', headers, body });
const bulkTags = (env, headers, body) => call(env, 'bookmarks/bulk/tags', { method: 'POST', headers, body });

test('bulk routes require authentication', async () => {
  const { env } = await setup();
  try {
    const before = snapshot(env);
    assert.equal((await bulkDelete(env, {}, { ids: [1] })).status, 401);
    assert.equal((await bulkTags(env, {}, { ids: [1], add: ['x'] })).status, 401);
    assert.deepEqual(snapshot(env), before);
  } finally { env.sqlite.close(); }
});

test('bulk delete removes the requested bookmarks and their links, and keeps everything else', async () => {
  const { env, headers } = await setup();
  try {
    const response = await bulkDelete(env, headers, { ids: [1, 3] });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { message: 'Deleted 2 bookmarks', requested: 2, deleted: 2, skipped: 0 });

    assert.deepEqual(bookmarkIds(env, 1), [2, 4]);
    // No link rows point at the deleted bookmarks.
    assert.deepEqual(rows(env, 'SELECT bookmark_id FROM bookmark_tags WHERE bookmark_id IN (1, 3)'), []);
    assert.deepEqual(linksOf(env, 1), ['2:shared', '4:starred']);
    // "solo" was only on the deleted bookmarks, so its global row is gone; "shared" is still used
    // by user 1's bookmark 2 and user 2's bookmark 5, and "foreign" is untouched.
    assert.deepEqual(tagNames(env), ['foreign', 'shared', 'starred']);
    assert.deepEqual(linksOf(env, 2), ['5:shared', '6:foreign']);
  } finally { env.sqlite.close(); }
});

test('bulk delete keeps a global tag row that another user links or anyone favorites', async () => {
  const { env, headers } = await setup();
  try {
    const response = await bulkDelete(env, headers, { ids: [1, 2, 4] });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).deleted, 3);
    // "shared" is still linked by user 2; "starred" lost its only link but user 1 favorites it.
    assert.deepEqual(tagNames(env), ['foreign', 'shared', 'solo', 'starred']);
    assert.deepEqual(rows(env, 'SELECT tag_id FROM favorite_tags WHERE user_id = 1').map((r) => r.tag_id), [13]);
    assert.deepEqual(linksOf(env, 2), ['5:shared', '6:foreign']);
  } finally { env.sqlite.close(); }
});

test('bulk delete skips ids that are not the requester’s and never touches other accounts', async () => {
  const { env, headers } = await setup();
  try {
    const before = snapshot(env);
    const response = await bulkDelete(env, headers, { ids: [5, 6, 999] });
    // Policy: foreign and missing ids are skipped, indistinguishably, and nothing changes.
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.deleted, 0);
    assert.equal(body.skipped, 3);
    assert.deepEqual(snapshot(env), before);

    const mixed = await bulkDelete(env, headers, { ids: [2, 5, 6, 999, 2] });
    assert.equal(mixed.status, 200);
    assert.deepEqual(await mixed.json(), { message: 'Deleted 1 bookmark', requested: 4, deleted: 1, skipped: 3 });
    assert.deepEqual(bookmarkIds(env, 1), [1, 3, 4]);
    assert.deepEqual(bookmarkIds(env, 2), [5, 6]);
    assert.deepEqual(linksOf(env, 2), ['5:shared', '6:foreign']);
  } finally { env.sqlite.close(); }
});

test('bulk delete rejects malformed id lists with 400 and changes nothing', async () => {
  const { env, headers } = await setup();
  try {
    const before = snapshot(env);
    const tooMany = Array.from({ length: 501 }, (_, i) => i + 1);
    for (const body of [
      {}, { ids: null }, { ids: 1 }, { ids: '1,2' }, { ids: [] }, { ids: ['1'] }, { ids: [1.5] }, { ids: [0] }, { ids: [-1] },
      { ids: [null] }, { ids: [1, 'x'] }, { ids: [Number.MAX_SAFE_INTEGER + 2] }, { ids: [{ id: 1 }] }, { ids: tooMany },
      // The cap applies to the raw array, so duplicates cannot smuggle a huge list through.
      { ids: Array(501).fill(1) },
    ]) {
      const response = await bulkDelete(env, headers, body);
      assert.equal(response.status, 400, JSON.stringify(body).slice(0, 80));
      assert.equal(typeof (await response.json()).error, 'string');
    }
    assert.deepEqual(snapshot(env), before);

    // Exactly the cap is accepted (and skips ids that do not exist).
    const atCap = await bulkDelete(env, headers, { ids: Array.from({ length: 500 }, (_, i) => i + 1000) });
    assert.equal(atCap.status, 200);
    assert.equal((await atCap.json()).deleted, 0);
  } finally { env.sqlite.close(); }
});

test('bulk delete is a POST-only JSON route', async () => {
  const { env, headers } = await setup();
  try {
    assert.equal((await call(env, 'bookmarks/bulk/delete', { method: 'GET', headers })).status, 404);
    assert.equal((await call(env, 'bookmarks/bulk/delete', { method: 'DELETE', headers })).status, 404);
    assert.equal((await call(env, 'bookmarks/bulk/delete', { method: 'POST', headers, body: '{"ids":[1]}', contentType: 'text/plain' })).status, 415);
    assert.equal((await call(env, 'bookmarks/bulk/delete', { method: 'POST', headers, body: '{"ids":' })).status, 400);
    assert.equal((await call(env, 'bookmarks/bulk/delete', { method: 'POST', headers, body: '[1,2]' })).status, 400);
    assert.equal((await call(env, 'bookmarks/bulk/other', { method: 'POST', headers, body: { ids: [1] } })).status, 404);
    assert.deepEqual(bookmarkIds(env, 1), [1, 2, 3, 4]);
  } finally { env.sqlite.close(); }
});

test('bulk add tags normalizes names, creates missing tags and links only the requester’s bookmarks', async () => {
  const { env, headers } = await setup();
  try {
    const foreignBefore = linksOf(env, 2);
    const response = await bulkTags(env, headers, { ids: [2, 3, 5], add: [' Reading ', 'shared', 'reading', ''] });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.matched, 2);
    assert.equal(body.skipped, 1);
    assert.equal(body.overLimit, 0);
    // "shared" was already on bookmark 2, so 3 new links: reading x2 and shared on 3.
    assert.equal(body.tagsAdded, 3);

    assert.deepEqual(linksOf(env, 1), ['1:shared', '1:solo', '2:reading', '2:shared', '3:reading', '3:shared', '3:solo', '4:starred']);
    assert.deepEqual(linksOf(env, 2), foreignBefore);
    assert.ok(tagNames(env).includes('reading'));
    assert.ok(!tagNames(env).includes('Reading'));
  } finally { env.sqlite.close(); }
});

test('bulk remove tags unlinks only the requester’s links and drops tags nothing uses', async () => {
  const { env, headers } = await setup();
  try {
    const foreignBefore = linksOf(env, 2);
    const response = await bulkTags(env, headers, { ids: [1, 2, 5], remove: ['SHARED', 'solo', 'missing'] });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.matched, 2);
    assert.equal(body.skipped, 1);
    assert.equal(body.tagsRemoved, 3); // shared on 1 and 2, solo on 1

    assert.deepEqual(linksOf(env, 1), ['3:solo', '4:starred']);
    // User 2's bookmark 5 keeps "shared" (the row stays), and "solo" is still used by bookmark 3.
    assert.deepEqual(linksOf(env, 2), foreignBefore);
    assert.deepEqual(tagNames(env), ['foreign', 'shared', 'solo', 'starred']);

    // Removing the last use drops the global row, but not while it is favorited.
    assert.equal((await bulkTags(env, headers, { ids: [3, 4], remove: ['solo', 'starred'] })).status, 200);
    assert.deepEqual(tagNames(env), ['foreign', 'shared', 'starred']);
  } finally { env.sqlite.close(); }
});

test('one request can add and remove, and only touched bookmarks get a new updated_at', async () => {
  const { env, headers } = await setup();
  try {
    env.sqlite.exec(`UPDATE bookmarks SET updated_at = '2020-01-01 00:00:00'`);
    const response = await bulkTags(env, headers, { ids: [1, 2, 3, 4], add: ['fresh'], remove: ['solo'] });
    assert.equal(response.status, 200);
    assert.deepEqual(linksOf(env, 1), ['1:fresh', '1:shared', '2:fresh', '2:shared', '3:fresh', '4:fresh', '4:starred']);
    const touched = rows(env, `SELECT id FROM bookmarks WHERE updated_at != '2020-01-01 00:00:00' ORDER BY id`).map((r) => r.id);
    assert.deepEqual(touched, [1, 2, 3, 4]);

    // Re-adding a tag everything already has changes nothing, including updated_at.
    env.sqlite.exec(`UPDATE bookmarks SET updated_at = '2020-01-01 00:00:00'`);
    const again = await (await bulkTags(env, headers, { ids: [1, 2, 3, 4], add: ['fresh'] })).json();
    assert.equal(again.tagsAdded, 0);
    assert.equal(rows(env, `SELECT id FROM bookmarks WHERE updated_at != '2020-01-01 00:00:00'`).length, 0);
    // Other users' bookmarks are never touched.
    assert.equal(env.sqlite.prepare('SELECT updated_at FROM bookmarks WHERE id = 5').get().updated_at === '2020-01-01 00:00:00', true);
  } finally { env.sqlite.close(); }
});

test('bulk add never pushes a bookmark past the per-bookmark tag limit', async () => {
  const { env, headers } = await setup();
  try {
    // Give bookmark 1 exactly 49 tags (dropping its two fixture tags first); adding two new
    // ones would make 51.
    env.sqlite.exec('DELETE FROM bookmark_tags WHERE bookmark_id = 1');
    for (let i = 0; i < 49; i++) {
      env.sqlite.prepare('INSERT INTO tags (name) VALUES (?)').run(`t${i}`);
      env.sqlite.prepare('INSERT INTO bookmark_tags (bookmark_id, tag_id) SELECT 1, id FROM tags WHERE name = ?').run(`t${i}`);
    }
    assert.equal(env.sqlite.prepare('SELECT COUNT(*) AS n FROM bookmark_tags WHERE bookmark_id = 1').get().n, 49);

    const response = await bulkTags(env, headers, { ids: [1, 2], add: ['one', 'two'] });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.overLimit, 1);
    assert.equal(body.matched, 2);
    assert.equal(env.sqlite.prepare('SELECT COUNT(*) AS n FROM bookmark_tags WHERE bookmark_id = 1').get().n, 49);
    assert.deepEqual(linksOf(env, 1).filter((l) => l.startsWith('2:')), ['2:one', '2:shared', '2:two']);

    // One new tag still fits.
    const fits = await (await bulkTags(env, headers, { ids: [1], add: ['one'] })).json();
    assert.equal(fits.overLimit, 0);
    assert.equal(env.sqlite.prepare('SELECT COUNT(*) AS n FROM bookmark_tags WHERE bookmark_id = 1').get().n, 50);
  } finally { env.sqlite.close(); }
});

test('bulk tags rejects bad input with 400 and changes nothing', async () => {
  const { env, headers } = await setup();
  try {
    const before = snapshot(env);
    for (const body of [
      { ids: [1] },
      { ids: [1], add: [], remove: [] },
      { ids: [1], add: [' ', ''] },
      { ids: [1], add: 'reading' },
      { ids: [1], add: [5] },
      { ids: [1], remove: { name: 'x' } },
      { ids: [1], add: ['two words'] },
      { ids: [1], add: ['x'.repeat(101)] },
      { ids: [1], add: Array.from({ length: 51 }, (_, i) => `t${i}`) },
      { ids: [1], add: ['same'], remove: ['SAME'] },
      { add: ['reading'] },
      { ids: [], add: ['reading'] },
      { ids: ['1'], add: ['reading'] },
      { ids: Array.from({ length: 501 }, (_, i) => i + 1), add: ['reading'] },
    ]) {
      const response = await bulkTags(env, headers, body);
      assert.equal(response.status, 400, JSON.stringify(body).slice(0, 80));
    }
    assert.deepEqual(snapshot(env), before);
  } finally { env.sqlite.close(); }
});

test('a failing batch leaves the library untouched (each action is atomic)', async () => {
  const { env, headers } = await setup();
  try {
    const before = snapshot(env);
    const realBatch = env.DB.batch.bind(env.DB);
    // Let the first statements run, then fail the batch: the harness rolls the transaction back.
    env.DB.batch = async (statements) => realBatch([...statements, { execute: () => { throw new Error('boom'); } }]);
    const deleted = await bulkDelete(env, headers, { ids: [1, 2, 3] });
    assert.equal(deleted.status, 500);
    const retagged = await bulkTags(env, headers, { ids: [1, 2], add: ['atomic'], remove: ['shared'] });
    assert.equal(retagged.status, 500);
    assert.deepEqual(snapshot(env), before);
  } finally { env.sqlite.close(); }
});

test('concurrent bulk deletes and tag edits settle without errors or orphaned links', async () => {
  const { env, headers } = await setup({ queryLatency: true });
  try {
    const responses = await Promise.all([
      bulkDelete(env, headers, { ids: [1, 2, 3] }),
      bulkTags(env, headers, { ids: [1, 2, 3, 4], add: ['late'] }),
      bulkDelete(env, headers, { ids: [2, 3] }),
    ]);
    for (const response of responses) assert.equal(response.status, 200);
    assert.deepEqual(bookmarkIds(env, 1), [4]);
    assert.deepEqual(rows(env, 'SELECT bookmark_id FROM bookmark_tags WHERE bookmark_id NOT IN (SELECT id FROM bookmarks)'), []);
  } finally { env.sqlite.close(); }
});

test('exporting a selection reuses the library export formats and only includes the selected bookmarks', async () => {
  const { env, headers } = await setup();
  try {
    const { bookmarks } = await (await call(env, 'bookmarks', { headers })).json();
    const selected = new Set([1, 3]);
    const subset = bookmarks.filter((bookmark) => selected.has(bookmark.id));

    const json = JSON.parse(serializeBookmarks(subset, 'json').content);
    assert.deepEqual(json.bookmarks.map((b) => b.title).sort(), ['b1', 'b3']);
    assert.deepEqual(json.bookmarks.find((b) => b.title === 'b1').tags.sort(), ['shared', 'solo']);
    assert.equal(json.version, 1);

    const csv = serializeBookmarks(subset, 'csv').content;
    assert.equal(csv.split('\r\n').length, 3); // header + 2 rows
    assert.ok(!csv.includes('b2') && !csv.includes('b5'));

    const html = serializeBookmarks(subset, 'html').content;
    assert.equal((html.match(/<DT><A /g) || []).length, 2);
  } finally { env.sqlite.close(); }
});

test('bulk open only offers http(s) links and reports blocked tabs', () => {
  const bookmarks = [
    { id: 1, url: 'https://a.example/' },
    { id: 2, url: 'http://b.example/path?q=1' },
    { id: 3, url: 'javascript:alert(1)' },
    { id: 4, url: 'data:text/html,<script>alert(1)</script>' },
    { id: 5, url: 'ftp://files.example/' },
    { id: 6, url: 'not a url' },
    { id: 7, url: ' HTTPS://C.EXAMPLE/ ' },
    { id: 8, url: null },
  ];
  const { urls, skipped } = getOpenableUrls(bookmarks);
  assert.deepEqual(urls, ['https://a.example/', 'http://b.example/path?q=1', 'https://c.example/']);
  assert.equal(skipped, 5);

  const calls = [];
  // A browser that allows the first popup per click and blocks the rest.
  const open = (url, target) => {
    calls.push([url, target]);
    return calls.length === 1 ? { opener: 'x' } : null;
  };
  const result = openUrlsInTabs(urls, open);
  assert.equal(result.opened, 1);
  assert.deepEqual(result.blocked, ['http://b.example/path?q=1', 'https://c.example/']);
  assert.ok(calls.every(([, target]) => target === '_blank'));
});

test('bulk open severs the opener on every window it opens', () => {
  const windows = [];
  const open = () => {
    const win = { opener: 'tagstash' };
    windows.push(win);
    return win;
  };
  const result = openUrlsInTabs(['https://a.example/', 'https://b.example/'], open);
  assert.equal(result.opened, 2);
  assert.deepEqual(result.blocked, []);
  assert.ok(windows.every((win) => win.opener === null));
});

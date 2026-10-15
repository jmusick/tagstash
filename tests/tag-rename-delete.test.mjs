import test from 'node:test';
import assert from 'node:assert/strict';
import bcrypt from 'bcryptjs';
import { createAuthEnv } from './helpers/auth-env.mjs';
import { call, loginHeaders } from './helpers/api.mjs';

// The tags table is global: user 1 (the requester) and user 2 share rows. Every rename/delete
// must change only user 1's bookmark_tags and favorite_tags, and drop a tags row only once
// nothing (no link, no favorite) references it.
async function setup() {
  const env = await createAuthEnv();
  const { sqlite } = env;
  sqlite.prepare(`INSERT INTO users (id, username, email, password_hash, email_verified) VALUES (2, 'other', 'other@example.com', ?, 1)`)
    .run(await bcrypt.hash('other-password-123', 4));
  const bookmark = (id, userId) => sqlite.prepare('INSERT INTO bookmarks (id, user_id, url, title) VALUES (?, ?, ?, ?)').run(id, userId, `https://e.com/${id}`, `b${id}`);
  const tag = (id, name) => sqlite.prepare('INSERT INTO tags (id, name) VALUES (?, ?)').run(id, name);
  const link = (b, t) => sqlite.prepare('INSERT INTO bookmark_tags (bookmark_id, tag_id) VALUES (?, ?)').run(b, t);
  const favorite = (u, t) => sqlite.prepare('INSERT INTO favorite_tags (user_id, tag_id) VALUES (?, ?)').run(u, t);

  // User 1: bookmarks 1-3. User 2: bookmarks 4-5.
  [1, 2, 3].forEach((id) => bookmark(id, 1));
  [4, 5].forEach((id) => bookmark(id, 2));
  tag(10, 'js'); // user 1 on 1, 2; user 2 on 4 (shared)
  tag(11, 'javascript'); // user 1 on 2, 3 (rename-into-existing target)
  tag(12, 'solo'); // user 1 only, on 1
  tag(13, 'foreign'); // user 2 only, on 5
  tag(14, 'stalefav'); // no links; favorited by user 2 only
  link(1, 10); link(2, 10); link(4, 10);
  link(2, 11); link(3, 11);
  link(1, 12);
  link(5, 13);
  favorite(1, 10); favorite(2, 10); favorite(2, 13); favorite(2, 14);

  return { env, headers: await loginHeaders(env) };
}

const rows = (env, sql, ...args) => env.sqlite.prepare(sql).all(...args);
const linksOf = (env, userId) =>
  rows(env, `SELECT bt.bookmark_id AS b, t.name FROM bookmark_tags bt JOIN bookmarks bm ON bm.id = bt.bookmark_id
             JOIN tags t ON t.id = bt.tag_id WHERE bm.user_id = ? ORDER BY bt.bookmark_id, t.name`, userId)
    .map((r) => `${r.b}:${r.name}`);
const favoritesOf = (env, userId) =>
  rows(env, 'SELECT t.name FROM favorite_tags ft JOIN tags t ON t.id = ft.tag_id WHERE ft.user_id = ? ORDER BY t.name', userId)
    .map((r) => r.name);
const tagNames = (env) => rows(env, 'SELECT name FROM tags ORDER BY name').map((r) => r.name);
const tagId = (env, name) => env.sqlite.prepare('SELECT id FROM tags WHERE name = ?').get(name)?.id;

const rename = (env, headers, id, body) => call(env, `bookmarks/tags/${id}`, { method: 'PUT', headers, body });
const remove = (env, headers, id) => call(env, `bookmarks/tags/${id}`, { method: 'DELETE', headers });

const userTwoSnapshot = (env) => ({ links: linksOf(env, 2), favorites: favoritesOf(env, 2) });

test('rename to a new name moves only the requester’s links and favorite; the shared row stays for others', async () => {
  const { env, headers } = await setup();
  try {
    const before = userTwoSnapshot(env);
    const response = await rename(env, headers, 10, { name: '  ECMAScript ' });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.merged, false);
    assert.equal(body.tag.name, 'ecmascript');
    assert.equal(body.tag.id, tagId(env, 'ecmascript'));

    assert.deepEqual(linksOf(env, 1), ['1:ecmascript', '1:solo', '2:ecmascript', '2:javascript', '3:javascript']);
    assert.deepEqual(favoritesOf(env, 1), ['ecmascript']);
    // The global "js" row is still there under its old name for user 2.
    assert.equal(tagId(env, 'js'), 10);
    assert.deepEqual(userTwoSnapshot(env), before);
  } finally { env.sqlite.close(); }
});

test('renaming onto a tag the user already has merges without duplicate links', async () => {
  const { env, headers } = await setup();
  try {
    const before = userTwoSnapshot(env);
    const response = await rename(env, headers, 10, { name: 'javascript' });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.merged, true);
    assert.deepEqual(body.tag, { id: 11, name: 'javascript' });

    // Bookmark 2 had both tags and keeps a single javascript link.
    assert.deepEqual(linksOf(env, 1), ['1:javascript', '1:solo', '2:javascript', '3:javascript']);
    assert.equal(rows(env, 'SELECT COUNT(*) AS n FROM bookmark_tags WHERE bookmark_id = 2 AND tag_id = 11')[0].n, 1);
    assert.deepEqual(favoritesOf(env, 1), ['javascript']);
    assert.equal(tagId(env, 'js'), 10, 'shared row survives');
    assert.deepEqual(userTwoSnapshot(env), before);
  } finally { env.sqlite.close(); }
});

test('renaming onto a name only another user uses reuses that row without touching their data', async () => {
  const { env, headers } = await setup();
  try {
    const before = userTwoSnapshot(env);
    const response = await rename(env, headers, 12, { name: 'foreign' });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.merged, false);
    assert.deepEqual(body.tag, { id: 13, name: 'foreign' });
    assert.deepEqual(linksOf(env, 1), ['1:foreign', '1:js', '2:javascript', '2:js', '3:javascript']);
    assert.equal(tagId(env, 'solo'), undefined, 'orphaned old row is cleaned up');
    assert.deepEqual(userTwoSnapshot(env), before);
  } finally { env.sqlite.close(); }
});

test('rename deletes the old row only when it is orphaned', async () => {
  const { env, headers } = await setup();
  try {
    assert.equal((await rename(env, headers, 12, { name: 'alone' })).status, 200);
    assert.equal(tagId(env, 'solo'), undefined);
    assert.deepEqual(linksOf(env, 1), ['1:alone', '1:js', '2:javascript', '2:js', '3:javascript']);
  } finally { env.sqlite.close(); }
});

test('a legacy mixed-case tag can be renamed to its lowercase form', async () => {
  const { env, headers } = await setup();
  try {
    env.sqlite.prepare("INSERT INTO tags (id, name) VALUES (20, 'Recipes')").run();
    env.sqlite.prepare('INSERT INTO bookmark_tags (bookmark_id, tag_id) VALUES (3, 20)').run();
    const response = await rename(env, headers, 20, { name: 'Recipes' });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).tag.name, 'recipes');
    assert.deepEqual(linksOf(env, 1).filter((l) => l.startsWith('3:')), ['3:javascript', '3:recipes']);
    assert.equal(tagId(env, 'Recipes'), undefined);
  } finally { env.sqlite.close(); }
});

test('delete removes the requester’s links and favorite only; the shared row stays', async () => {
  const { env, headers } = await setup();
  try {
    const before = userTwoSnapshot(env);
    const response = await remove(env, headers, 10);
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.removedFrom, 2);
    assert.deepEqual(body.tag, { id: 10, name: 'js' });

    assert.deepEqual(linksOf(env, 1), ['1:solo', '2:javascript', '3:javascript']);
    assert.deepEqual(favoritesOf(env, 1), []);
    assert.equal(tagId(env, 'js'), 10);
    assert.deepEqual(userTwoSnapshot(env), before);
    // Bookmarks themselves are never deleted.
    assert.equal(rows(env, 'SELECT COUNT(*) AS n FROM bookmarks')[0].n, 5);
  } finally { env.sqlite.close(); }
});

test('delete drops the global row when it becomes orphaned', async () => {
  const { env, headers } = await setup();
  try {
    const response = await remove(env, headers, 12);
    assert.equal(response.status, 200);
    assert.equal((await response.json()).removedFrom, 1);
    assert.equal(tagId(env, 'solo'), undefined);
  } finally { env.sqlite.close(); }
});

test('a row another user still favorites is kept even with no links left', async () => {
  const { env, headers } = await setup();
  try {
    // User 2 favorites "solo" without using it (a stale favorite). Removing the row would cascade into it.
    env.sqlite.prepare('INSERT INTO favorite_tags (user_id, tag_id) VALUES (2, 12)').run();
    assert.equal((await remove(env, headers, 12)).status, 200);
    assert.equal(tagId(env, 'solo'), 12);
    assert.deepEqual(favoritesOf(env, 2), ['foreign', 'js', 'solo', 'stalefav']);
  } finally { env.sqlite.close(); }
});

test('foreign, unused and unknown tags answer 404 without leaking names or writing', async () => {
  const { env, headers } = await setup();
  try {
    const snapshot = () => JSON.stringify([linksOf(env, 1), linksOf(env, 2), favoritesOf(env, 1), favoritesOf(env, 2), tagNames(env)]);
    const before = snapshot();
    for (const id of [13, 14, 999]) {
      for (const response of [await rename(env, headers, id, { name: 'stolen' }), await remove(env, headers, id)]) {
        assert.equal(response.status, 404);
        const text = JSON.stringify(await response.json());
        assert.ok(!text.includes('foreign') && !text.includes('stalefav'), text);
      }
    }
    assert.equal(snapshot(), before);
  } finally { env.sqlite.close(); }
});

test('invalid ids and names answer 400 and write nothing', async () => {
  const { env, headers } = await setup();
  try {
    const before = JSON.stringify([linksOf(env, 1), favoritesOf(env, 1), tagNames(env)]);
    const cases = [
      [10, { name: 'two words' }],
      [10, { name: 'x'.repeat(101) }],
      [10, { name: '   ' }],
      [10, {}],
      [10, { name: 42 }],
      [10, { name: ['js'] }],
      [10, { name: 'JS' }], // same name once lowercased
      ['abc', { name: 'ok' }],
      [0, { name: 'ok' }],
      ['1.5', { name: 'ok' }],
    ];
    for (const [id, body] of cases) {
      const response = await rename(env, headers, id, body);
      assert.equal(response.status, 400, `${id} ${JSON.stringify(body)}`);
      assert.ok((await response.json()).error);
    }
    for (const id of ['abc', 0, -3]) {
      assert.equal((await remove(env, headers, id)).status, 400);
    }
    assert.equal(JSON.stringify([linksOf(env, 1), favoritesOf(env, 1), tagNames(env)]), before);
    // The 100-character limit itself is allowed.
    assert.equal((await rename(env, headers, 12, { name: 'y'.repeat(100) })).status, 200);
  } finally { env.sqlite.close(); }
});

test('rename and delete require authentication', async () => {
  const { env } = await setup();
  try {
    const before = JSON.stringify([linksOf(env, 1), tagNames(env)]);
    assert.equal((await rename(env, {}, 10, { name: 'nope' })).status, 401);
    assert.equal((await remove(env, {}, 10)).status, 401);
    assert.equal(JSON.stringify([linksOf(env, 1), tagNames(env)]), before);
  } finally { env.sqlite.close(); }
});

test('merge still works through the shared helper and keeps other users’ favorites', async () => {
  const { env, headers } = await setup();
  try {
    env.sqlite.prepare('INSERT INTO favorite_tags (user_id, tag_id) VALUES (2, 12)').run();
    const response = await call(env, 'bookmarks/tags/merge', { method: 'POST', headers, body: { sourceTagId: 12, targetTagId: 11 } });
    assert.equal(response.status, 200);
    assert.deepEqual(linksOf(env, 1), ['1:javascript', '1:js', '2:javascript', '2:js', '3:javascript']);
    assert.equal(tagId(env, 'solo'), 12, 'row user 2 still favorites is kept');
    assert.ok(favoritesOf(env, 2).includes('solo'));
  } finally { env.sqlite.close(); }
});

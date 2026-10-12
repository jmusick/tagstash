import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createAuthEnv } from './helpers/auth-env.mjs';
import { call, loginHeaders } from './helpers/api.mjs';
import { INPUT_LIMITS as UI_LIMITS } from '../src/utils/inputLimits.js';

// The server's values, read from its source (they aren't exported) so the tests track it.
const INPUT_LIMITS_SERVER = (() => {
  const source = readFileSync(new URL('../functions/api/[[path]].js', import.meta.url), 'utf8');
  const block = /const INPUT_LIMITS = \{([\s\S]*?)\};/.exec(source)[1];
  return Object.fromEntries([...block.matchAll(/(\w+): (\d+),/g)].map(([, key, value]) => [key, Number(value)]));
})();

async function setup() {
  const env = await createAuthEnv();
  const headers = await loginHeaders(env);
  const { sqlite } = env;
  sqlite.prepare(`INSERT INTO bookmarks (id, user_id, url, title, description) VALUES (5, 1, 'https://before.example/', 'Before', 'old note')`).run();
  sqlite.prepare(`INSERT INTO tags (id, name) VALUES (1, 'alpha'), (2, 'beta')`).run();
  sqlite.prepare('INSERT INTO bookmark_tags (bookmark_id, tag_id) VALUES (5, 1), (5, 2)').run();
  return { env, headers };
}

const snapshot = (env) => ({
  row: env.sqlite.prepare('SELECT title, url, description, updated_at FROM bookmarks WHERE id = 5').get(),
  tags: env.sqlite.prepare('SELECT t.name FROM bookmark_tags bt JOIN tags t ON t.id = bt.tag_id WHERE bt.bookmark_id = 5 ORDER BY t.name').all().map((r) => r.name),
  bookmarks: env.sqlite.prepare('SELECT COUNT(*) AS n FROM bookmarks').get().n,
});

const valid = { title: 'After', url: 'https://after.example/', description: 'new note', tags: ['gamma'] };

test('a malformed update returns 400 and leaves the record and its tags unchanged (S07)', async () => {
  const { env, headers } = await setup();
  try {
    const before = snapshot(env);
    assert.deepEqual(before.tags, ['alpha', 'beta']);
    for (const patch of [
      { tags: [42] },
      { tags: ['ok', 'two words'] },
      { tags: 'alpha,beta' },
      { tags: ['x'.repeat(INPUT_LIMITS_SERVER.tagName + 1)] },
      { tags: Array.from({ length: INPUT_LIMITS_SERVER.tagsPerBookmark + 1 }, (_, i) => `t${i}`) },
      { title: 'x'.repeat(INPUT_LIMITS_SERVER.title + 1) },
      { title: 42 },
      { title: '   ' },
      { url: `https://e.com/${'x'.repeat(INPUT_LIMITS_SERVER.url)}` },
      { url: 'javascript:alert(1)' },
      { url: ['https://e.com/'] },
      { description: 'x'.repeat(INPUT_LIMITS_SERVER.description + 1) },
      { description: { text: 'nope' } },
    ]) {
      const response = await call(env, 'bookmarks/5', { method: 'PUT', headers, body: { ...valid, ...patch } });
      assert.equal(response.status, 400, JSON.stringify(patch).slice(0, 80));
      assert.ok((await response.json()).error);
      assert.deepEqual(snapshot(env), before);
    }
  } finally { env.sqlite.close(); }
});

test('a valid update replaces row and tags together; omitting tags keeps them, null clears them', async () => {
  const { env, headers } = await setup();
  try {
    let response = await call(env, 'bookmarks/5', { method: 'PUT', headers, body: { ...valid, tags: ['Gamma', 'alpha', 'gamma', ''] } });
    assert.equal(response.status, 200);
    const { bookmark } = await response.json();
    assert.equal(bookmark.title, 'After');
    assert.deepEqual(bookmark.tags.map((t) => t.name), ['gamma', 'alpha']);
    assert.deepEqual(snapshot(env).tags, ['alpha', 'gamma']);

    const { tags: _omitted, ...withoutTags } = valid;
    response = await call(env, 'bookmarks/5', { method: 'PUT', headers, body: withoutTags });
    assert.equal(response.status, 200);
    assert.deepEqual(snapshot(env).tags, ['alpha', 'gamma']);

    response = await call(env, 'bookmarks/5', { method: 'PUT', headers, body: { ...valid, tags: null } });
    assert.equal(response.status, 200);
    assert.deepEqual(snapshot(env).tags, []);
  } finally { env.sqlite.close(); }
});

test('if the tag write fails, the title change rolls back with it (one D1 batch)', async () => {
  const { env, headers } = await setup();
  const realPrepare = env.DB.prepare.bind(env.DB);
  env.DB.prepare = (sql) => {
    const statement = realPrepare(sql);
    if (sql.includes('INSERT OR IGNORE INTO bookmark_tags')) {
      // The helper's batch calls execute(); standalone queries call run().
      statement.execute = () => { throw new Error('simulated D1 failure'); };
      statement.run = async () => statement.execute();
    }
    return statement;
  };
  const realError = console.error;
  console.error = () => {};
  try {
    const before = snapshot(env);
    const response = await call(env, 'bookmarks/5', { method: 'PUT', headers, body: valid });
    assert.equal(response.status, 500);
    assert.deepEqual(snapshot(env), before);

    const created = await call(env, 'bookmarks', { method: 'POST', headers, body: { ...valid, url: 'https://new.example/' } });
    assert.equal(created.status, 500);
    assert.equal(snapshot(env).bookmarks, before.bookmarks);
  } finally { console.error = realError; env.sqlite.close(); }
});

test('create validates everything before writing and links tags atomically', async () => {
  const { env, headers } = await setup();
  try {
    const before = snapshot(env);
    for (const body of [
      { ...valid, tags: [42] },
      { ...valid, title: 'x'.repeat(INPUT_LIMITS_SERVER.title + 1) },
      { ...valid, description: 7 },
      { ...valid, tags: { 0: 'a' } },
    ]) {
      const response = await call(env, 'bookmarks', { method: 'POST', headers, body });
      assert.equal(response.status, 400);
    }
    assert.equal(snapshot(env).bookmarks, before.bookmarks);
    assert.equal(env.sqlite.prepare("SELECT COUNT(*) AS n FROM tags WHERE name = 'gamma'").get().n, 0);

    const response = await call(env, 'bookmarks', { method: 'POST', headers, body: { ...valid, title: '  Padded  ', tags: ['zeta', 'alpha'] } });
    assert.equal(response.status, 201);
    const { bookmark } = await response.json();
    assert.equal(bookmark.title, 'Padded');
    assert.deepEqual(bookmark.tags.map((t) => t.name), ['zeta', 'alpha']);
    const linked = env.sqlite.prepare('SELECT t.name FROM bookmark_tags bt JOIN tags t ON t.id = bt.tag_id WHERE bt.bookmark_id = ? ORDER BY t.name').all(bookmark.id).map((r) => r.name);
    assert.deepEqual(linked, ['alpha', 'zeta']);
    // The shared global tag row is reused, not duplicated.
    assert.equal(env.sqlite.prepare("SELECT COUNT(*) AS n FROM tags WHERE name = 'alpha'").get().n, 1);
  } finally { env.sqlite.close(); }
});

test('request bodies: oversized → 413 (declared or streamed), wrong type → 415, bad JSON → 400', async () => {
  const { env, headers } = await setup();
  try {
    const before = snapshot(env);
    const huge = JSON.stringify({ ...valid, description: 'x'.repeat(300 * 1024) });
    let response = await call(env, 'bookmarks/5', { method: 'PUT', headers, body: huge });
    assert.equal(response.status, 413);
    // A declared length over the cap is refused before any of the body is read.
    let touched = false;
    const lazy = new ReadableStream({ pull() { touched = true; } }, { highWaterMark: 0 });
    response = await call(env, 'bookmarks/5', { method: 'PUT', headers: { ...headers, 'Content-Length': String(10 * 1024 * 1024) }, body: lazy });
    assert.equal(response.status, 413);
    assert.equal(touched, false);

    // No Content-Length: the stream is cut off once it passes the cap.
    let pulled = 0;
    const endless = new ReadableStream({
      pull(controller) { pulled += 1; controller.enqueue(new TextEncoder().encode('x'.repeat(64 * 1024))); },
    });
    response = await call(env, 'bookmarks/5', { method: 'PUT', headers, body: endless });
    assert.equal(response.status, 413);
    assert.ok(pulled <= 6, `read ${pulled} chunks`);

    response = await call(env, 'bookmarks/5', { method: 'PUT', headers, body: JSON.stringify(valid), contentType: 'text/plain' });
    assert.equal(response.status, 415);
    response = await call(env, 'bookmarks/5', { method: 'PUT', headers, body: '{"title": ' });
    assert.equal(response.status, 400);
    response = await call(env, 'bookmarks/5', { method: 'PUT', headers, body: '[1,2]' });
    assert.equal(response.status, 400);
    response = await call(env, 'bookmarks/5', { method: 'PUT', headers, body: 'null' });
    assert.equal(response.status, 400);
    assert.deepEqual(snapshot(env), before);

    // The 413 path is a controlled JSON response, never the generic 500.
    response = await call(env, 'auth/login', { method: 'POST', body: JSON.stringify({ email: 'a@b.co', password: 'x'.repeat(300 * 1024) }) });
    assert.equal(response.status, 413);
    assert.match((await response.json()).error, /too large/);
  } finally { env.sqlite.close(); }
});

test('auth routes type-check and bound their fields', async () => {
  const { env, headers } = await setup();
  try {
    const cases = [
      ['auth/password', 'PUT', { currentPassword: env.password, newPassword: 123456789, confirmPassword: 123456789 }],
      ['auth/password', 'PUT', { currentPassword: ['x'], newPassword: 'abcdefgh', confirmPassword: 'abcdefgh' }],
      ['auth/password', 'PUT', { currentPassword: env.password, newPassword: 'x'.repeat(257), confirmPassword: 'x'.repeat(257) }],
      ['auth/username', 'PUT', { newUsername: 'renamed', password: { toString: 1 } }],
      ['auth/email', 'PUT', { newEmail: 'new@example.com', password: 42 }],
      ['auth/email', 'PUT', { newEmail: 'not-an-email', password: env.password }],
      ['auth/profile-public', 'PUT', { profilePublic: 'false' }],
      ['auth/api-keys', 'POST', { name: 42 }],
      ['auth/reset-password', 'POST', { token: { a: 1 }, password: 'abcdefgh' }],
      ['auth/reset-password', 'POST', { token: 'abc', password: 'x'.repeat(257) }],
    ];
    for (const [path, method, body] of cases) {
      const response = await call(env, path, { method, headers, body });
      assert.equal(response.status, 400, `${method} ${path} ${JSON.stringify(body).slice(0, 60)}`);
    }
    for (const body of [
      { username: 'newbie', email: 'not-an-email', password: 'abcdefgh' },
      { username: 'newbie', email: `${'a'.repeat(250)}@example.com`, password: 'abcdefgh' },
      { username: 'newbie', email: 'newbie@example.com', password: 'x'.repeat(257) },
    ]) {
      assert.equal((await call(env, 'auth/register', { method: 'POST', body })).status, 400);
    }
    // None of the rejected requests changed the account.
    const user = env.sqlite.prepare('SELECT username, email, failed_attempts FROM users WHERE id = 1').get();
    assert.deepEqual({ ...user }, { username: 'sessiontester', email: 'session@example.com', failed_attempts: 0 });
    assert.equal(env.sqlite.prepare('SELECT COUNT(*) AS n FROM users').get().n, 1);
  } finally { env.sqlite.close(); }
});

test('the UI limits mirror the server limits', () => {
  for (const [name, value] of Object.entries(UI_LIMITS)) {
    assert.equal(INPUT_LIMITS_SERVER[name], value, `${name} differs between server and UI`);
  }
});

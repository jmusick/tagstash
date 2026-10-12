import test from 'node:test';
import assert from 'node:assert/strict';
import { onRequest } from '../functions/api/[[path]].js';
import { createAuthEnv } from './helpers/auth-env.mjs';

const call = (env, path, { method = 'GET', headers = {}, body } = {}) =>
  onRequest({ env, request: new Request(`https://tagsta.sh/api/${path}`, {
    method, headers: { 'Content-Type': 'application/json', ...headers },
    ...(body ? { body: JSON.stringify(body) } : {}),
  }) });
const bearer = async (env) => {
  const { token } = await (await call(env, 'auth/login', { method: 'POST', body: { email: 'session@example.com', password: env.password } })).json();
  return { Authorization: `Bearer ${token}` };
};
const seedBookmarks = (env, count) => {
  const insert = env.sqlite.prepare('INSERT INTO bookmarks (user_id, title, url) VALUES (1, ?, ?)');
  for (let i = 0; i < count; i += 1) insert.run(`Seed ${i}`, `https://seed.example/${i}`);
};
const bookmarkCount = (env) => env.sqlite.prepare('SELECT COUNT(*) AS n FROM bookmarks WHERE user_id = 1').get().n;
const save = (env, headers, n) => call(env, 'bookmarks', {
  method: 'POST', headers, body: { title: `Parallel ${n}`, url: `https://parallel.example/${n}`, tags: ['race'] },
});

test('parallel saves at 49 bookmarks cannot push a free account past 50', async () => {
  const env = await createAuthEnv({ queryLatency: true });
  try {
    const headers = await bearer(env);
    seedBookmarks(env, 49);
    const results = await Promise.all(Array.from({ length: 8 }, (_, n) => save(env, headers, n)));
    const statuses = results.map((r) => r.status).sort();
    assert.deepEqual(statuses, [201, 403, 403, 403, 403, 403, 403, 403]);
    for (const response of results.filter((r) => r.status === 403)) {
      assert.match((await response.json()).error, /Free users can save up to 50 bookmarks/);
    }
    assert.equal(bookmarkCount(env), 50);
    // A refused save leaves no stray tag links behind.
    assert.equal(env.sqlite.prepare('SELECT COUNT(*) AS n FROM bookmark_tags').get().n, 1);
  } finally { env.sqlite.close(); }
});

test('the free limit still allows saves below 50 and refuses at 50; paid accounts are unlimited', async () => {
  const env = await createAuthEnv({ queryLatency: true });
  try {
    const headers = await bearer(env);
    seedBookmarks(env, 48);
    assert.equal((await save(env, headers, 'a')).status, 201);
    assert.equal((await save(env, headers, 'b')).status, 201);
    assert.equal(bookmarkCount(env), 50);
    assert.equal((await save(env, headers, 'c')).status, 403);
    assert.equal(bookmarkCount(env), 50);

    env.sqlite.exec("UPDATE users SET membership_tier = 'paid'");
    const results = await Promise.all(Array.from({ length: 5 }, (_, n) => save(env, headers, `paid-${n}`)));
    assert.ok(results.every((r) => r.status === 201));
    assert.equal(bookmarkCount(env), 55);
  } finally { env.sqlite.close(); }
});

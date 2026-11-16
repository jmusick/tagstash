import test from 'node:test';
import assert from 'node:assert/strict';
import { createAuthEnv } from './helpers/auth-env.mjs';
import { call, loginHeaders } from './helpers/api.mjs';
import { TAG_RECOMMENDATION_LIMITS } from '../functions/_lib/tagRecommendations.js';
import { createHash } from 'node:crypto';

const path = 'bookmarks/suggest-tags';
const body = { url: 'https://example.test/react', title: 'React performance' };
async function setup(t) {
  const env = await createAuthEnv();
  t.after(() => env.sqlite.close());
  env.sqlite.exec("UPDATE users SET membership_tier = 'paid'");
  env.TAG_RECOMMENDATIONS_ENABLED = 'true';
  env.AI = { run: async () => ({ response: { suggestions: ['React', 'shared', 'foreign', 'trashed'] } }) };
  const headers = await loginHeaders(env);
  env.sqlite.exec(`
    INSERT INTO users (id, username, email, password_hash, email_verified, membership_tier)
      SELECT 2, 'other', 'other@example.test', password_hash, 1, 'paid' FROM users WHERE id = 1;
    INSERT INTO bookmarks (id, user_id, title, url, is_private, deleted_at) VALUES
      (1, 1, 'Private', 'https://example.test/private', 1, NULL),
      (2, 1, 'Public', 'https://example.test/public', 0, NULL),
      (3, 2, 'Foreign', 'https://example.test/foreign', 0, NULL),
      (4, 1, 'Expired trash', 'https://example.test/trash', 0, '2000-01-01');
    INSERT INTO tags (id, name) VALUES (1, 'React'), (2, 'shared'), (3, 'foreign'), (4, 'trashed');
    INSERT INTO bookmark_tags (bookmark_id, tag_id) VALUES (1, 1), (1, 2), (2, 2), (3, 2), (3, 3), (4, 4);
  `);
  return { env, headers, request: (value = body, h = headers) => call(env, path, { method: 'POST', headers: h, body: value }) };
}
const assertHeaders = response => {
  assert.equal(response.headers.get('Cache-Control'), 'no-store');
  assert.equal(response.headers.get('X-Content-Type-Options'), 'nosniff');
  assert.equal(response.headers.get('X-Frame-Options'), 'DENY');
  assert.match(response.headers.get('Content-Security-Policy'), /default-src 'none'/);
};

test('Pro entitlement uses the current account tier for cookies, sessions and keys', async t => {
  const { env, request, headers } = await setup(t);
  const key = `tsk_${'b1'.repeat(24)}`;
  env.sqlite.prepare("INSERT INTO api_keys (user_id, name, key_hash, key_prefix, key_last4) VALUES (1, ?, ?, 'tsk_b1b1', 'b1b1')")
    .run('Entitlement check', createHash('sha256').update(key).digest('hex'));
  const web = { 'X-Tagstash-Client': 'web', Origin: 'https://tagsta.sh' };
  const login = await call(env, 'auth/login', { method: 'POST', headers: web,
    body: { email: 'session@example.com', password: env.password } });
  const Cookie = login.headers.get('Set-Cookie').split(';')[0];
  const credentials = [headers, { ...web, Cookie }, { Authorization: `Bearer ${key}` }];
  for (const h of credentials) assert.equal((await request(body, h)).status, 200);
  env.sqlite.exec("UPDATE users SET membership_tier = 'free' WHERE id = 1; DELETE FROM auth_events WHERE event_type = 'tag_suggestion'");
  env.AI.run = () => assert.fail('Free accounts must not reach inference');
  const prepare = env.DB.prepare;
  env.DB.prepare = sql => {
    assert.doesNotMatch(sql, /(?:FROM|JOIN) (?:bookmarks|tags)\b|table_info\(bookmarks\)/i);
    return prepare(sql);
  };
  for (const h of credentials) {
    const response = await request(body, h);
    assert.equal(response.status, 403);
    assert.equal((await response.json()).upgradeRequired, true);
    assertHeaders(response);
  }
  assert.equal(env.sqlite.prepare("SELECT COUNT(*) AS n FROM auth_events WHERE event_type = 'tag_suggestion'").get().n, 0);
});

test('owner-only candidates include private tags, preserve names, and never mutate library rows', async t => {
  const { env, request } = await setup(t);
  const snapshot = () => ['bookmarks', 'tags', 'bookmark_tags', 'favorite_tags'].map(table =>
    env.sqlite.prepare(`SELECT * FROM ${table} ORDER BY 1, 2`).all());
  const before = snapshot();
  env.AI.run = async (_model, parameters) => {
    const input = JSON.parse(parameters.messages[1].content);
    assert.deepEqual(input.candidates, ['shared', 'React']);
    assert.deepEqual(Object.keys(input).sort(), ['candidates', 'description', 'title', 'url']);
    return { response: { suggestions: ['foreign', 'React', 'React', 'shared', 'trashed', 'react'] } };
  };
  const response = await request();
  assert.equal(response.status, 200);
  assertHeaders(response);
  assert.deepEqual(await response.json(), { suggestions: ['React', 'shared'] });
  assert.deepEqual(snapshot(), before, 'even expired trash must remain unchanged');
  env.AI.run = async (_model, p) => {
    assert.deepEqual(JSON.parse(p.messages[1].content).candidates, ['React']);
    return { response: { suggestions: ['shared', 'React'] } };
  };
  assert.deepEqual(await (await request({ ...body, selectedTags: ['SHARED'] })).json(), { suggestions: ['React'] });
  const otherLogin = await call(env, 'auth/login', { method: 'POST',
    body: { email: 'other@example.test', password: env.password } });
  const { token } = await otherLogin.json();
  env.AI.run = async (_model, p) => {
    assert.deepEqual(JSON.parse(p.messages[1].content).candidates, ['foreign', 'shared']);
    return { response: { suggestions: ['React', 'shared', 'foreign'] } };
  };
  assert.deepEqual(await (await request(body, { Authorization: `Bearer ${token}` })).json(), { suggestions: ['shared', 'foreign'] });
});

test('cookie sessions, bearer sessions and origin enforcement retain existing auth', async t => {
  const { env, request } = await setup(t);
  assert.equal((await request(body, {})).status, 401);
  assert.equal((await request(body, { Authorization: 'Bearer invalid' })).status, 403);
  const web = { 'X-Tagstash-Client': 'web', Origin: 'https://tagsta.sh' };
  const login = await call(env, 'auth/login', { method: 'POST', headers: web,
    body: { email: 'session@example.com', password: env.password } });
  const Cookie = login.headers.get('Set-Cookie').split(';')[0];
  assert.equal((await request(body, { ...web, Cookie })).status, 200);
  const refused = await request(body, { ...web, Cookie, Origin: 'https://evil.test' });
  assert.equal(refused.status, 403);
  assertHeaders(refused);
  assert.equal(refused.headers.get('Access-Control-Allow-Origin'), null);
});

test('entire payload is validated before library queries or inference', async t => {
  const { env, request, headers } = await setup(t);
  const prepare = env.DB.prepare;
  env.DB.prepare = sql => {
    assert.doesNotMatch(sql, /(?:FROM|JOIN) (?:bookmarks|tags)\b|table_info\(bookmarks\)/i);
    return prepare(sql);
  };
  env.AI.run = () => assert.fail('Invalid input reached AI');
  for (const value of [null, [], {}, { url: 12 }, { url: 'file:///secret' }, { url: '' },
    { ...body, url: 'https://x.test/' + 'x'.repeat(8192) },
    { ...body, title: null }, { ...body, title: 'x'.repeat(1001) },
    { ...body, description: 7 }, { ...body, description: 'x'.repeat(10001) },
    { ...body, selectedTags: null }, { ...body, selectedTags: [2] },
    { ...body, selectedTags: ['two words'] }, { ...body, selectedTags: [''] },
    { ...body, selectedTags: ['x'.repeat(101)] }, { ...body, selectedTags: Array(51).fill('react') },
    { ...body, note: 'Do not send notes' },
  ]) {
    const response = await request(value);
    assert.equal(response.status, 400, JSON.stringify(value));
    assertHeaders(response);
  }
  assert.equal((await request('x'.repeat(256 * 1024 + 1))).status, 413);
  assert.equal((await call(env, path, { method: 'POST', headers, body, contentType: 'text/plain' })).status, 415);
  assert.equal(env.sqlite.prepare("SELECT COUNT(*) AS n FROM auth_events WHERE event_type = 'tag_suggestion'").get().n, 0);
});

test('escaped prompt byte cap returns 400 before inference', async t => {
  const { env, request } = await setup(t);
  env.sqlite.exec('DELETE FROM bookmark_tags');
  for (let i = 0; i < 100; i++) {
    const { lastInsertRowid } = env.sqlite.prepare('INSERT INTO tags (name) VALUES (?)').run('界'.repeat(95) + i);
    env.sqlite.prepare('INSERT INTO bookmark_tags (bookmark_id, tag_id) VALUES (1, ?)').run(lastInsertRowid);
  }
  env.AI.run = () => assert.fail('Oversized prompt reached AI');
  const response = await request({ url: 'https://example.test/' + '\u0000'.repeat(2048),
    title: '\u0000'.repeat(512), description: '\u0000'.repeat(2000) });
  assert.equal(response.status, 400);
  assertHeaders(response);
});

test('candidate queries work before the trash migration without mutating anything', async t => {
  const { env, request } = await setup(t);
  env.sqlite.exec('DROP INDEX idx_bookmarks_user_deleted; DROP INDEX idx_bookmarks_trashed; ALTER TABLE bookmarks DROP COLUMN deleted_at');
  const response = await request();
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { suggestions: ['React', 'shared', 'trashed'] });
});

test('no eligible candidates succeeds without inference; disabled or missing binding returns 503', async t => {
  const { env, request } = await setup(t);
  env.AI.run = () => assert.fail('No candidates must skip AI');
  assert.deepEqual(await (await request({ ...body, selectedTags: ['react', 'shared'] })).json(), { suggestions: [] });
  env.sqlite.exec('DELETE FROM bookmark_tags WHERE bookmark_id IN (1, 2)');
  assert.deepEqual(await (await request()).json(), { suggestions: [] });
  env.TAG_RECOMMENDATIONS_ENABLED = 'false';
  let response = await request();
  assert.equal(response.status, 503);
  assertHeaders(response);
  env.TAG_RECOMMENDATIONS_ENABLED = 'true';
  delete env.AI;
  response = await request();
  assert.equal(response.status, 503);
});

test('provider failures, malformed outputs and timeouts have sanitized responses', async t => {
  const { env, request } = await setup(t);
  for (const run of [() => { throw new Error('SECRET PROMPT'); },
    async () => ({ response: { suggestions: [3] } }),
    async () => ({ response: { suggestions: [], extra: 'SECRET PROMPT' } }),
    async () => ({ response: 'SECRET PROMPT' }),
  ]) {
    env.AI.run = run;
    const response = await request();
    assert.equal(response.status, 502);
    assertHeaders(response);
    assert.doesNotMatch(await response.text(), /SECRET PROMPT/);
  }
  let started;
  const ready = new Promise(resolve => { started = resolve; });
  env.AI.run = () => { started(); return new Promise(() => {}); };
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const pending = request();
  await ready;
  t.mock.timers.tick(TAG_RECOMMENDATION_LIMITS.timeoutMs);
  assert.equal((await pending).status, 502);
});

test('burst/daily budgets are configurable, isolated per user, pruned and fail open', async t => {
  const { env, request } = await setup(t);
  env.TAG_RECOMMENDATIONS_BURST_LIMIT = '1';
  assert.equal((await request()).status, 200);
  let response = await request();
  assert.equal(response.status, 429);
  assertHeaders(response);
  env.sqlite.exec("UPDATE auth_events SET created_at = datetime('now', '-11 minutes') WHERE event_type = 'tag_suggestion'");
  env.TAG_RECOMMENDATIONS_DAILY_LIMIT = '1';
  assert.equal((await request()).status, 429, 'daily window counts older burst');
  env.sqlite.exec("UPDATE auth_events SET created_at = datetime('now', '-2 days') WHERE event_type = 'tag_suggestion'");
  assert.equal((await request()).status, 200);
  assert.equal(env.sqlite.prepare("SELECT COUNT(*) AS n FROM auth_events WHERE event_type = 'tag_suggestion'").get().n, 1);
  env.sqlite.exec("UPDATE auth_events SET user_id = 2 WHERE event_type = 'tag_suggestion'");
  assert.equal((await request()).status, 200, 'other users do not spend the owner budget');
  for (const value of ['0', '-1', 'bad', '1.5', '10001']) {
    env.TAG_RECOMMENDATIONS_BURST_LIMIT = value;
    assert.equal((await request()).status, 503);
  }
  env.TAG_RECOMMENDATIONS_BURST_LIMIT = '1';
  env.sqlite.exec('DROP TABLE auth_events');
  assert.equal((await request()).status, 200);
});

test('candidate admission skips invalid legacy/selected names before the cap, with stable usage ordering', async t => {
  const { env, request } = await setup(t);
  env.sqlite.exec('DELETE FROM bookmark_tags');
  const add = name => {
    const { lastInsertRowid } = env.sqlite.prepare('INSERT INTO tags (name) VALUES (?)').run(name);
    env.sqlite.prepare('INSERT INTO bookmark_tags (bookmark_id, tag_id) VALUES (1, ?)').run(lastInsertRowid);
  };
  for (let i = 0; i < 110; i++) add(`!bad\u00a0${i}`);
  add('!😀'.repeat(51));
  for (let i = 0; i < 110; i++) add(`tag${String(i).padStart(3, '0')}`);
  let admitted;
  env.AI.run = async (_model, p) => {
    admitted = JSON.parse(p.messages[1].content).candidates;
    return { response: { suggestions: admitted } };
  };
  const response = await request({ ...body, selectedTags: ['tag000'], title: 'x'.repeat(1000), description: 'd'.repeat(10000) });
  assert.equal(response.status, 200);
  assert.equal(admitted.length, 100);
  assert.equal(admitted[0], 'tag001');
  assert.equal(admitted[99], 'tag100');
  assert.deepEqual((await response.json()).suggestions, admitted.slice(0, 5));
});

test('recommendation budget events stay out of the admin auth log', async t => {
  const { env, headers, request } = await setup(t);
  await request();
  env.SUPER_ADMIN_EMAIL = 'session@example.com';
  const response = await call(env, 'auth/admin/auth-events', { headers });
  assert.equal(response.status, 200);
  assert.doesNotMatch(await response.text(), /tag_suggestion/);
});

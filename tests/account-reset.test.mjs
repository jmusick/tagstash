import test from 'node:test';
import assert from 'node:assert/strict';
import { createAuthEnv } from './helpers/auth-env.mjs';
import { call } from './helpers/api.mjs';

// Account reset (issue #154): POST /auth/reset-library wipes the owner's library and keeps the
// account. Any network call fails the test, so nothing here can reach Stripe, email or anywhere
// else; the reset must never call deleteAccount.

const CONFIRM = 'RESET';
const WEB = { Origin: 'https://tagsta.sh', 'X-Tagstash-Client': 'web' };

async function setup(t, { queryLatency = false } = {}) {
  const env = await createAuthEnv({ queryLatency });
  t.after(() => env.sqlite.close());
  env.STRIPE_SECRET_KEY = 'sk_test_isolated';
  const insertUser = env.sqlite.prepare(`INSERT INTO users (username, email, password_hash, email_verified, stripe_customer_id, stripe_subscription_id, membership_tier, theme, link_target, profile_public)
    SELECT ?, ?, password_hash, 1, ?, ?, ?, ?, ?, ? FROM users WHERE id = 1`);
  insertUser.run('target', 'target@example.com', 'cus_target', 'sub_target', 'paid', 'midnight', 'same', 1);
  insertUser.run('other', 'other@example.com', 'cus_other', 'sub_other', 'free', 'light', 'new', 1);

  const login = (email, headers = {}, password = env.password) =>
    call(env, 'auth/login', { method: 'POST', headers, body: { email, password } });
  const targetBearer = { Authorization: `Bearer ${(await (await login('target@example.com')).json()).token}` };
  const targetCookie = { ...WEB, Cookie: (await login('target@example.com', WEB)).headers.get('Set-Cookie').split(';')[0] };

  // Tags: 1 shared with the other account, 2 only the target uses, 3 only the target uses but
  // another account has favorited, 4 the target's stale favorite only, 5 unreferenced by anyone.
  env.sqlite.exec(`
    INSERT INTO bookmarks (id, user_id, title, url) VALUES (1, 2, 'T1', 'https://t1.example/'), (2, 2, 'T2', 'https://t2.example/'), (3, 3, 'O1', 'https://o1.example/');
    INSERT INTO tags (id, name) VALUES (1, 'shared'), (2, 'target-only'), (3, 'others-favorite'), (4, 'target-stale-favorite'), (5, 'unreferenced');
    INSERT INTO bookmark_tags VALUES (1, 1), (1, 2), (2, 3), (2, 1), (3, 1);
    INSERT INTO favorite_tags (user_id, tag_id) VALUES (2, 1), (2, 2), (2, 4), (3, 1), (3, 3);
    INSERT INTO api_keys (user_id, name, key_hash, key_prefix, key_last4) VALUES (2, 'Target', 'target-hash', 'tsk_a', 'abcd'), (3, 'Other', 'other-hash', 'tsk_b', 'bcde');
    INSERT INTO auth_events (event_type, email, user_id) VALUES ('login_failed', 'other@example.com', 3);
  `);

  // Everything that reaches fetch is a failure: no Stripe, no email, nothing.
  const calls = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => { calls.push(String(url)); throw new Error(`unexpected network call: ${url}`); };
  const errors = [];
  const originalError = console.error;
  console.error = (...args) => errors.push(args);
  t.after(() => { globalThis.fetch = originalFetch; console.error = originalError; });

  return {
    env, calls, errors, targetBearer, targetCookie, login,
    reset: (headers, body = { password: env.password, confirmation: CONFIRM }) =>
      call(env, 'auth/reset-library', { method: 'POST', headers, body }),
    row: (id = 2) => env.sqlite.prepare('SELECT * FROM users WHERE id = ?').get(id),
  };
}

const tables = ['users', 'bookmarks', 'tags', 'bookmark_tags', 'favorite_tags', 'api_keys', 'auth_events'];
const snapshot = (env) => Object.fromEntries(tables.map((table) => [table, env.sqlite.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()]));
// A rejected or failed attempt may add the target's own security-log rows and lockout counters.
const stable = (data) => ({
  ...data,
  users: data.users.map(({ failed_attempts: _f, locked_until: _l, ...user }) => user),
  auth_events: data.auth_events.filter((event) => event.user_id !== 2),
});
const rows = (env, sql) => env.sqlite.prepare(sql).all().map((row) => ({ ...row }));

test('reset removes the owner\'s library, reports counts, and keeps the session', async (t) => {
  const state = await setup(t, { queryLatency: true });
  const { env } = state;
  const response = await state.reset(state.targetCookie);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('Cache-Control'), 'no-store');
  assert.equal(response.headers.get('Set-Cookie'), null, 'the session is not touched');
  const body = await response.json();
  assert.equal(body.reset, true);
  assert.deepEqual(body.removed, { bookmarks: 2, tagLinks: 4, favoriteTags: 3 });

  assert.equal(rows(env, 'SELECT id FROM bookmarks WHERE user_id = 2').length, 0);
  assert.deepEqual(rows(env, 'SELECT * FROM bookmark_tags'), [{ bookmark_id: 3, tag_id: 1 }], 'only the other account\'s link remains');
  assert.deepEqual(rows(env, 'SELECT user_id, tag_id FROM favorite_tags ORDER BY user_id, tag_id'), [{ user_id: 3, tag_id: 1 }, { user_id: 3, tag_id: 3 }]);
  // Orphan rule of a tag delete: gone only if no other link or favorite needs the name.
  assert.deepEqual(rows(env, 'SELECT name FROM tags ORDER BY id').map((row) => row.name),
    ['shared', 'others-favorite', 'unreferenced'],
    'unique, stale-favorite-only names are removed; shared, other-favorited and unrelated names stay');
  assert.deepEqual(rows(env, 'PRAGMA foreign_key_check'), []);

  // The session survives, on both transports, and the library is empty but usable.
  assert.equal((await call(env, 'auth/me', { headers: state.targetCookie })).status, 200);
  assert.equal((await call(env, 'auth/me', { headers: state.targetBearer })).status, 200);
  assert.deepEqual(await (await call(env, 'bookmarks', { headers: state.targetBearer })).json(), { bookmarks: [] });
  const created = await call(env, 'bookmarks', { method: 'POST', headers: state.targetBearer, body: { title: 'Fresh', url: 'https://fresh.example/', tags: ['shared'] } });
  assert.equal(created.status, 201);
  assert.equal(state.calls.length, 0, 'no Stripe, email or any other network call');
});

test('reset keeps the account, credentials, API keys, preferences and billing exactly as they were', async (t) => {
  const state = await setup(t);
  const { env } = state;
  const before = state.row();
  const keysBefore = rows(env, 'SELECT * FROM api_keys WHERE user_id = 2');
  assert.equal((await state.reset(state.targetBearer)).status, 200);
  const after = state.row();
  for (const column of ['username', 'email', 'password_hash', 'membership_tier', 'role', 'email_verified', 'theme', 'link_target',
    'profile_public', 'stripe_customer_id', 'stripe_subscription_id', 'token_version', 'deletion_started_at', 'created_at']) {
    assert.equal(after[column], before[column], column);
  }
  assert.equal(after.deletion_started_at, null, 'reset never starts a deletion');
  assert.deepEqual(rows(env, 'SELECT * FROM api_keys WHERE user_id = 2'), keysBefore);
  assert.equal(rows(env, 'SELECT * FROM api_keys').length, 2);
  assert.equal((await state.login('target@example.com')).status, 200, 'the password still signs in');
  const me = await (await call(env, 'auth/me', { headers: state.targetBearer })).json();
  assert.equal(me.user.membership_tier, 'paid');
  assert.equal(me.user.theme, 'midnight');
  assert.equal(me.user.link_target, 'same');
  assert.equal(state.calls.length, 0);
});

test('other accounts\' bookmarks, shared tags and favorites are untouched', async (t) => {
  const state = await setup(t);
  const { env } = state;
  const otherBefore = {
    user: state.row(3),
    bookmarks: rows(env, 'SELECT * FROM bookmarks WHERE user_id = 3'),
    keys: rows(env, 'SELECT * FROM api_keys WHERE user_id = 3'),
    favorites: rows(env, 'SELECT * FROM favorite_tags WHERE user_id = 3 ORDER BY tag_id'),
    events: rows(env, 'SELECT * FROM auth_events WHERE user_id = 3'),
  };
  assert.equal((await state.reset(state.targetCookie)).status, 200);
  assert.deepEqual({
    user: state.row(3),
    bookmarks: rows(env, 'SELECT * FROM bookmarks WHERE user_id = 3'),
    keys: rows(env, 'SELECT * FROM api_keys WHERE user_id = 3'),
    favorites: rows(env, 'SELECT * FROM favorite_tags WHERE user_id = 3 ORDER BY tag_id'),
    events: rows(env, 'SELECT * FROM auth_events WHERE user_id = 3'),
  }, otherBefore);
  assert.deepEqual(rows(env, 'SELECT tag_id FROM bookmark_tags WHERE bookmark_id = 3'), [{ tag_id: 1 }]);
  // The other account's public API still sees its bookmark and the shared tag.
  const profile = await (await call(env, 'profiles/other')).json();
  assert.deepEqual(profile.bookmarks.map((bookmark) => bookmark.title), ['O1']);
  assert.deepEqual(profile.bookmarks[0].tags.map((tag) => tag.name), ['shared']);
});

test('a wrong password is refused, changes nothing and counts toward the login lockout', async (t) => {
  const state = await setup(t);
  const before = snapshot(state.env);
  const wrong = { password: 'not-the-password', confirmation: CONFIRM };
  for (let attempt = 1; attempt < 8; attempt++) {
    const response = await state.reset(state.targetCookie, wrong);
    assert.equal(response.status, 401);
    assert.deepEqual(await response.json(), { error: 'Incorrect password' });
    assert.equal(state.row().failed_attempts, attempt, 'shares the login counter');
  }
  const locking = await state.reset(state.targetCookie, wrong);
  assert.equal(locking.status, 429);
  assert.match((await locking.json()).error, /Too many failed login attempts/);
  assert.equal((await state.reset(state.targetCookie)).status, 429, 'the right password waits out the lock too');
  assert.equal((await state.login('target@example.com')).status, 429);
  assert.deepEqual(stable(snapshot(state.env)), stable(before));
  assert.equal(state.env.sqlite.prepare("SELECT COUNT(*) AS n FROM auth_events WHERE user_id = 2 AND event_type = 'password_confirmation_failed'").get().n, 8);
});

test('wrong reset and wrong login passwords draw on one counter', async (t) => {
  const state = await setup(t);
  for (let i = 0; i < 5; i++) assert.equal((await state.login('target@example.com', {}, 'wrong-password')).status, 401);
  for (let i = 0; i < 2; i++) assert.equal((await state.reset(state.targetBearer, { password: 'wrong-password', confirmation: CONFIRM })).status, 401);
  assert.equal((await state.reset(state.targetBearer, { password: 'wrong-password', confirmation: CONFIRM })).status, 429);
  assert.equal(rows(state.env, 'SELECT id FROM bookmarks WHERE user_id = 2').length, 2);
});

test('missing or invalid confirmation is rejected before the password is checked or anything changes', async (t) => {
  const state = await setup(t);
  const before = snapshot(state.env);
  const bad = [
    {}, { password: state.env.password }, { confirmation: CONFIRM },
    { password: state.env.password, confirmation: 'reset' },
    { password: state.env.password, confirmation: 'RESET EVERYTHING' },
    { password: state.env.password, confirmation: 'DELETE' }, // the account-deletion word is not accepted here
    { password: state.env.password, confirmation: true },
    { password: state.env.password, confirmation: ['RESET'] },
    { password: '', confirmation: CONFIRM },
    { password: 12345678, confirmation: CONFIRM },
    { password: { $ne: '' }, confirmation: CONFIRM },
  ];
  for (const body of bad) {
    const response = await state.reset(state.targetCookie, body);
    assert.equal(response.status, 400, JSON.stringify(body));
    assert.match((await response.json()).error, /Password is required|Type RESET/);
  }
  assert.equal((await state.reset(state.targetCookie, '[]')).status, 400);
  assert.equal((await state.reset(state.targetCookie, 'not json')).status, 400);
  assert.deepEqual(snapshot(state.env), before);
  assert.equal(state.row().failed_attempts, 0, 'malformed requests spend no password budget');
  // And the reset word does not delete an account.
  const wrongRoute = await call(state.env, 'auth/delete-account', { method: 'POST', headers: state.targetBearer, body: { password: state.env.password, confirmation: CONFIRM } });
  assert.equal(wrongRoute.status, 400);
  assert.deepEqual(snapshot(state.env), before);
  // The typed word is trimmed, nothing more.
  assert.equal((await state.reset(state.targetCookie, { password: state.env.password, confirmation: ' RESET ' })).status, 200);
});

test('unauthenticated, cross-origin and header-less cookie requests are rejected without side effects', async (t) => {
  const state = await setup(t);
  const before = snapshot(state.env);
  const cookie = state.targetCookie.Cookie;
  const attempts = [
    ['no credentials', {}, 401],
    ['malformed bearer', { Authorization: 'Bearer nonsense' }, 403],
    ['cookie without the web client header or origin', { Cookie: cookie }, 403],
    ['cookie with only the web header', { Cookie: cookie, 'X-Tagstash-Client': 'web' }, 403],
    ['cookie from a foreign origin', { Cookie: cookie, 'X-Tagstash-Client': 'web', Origin: 'https://evil.example' }, 403],
    ['cookie from a foreign origin without the header', { Cookie: cookie, Origin: 'https://evil.example' }, 403],
    ['cookie with a foreign referer', { Cookie: cookie, 'X-Tagstash-Client': 'web', Referer: 'https://evil.example/page' }, 403],
    ['a bearer token on a web request', { ...state.targetBearer, 'X-Tagstash-Client': 'web' }, 403],
  ];
  for (const [label, headers, status] of attempts) {
    assert.equal((await state.reset(headers)).status, status, label);
  }
  assert.equal((await call(state.env, 'auth/reset-library', { method: 'GET', headers: state.targetCookie })).status, 404, 'only POST resets');
  assert.deepEqual(snapshot(state.env), before);
  assert.equal(state.calls.length, 0);
});

test('whoever is signed in resets only their own library, whatever the body names', async (t) => {
  const state = await setup(t);
  const otherBearer = { Authorization: `Bearer ${(await (await state.login('other@example.com')).json()).token}` };
  const response = await state.reset(otherBearer, { password: state.env.password, confirmation: CONFIRM, userId: 2, email: 'target@example.com' });
  assert.equal(response.status, 200);
  assert.equal(rows(state.env, 'SELECT id FROM bookmarks WHERE user_id = 3').length, 0);
  assert.equal(rows(state.env, 'SELECT id FROM bookmarks WHERE user_id = 2').length, 2, 'the account named in the body was not touched');
});

test('an account whose deletion has started is refused: library and marker stay as they are', async (t) => {
  const state = await setup(t);
  state.env.sqlite.exec("UPDATE users SET deletion_started_at = '2026-01-01 00:00:00' WHERE id = 2");
  const before = snapshot(state.env);
  for (const headers of [state.targetCookie, state.targetBearer]) {
    const response = await state.reset(headers);
    assert.equal(response.status, 403, 'requireAuth rejects a pending account');
  }
  assert.deepEqual(snapshot(state.env), before);

  // Deletion starting between the session check and the reset is refused by the explicit check.
  state.env.sqlite.exec('UPDATE users SET deletion_started_at = NULL WHERE id = 2');
  const originalPrepare = state.env.DB.prepare;
  let reads = 0;
  state.env.DB.prepare = (sql) => {
    const statement = originalPrepare(sql);
    if (sql.startsWith('SELECT * FROM users WHERE id = ?') && ++reads === 1) {
      const first = statement.first;
      statement.first = async () => {
        const user = await first();
        state.env.sqlite.exec("UPDATE users SET deletion_started_at = '2026-01-01 00:00:00' WHERE id = 2");
        return user;
      };
    }
    return statement;
  };
  const racing = await state.reset(state.targetBearer);
  assert.equal(racing.status, 409);
  assert.match((await racing.json()).error, /deletion is in progress/);
  state.env.DB.prepare = originalPrepare;
  assert.equal(rows(state.env, 'SELECT id FROM bookmarks WHERE user_id = 2').length, 2);
  assert.equal(state.row().deletion_started_at, '2026-01-01 00:00:00', 'the marker is never cleared');
  assert.equal(state.calls.length, 0);
});

test('a failed batch rolls everything back and leaves the library and account intact; a retry succeeds', async (t) => {
  const state = await setup(t);
  const before = snapshot(state.env);
  for (const trigger of [
    "CREATE TRIGGER fail_reset BEFORE DELETE ON bookmarks WHEN OLD.user_id = 2 BEGIN SELECT RAISE(ABORT, 'simulated failure'); END",
    "CREATE TRIGGER fail_reset BEFORE DELETE ON favorite_tags WHEN OLD.user_id = 2 BEGIN SELECT RAISE(ABORT, 'simulated failure'); END",
  ]) {
    state.env.sqlite.exec(trigger);
    const response = await state.reset(state.targetCookie);
    assert.equal(response.status, 503);
    assert.match((await response.json()).error, /nothing was changed/);
    assert.deepEqual(stable(snapshot(state.env)), stable(before), 'one transaction: no partial deletes, tags included');
    assert.equal(response.headers.get('Set-Cookie'), null);
    assert.equal((await call(state.env, 'auth/me', { headers: state.targetCookie })).status, 200, 'the session survives a failure');
    state.env.sqlite.exec('DROP TRIGGER fail_reset');
  }
  assert.doesNotMatch(JSON.stringify(state.errors), /simulated failure|target@example.com/);
  assert.equal((await state.reset(state.targetCookie)).status, 200);
  assert.equal(rows(state.env, 'SELECT id FROM bookmarks WHERE user_id = 2').length, 0);
});

test('the public profile cache entries are purged after a successful reset, not after a failed one', async (t) => {
  const state = await setup(t);
  const deleted = [];
  const cache = { match: async () => undefined, put: async () => {}, delete: async (key) => { const url = new URL(key.url || key); deleted.push(url.pathname + url.search); return true; } };
  const original = Object.getOwnPropertyDescriptor(globalThis, 'caches');
  Object.defineProperty(globalThis, 'caches', { value: { default: cache }, configurable: true, writable: true });
  t.after(() => { if (original) Object.defineProperty(globalThis, 'caches', original); else delete globalThis.caches; });

  state.env.sqlite.exec("CREATE TRIGGER fail_reset BEFORE DELETE ON bookmarks WHEN OLD.user_id = 2 BEGIN SELECT RAISE(ABORT, 'x'); END");
  assert.equal((await state.reset(state.targetBearer)).status, 503);
  assert.deepEqual(deleted, []);
  state.env.sqlite.exec('DROP TRIGGER fail_reset');

  assert.equal((await state.reset(state.targetBearer)).status, 200);
  assert.ok(deleted.includes('/api/profiles/target'), JSON.stringify(deleted));
  assert.ok(deleted.includes('/api/profiles/target'));
  assert.ok(deleted.some((path) => path.includes('?tag=')), 'single-tag variants are purged as well');
});

test('an empty library resets to zero counts, and installations without favorite_tags still reset', async (t) => {
  const state = await setup(t);
  assert.equal((await state.reset(state.targetBearer)).status, 200);
  const again = await state.reset(state.targetBearer);
  assert.equal(again.status, 200);
  assert.deepEqual((await again.json()).removed, { bookmarks: 0, tagLinks: 0, favoriteTags: 0 });

  const legacy = await setup(t);
  legacy.env.sqlite.exec('DROP TABLE favorite_tags');
  const response = await legacy.reset(legacy.targetBearer);
  assert.equal(response.status, 200);
  assert.deepEqual((await response.json()).removed, { bookmarks: 2, tagLinks: 4, favoriteTags: 0 });
  assert.equal(rows(legacy.env, 'SELECT id FROM bookmarks WHERE user_id = 3').length, 1);
});

test('a double submit resets once and never errors', async (t) => {
  const state = await setup(t, { queryLatency: true });
  const [first, second] = await Promise.all([state.reset(state.targetBearer), state.reset(state.targetBearer)]);
  assert.deepEqual([first.status, second.status], [200, 200]);
  assert.equal(rows(state.env, 'SELECT id FROM bookmarks WHERE user_id = 2').length, 0);
  assert.equal(rows(state.env, 'SELECT id FROM bookmarks WHERE user_id = 3').length, 1);
  assert.deepEqual(rows(state.env, 'SELECT * FROM bookmark_tags'), [{ bookmark_id: 3, tag_id: 1 }]);
});

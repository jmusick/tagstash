import test from 'node:test';
import assert from 'node:assert/strict';
import { createAuthEnv } from './helpers/auth-env.mjs';
import { call } from './helpers/api.mjs';

// Self-service account deletion (issue #153). Stripe is stubbed through globalThis.fetch and any
// other host fails the test, so nothing here can reach a live service. The cleanup itself is
// covered in account-deletion.test.mjs; these tests pin the new routes around it.

const missing = () => Response.json({ error: { code: 'resource_missing', message: 'No such customer: private-provider-value' } }, { status: 404 });
const removed = (id = 'cus_target') => Response.json({ id, deleted: true });
const CONFIRM = 'DELETE';
const WEB = { Origin: 'https://tagsta.sh', 'X-Tagstash-Client': 'web' };

async function setup(t, { customer = 'cus_target', subscription = 'sub_target', queryLatency = false } = {}) {
  const env = await createAuthEnv({ queryLatency });
  t.after(() => env.sqlite.close());
  env.SUPER_ADMIN_EMAIL = 'session@example.com'; // user 1
  env.STRIPE_SECRET_KEY = 'sk_test_isolated';
  const insertUser = env.sqlite.prepare(`INSERT INTO users (username, email, password_hash, email_verified, stripe_customer_id, stripe_subscription_id)
    SELECT ?, ?, password_hash, 1, ?, ? FROM users WHERE id = 1`);
  insertUser.run('target', 'target@example.com', customer, subscription);
  insertUser.run('other', 'other@example.com', 'cus_other', 'sub_other');
  const login = (email, headers = {}, password = env.password) =>
    call(env, 'auth/login', { method: 'POST', headers, body: { email, password } });
  const bearer = async (email) => ({ Authorization: `Bearer ${(await (await login(email)).json()).token}` });
  const cookie = async (email) => ({ ...WEB, Cookie: (await login(email, WEB)).headers.get('Set-Cookie').split(';')[0] });
  const targetBearer = await bearer('target@example.com');
  const targetCookie = await cookie('target@example.com');
  const adminCookie = await cookie('session@example.com');

  env.sqlite.exec(`
    INSERT INTO bookmarks (id, user_id, title, url) VALUES (1, 2, 'Target', 'https://target.example/'), (2, 3, 'Other', 'https://other.example/');
    INSERT INTO tags (id, name) VALUES (1, 'shared'), (2, 'target-only'), (3, 'others-favorite');
    INSERT INTO bookmark_tags VALUES (1, 1), (1, 2), (2, 1);
    INSERT INTO favorite_tags (user_id, tag_id) VALUES (2, 1), (2, 2), (3, 1), (3, 3);
    INSERT INTO api_keys (user_id, name, key_hash, key_prefix, key_last4) VALUES (2, 'Target', 'target-hash', 'tsk_a', 'abcd'), (3, 'Other', 'other-hash', 'tsk_b', 'bcde');
    INSERT INTO auth_events (event_type, email, user_id) VALUES ('login_failed', 'other@example.com', 3);
  `);

  const calls = [];
  let stripe = async ({ url }) => removed(url.pathname.split('/').at(-1));
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    const request = { url: new URL(String(url)), options };
    calls.push(request);
    assert.equal(request.url.origin, 'https://api.stripe.com', 'tests must never contact live services');
    return stripe(request);
  };
  const logs = [];
  const originalError = console.error;
  console.error = (...args) => logs.push(args);
  t.after(() => { globalThis.fetch = originalFetch; console.error = originalError; });

  return {
    env, calls, logs, targetBearer, targetCookie, adminCookie, login,
    stripe: (handler) => { stripe = handler; },
    del: (headers, body = { password: env.password, confirmation: CONFIRM }) =>
      call(env, 'auth/delete-account', { method: 'POST', headers, body }),
    resume: (email = 'target@example.com', password = env.password, headers = WEB) =>
      call(env, 'auth/resume-deletion', { method: 'POST', headers, body: { email, password } }),
    row: (id = 2) => env.sqlite.prepare('SELECT * FROM users WHERE id = ?').get(id),
  };
}

const tables = ['users', 'bookmarks', 'tags', 'bookmark_tags', 'favorite_tags', 'api_keys', 'auth_events'];
const snapshot = (env) => Object.fromEntries(tables.map((table) => [table, env.sqlite.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()]));
// Ignores the marker, the lockout counters and the target's own security-log rows, which a
// failed attempt legitimately changes; everything else must be exactly as it was.
const stable = (data) => ({
  ...data,
  users: data.users.map(({ deletion_started_at: _p, failed_attempts: _f, locked_until: _l, ...user }) => user),
  auth_events: data.auth_events.filter((event) => event.user_id !== 2),
});

// Account 2 is gone; account 3's rows, the shared tag and the other account's favorite survive.
const assertTargetDeleted = (env) => {
  assert.equal(env.sqlite.prepare('SELECT id FROM users WHERE id = 2').get(), undefined);
  for (const table of ['bookmarks', 'favorite_tags', 'api_keys']) {
    assert.equal(env.sqlite.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE user_id = 2`).get().n, 0, table);
    assert.ok(env.sqlite.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE user_id = 3`).get().n > 0, `other account keeps ${table}`);
  }
  assert.deepEqual(env.sqlite.prepare('SELECT * FROM bookmark_tags').all().map((row) => ({ ...row })), [{ bookmark_id: 2, tag_id: 1 }]);
  assert.deepEqual(env.sqlite.prepare('SELECT name FROM tags ORDER BY id').all().map((row) => row.name), ['shared', 'others-favorite']);
  assert.deepEqual(env.sqlite.prepare('SELECT user_id, tag_id FROM favorite_tags ORDER BY tag_id').all().map((row) => ({ ...row })),
    [{ user_id: 3, tag_id: 1 }, { user_id: 3, tag_id: 3 }]);
  assert.equal(env.sqlite.prepare('SELECT COUNT(*) AS n FROM users WHERE id = 3').get().n, 1);
  assert.deepEqual(env.sqlite.prepare('PRAGMA foreign_key_check').all(), []);
};

const assertSessionEnded = (response) => {
  const cookie = response.headers.get('Set-Cookie');
  assert.match(cookie, /^__Host-tagstash-session=;/);
  assert.match(cookie, /Max-Age=0/);
};

test('an owner deletes their own account with a cookie session: Stripe first, then data, session ended', async (t) => {
  const state = await setup(t, { queryLatency: true });
  const { env, calls } = state;
  env.sqlite.exec("UPDATE users SET membership_tier = 'paid' WHERE id = 2");
  state.stripe(({ url, options }) => {
    assert.equal(options.method, 'DELETE');
    assert.equal(url.pathname, '/v1/customers/cus_target');
    assert.ok(state.row().deletion_started_at, 'the durable marker is set before billing is touched');
    assert.equal(env.sqlite.prepare('SELECT COUNT(*) AS n FROM bookmarks WHERE user_id = 2').get().n, 1);
    return removed();
  });
  const response = await state.del(state.targetCookie);
  assert.equal(response.status, 200);
  assert.equal((await response.json()).deleted, true);
  assert.equal(response.headers.get('Cache-Control'), 'no-store');
  assertSessionEnded(response);
  assert.equal(calls.length, 1, 'only the target customer was removed');
  assertTargetDeleted(env);
  assert.equal((await call(env, 'auth/me', { headers: state.targetCookie })).status, 403, 'the old cookie no longer works');
  assert.equal((await call(env, 'auth/me', { headers: state.targetBearer })).status, 403);
  assert.equal((await state.login('target@example.com')).status, 401, 'the address can no longer sign in');
  assert.equal((await state.del(state.targetCookie)).status, 403, 'a repeat from the dead session is refused');
});

test('a bearer session can delete a free account that has no billing, even with Stripe unconfigured', async (t) => {
  const state = await setup(t, { customer: null, subscription: null });
  delete state.env.STRIPE_SECRET_KEY;
  const response = await state.del(state.targetBearer);
  assert.equal(response.status, 200);
  assert.equal(state.calls.length, 0);
  assertTargetDeleted(state.env);
});

test('the public profile cache entry is purged after a successful self-service deletion', async (t) => {
  const state = await setup(t, { customer: null, subscription: null });
  const deleted = [];
  const cache = { match: async () => undefined, put: async () => {}, delete: async (key) => { deleted.push(new URL(key.url || key).pathname); return true; } };
  const original = Object.getOwnPropertyDescriptor(globalThis, 'caches');
  Object.defineProperty(globalThis, 'caches', { value: { default: cache }, configurable: true, writable: true });
  t.after(() => { if (original) Object.defineProperty(globalThis, 'caches', original); else delete globalThis.caches; });
  state.env.sqlite.exec('UPDATE users SET profile_public = 1 WHERE id = 2');
  assert.equal((await state.del(state.targetBearer)).status, 200);
  assert.ok(deleted.includes('/api/profiles/target'), JSON.stringify(deleted));
});

test('a wrong password is refused, changes nothing and counts toward the login lockout', async (t) => {
  const state = await setup(t);
  const before = snapshot(state.env);
  const wrong = { password: 'not-the-password', confirmation: CONFIRM };
  for (let attempt = 1; attempt < 8; attempt++) {
    const response = await state.del(state.targetCookie, wrong);
    assert.equal(response.status, 401);
    assert.deepEqual(await response.json(), { error: 'Incorrect password' });
    assert.equal(state.row().failed_attempts, attempt, 'shares the per-account login counter');
  }
  // The eighth miss locks the account for login too.
  const locking = await state.del(state.targetCookie, wrong);
  assert.equal(locking.status, 429);
  assert.match((await locking.json()).error, /Too many failed login attempts/);
  const correct = await state.del(state.targetCookie);
  assert.equal(correct.status, 429, 'even the right password waits out the lock');
  assert.equal((await state.login('target@example.com')).status, 429, 'login is locked by the same counter');
  assert.deepEqual(stable(snapshot(state.env)), stable(before));
  assert.equal(state.row().deletion_started_at, null);
  assert.equal(state.calls.length, 0);
  const events = state.env.sqlite.prepare("SELECT event_type FROM auth_events WHERE user_id = 2 AND event_type = 'password_confirmation_failed'").all();
  assert.equal(events.length, 8);
});

test('wrong deletion passwords, wrong resume passwords and wrong login passwords draw on one counter', async (t) => {
  const state = await setup(t);
  for (let i = 0; i < 4; i++) assert.equal((await state.login('target@example.com', {}, 'wrong-password')).status, 401);
  for (let i = 0; i < 3; i++) assert.equal((await state.del(state.targetBearer, { password: 'wrong-password', confirmation: CONFIRM })).status, 401);
  assert.equal((await state.resume('target@example.com', 'wrong-password')).status, 429, 'the eighth miss, by resume, locks');
  assert.equal((await state.del(state.targetBearer)).status, 429);
});

test('the per-IP failure cap applies to deletion and resume attempts', async (t) => {
  const state = await setup(t);
  const headers = { ...WEB, 'CF-Connecting-IP': '203.0.113.9' };
  for (let i = 0; i < 20; i++) {
    assert.equal((await state.resume(`nobody${i}@example.com`, 'wrong-password', headers)).status, 401);
  }
  const limited = await state.resume('target@example.com', state.env.password, headers);
  assert.equal(limited.status, 429);
  assert.match((await limited.json()).error, /from your network/);
  const viaDelete = await state.del({ ...state.targetBearer, 'CF-Connecting-IP': '203.0.113.9' });
  assert.equal(viaDelete.status, 429);
  assert.equal(state.row().deletion_started_at, null);
  assert.equal(state.calls.length, 0);
});

test('missing or invalid confirmation is rejected before the password is checked or anything changes', async (t) => {
  const state = await setup(t);
  const before = snapshot(state.env);
  const bad = [
    {}, { password: state.env.password }, { confirmation: CONFIRM },
    { password: state.env.password, confirmation: 'delete' },
    { password: state.env.password, confirmation: 'DELETE MY ACCOUNT' },
    { password: state.env.password, confirmation: true },
    { password: state.env.password, confirmation: ['DELETE'] },
    { password: '', confirmation: CONFIRM },
    { password: 12345678, confirmation: CONFIRM },
    { password: { $ne: '' }, confirmation: CONFIRM },
  ];
  for (const body of bad) {
    const response = await state.del(state.targetCookie, body);
    assert.equal(response.status, 400, JSON.stringify(body));
    assert.match((await response.json()).error, /Password is required|Type DELETE/);
  }
  assert.equal((await state.del(state.targetCookie, '[]')).status, 400);
  assert.equal((await state.del(state.targetCookie, 'not json')).status, 400);
  assert.deepEqual(snapshot(state.env), before);
  assert.equal(state.row().failed_attempts, 0, 'malformed requests spend no password budget');
  assert.equal(state.row().deletion_started_at, null);
  assert.equal(state.calls.length, 0);
  // The typed word is trimmed, nothing more.
  assert.equal((await state.del(state.targetCookie, { password: state.env.password, confirmation: ' DELETE ' })).status, 200);
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
    const response = await state.del(headers);
    assert.equal(response.status, status, label);
    assert.equal(response.headers.get('Set-Cookie'), null, label);
  }
  assert.equal((await call(state.env, 'auth/delete-account', { method: 'GET', headers: state.targetCookie })).status, 404, 'only POST deletes');
  assert.deepEqual(snapshot(state.env), before);
  assert.equal(state.row().deletion_started_at, null);
  assert.equal(state.calls.length, 0);
});

test('whoever is signed in deletes only themselves, whatever the body names', async (t) => {
  const state = await setup(t);
  const otherCookie = { ...WEB, Cookie: (await state.login('other@example.com', WEB)).headers.get('Set-Cookie').split(';')[0] };
  const response = await state.del(otherCookie, { password: state.env.password, confirmation: CONFIRM, userId: 2, email: 'target@example.com' });
  assert.equal(response.status, 200);
  assert.equal(state.row(3), undefined, 'the caller was deleted');
  assert.ok(state.row(2), 'the account named in the body was not');
  assert.equal(state.env.sqlite.prepare('SELECT COUNT(*) AS n FROM bookmarks WHERE user_id = 2').get().n, 1);
  assert.deepEqual(state.calls.map(({ url }) => url.pathname), ['/v1/customers/cus_other']);
});

test('protected super admins cannot self-delete: 403 before the password is checked', async (t) => {
  const state = await setup(t);
  const before = snapshot(state.env);
  for (const body of [
    { password: state.env.password, confirmation: CONFIRM },
    { password: 'wrong-password', confirmation: CONFIRM },
  ]) {
    const response = await state.del(state.adminCookie, body);
    assert.equal(response.status, 403);
    assert.match((await response.json()).error, /super admin/);
  }
  assert.equal(state.row(1).failed_attempts, 0, 'the refusal spends no password budget');
  // A user holding the role but not the configured address is protected as well, like the admin route.
  state.env.SUPER_ADMIN_EMAIL = 'someone-else@example.com';
  state.env.sqlite.exec("UPDATE users SET role = 'super_admin' WHERE id = 2");
  assert.equal((await state.del(state.targetBearer)).status, 403);
  state.env.sqlite.exec("UPDATE users SET role = 'user' WHERE id = 2");
  assert.deepEqual(snapshot(state.env), before);
  assert.equal(state.calls.length, 0);
  assert.equal(state.row(1).deletion_started_at, null);
});

test('a pending super admin cannot be finished through resume either', async (t) => {
  const state = await setup(t);
  state.env.sqlite.exec("UPDATE users SET deletion_started_at = '2026-01-01' WHERE id = 1");
  const response = await state.resume('session@example.com');
  assert.equal(response.status, 403);
  assert.ok(state.row(1));
  assert.equal(state.calls.length, 0);
});

test('Stripe failure keeps all data, ends the session and reports the deletion as pending; a later retry finishes', async (t) => {
  const state = await setup(t);
  const before = stable(snapshot(state.env));
  state.stripe(() => Response.json({ error: { message: 'private-provider-value' } }, { status: 500 }));
  const response = await state.del(state.targetCookie);
  assert.equal(response.status, 502);
  const body = await response.json();
  assert.equal(body.deletionPending, true);
  assert.doesNotMatch(JSON.stringify(body), /private-provider-value/);
  assertSessionEnded(response);
  assert.deepEqual(stable(snapshot(state.env)), before);
  assert.ok(state.row().deletion_started_at, 'the marker stays; nothing clears it automatically');
  assert.equal((await call(state.env, 'auth/me', { headers: state.targetCookie })).status, 403);
  assert.equal((await call(state.env, 'auth/me', { headers: state.targetBearer })).status, 403);
  assert.equal((await call(state.env, 'billing/checkout-session', { method: 'POST', headers: state.targetBearer, body: { plan: 'monthly' } })).status, 403);

  // The signed-in route is not a retry path: the session is dead.
  assert.equal((await state.del(state.targetCookie)).status, 403);

  // Retry from the login screen: still failing...
  const again = await state.resume();
  assert.equal(again.status, 502);
  assert.equal((await again.json()).deletionPending, true);
  assert.ok(state.row().deletion_started_at);
  assert.ok(state.row().stripe_customer_id, 'billing identifiers are retained for the retry');
  // ...then Stripe recovers (here it no longer knows the customer, so billing is already closed).
  state.stripe(missing);
  const retried = await state.resume();
  assert.equal(retried.status, 200);
  assert.equal((await retried.json()).deleted, true);
  assertSessionEnded(retried);
  assertTargetDeleted(state.env);
  assert.doesNotMatch(JSON.stringify(state.logs), /private-provider-value|target@example.com|sk_test_isolated/);
});

test('a failed cleanup transaction rolls back and leaves deletion pending; resume finishes it', async (t) => {
  const state = await setup(t);
  const before = stable(snapshot(state.env));
  state.env.sqlite.exec("CREATE TRIGGER fail_deletion BEFORE DELETE ON users WHEN OLD.id = 2 BEGIN SELECT RAISE(ABORT, 'simulated cleanup failure'); END");
  const response = await state.del(state.targetBearer);
  assert.equal(response.status, 503);
  const body = await response.json();
  assert.equal(body.deletionPending, true);
  assert.match(body.error, /retry to finish cleanup/);
  assertSessionEnded(response);
  assert.deepEqual(stable(snapshot(state.env)), before);
  assert.ok(state.row().deletion_started_at);
  assert.equal(state.calls.length, 1, 'billing was closed on the first attempt');

  assert.equal((await state.resume()).status, 503, 'resume reports a persistent failure the same way');
  state.env.sqlite.exec('DROP TRIGGER fail_deletion');
  state.stripe(missing);
  const retried = await state.resume();
  assert.equal(retried.status, 200);
  assertTargetDeleted(state.env);
});

test('an interrupted deletion: login answers with a distinct response only after the password is proved, and resume completes it', async (t) => {
  const state = await setup(t);
  // As if the Worker died after the marker was stamped and before Stripe or D1 finished.
  state.env.sqlite.exec("UPDATE users SET deletion_started_at = '2026-01-01 00:00:00' WHERE id = 2");

  const wrong = await state.login('target@example.com', {}, 'wrong-password');
  const unknown = await state.login('nobody@example.com', {}, 'wrong-password');
  assert.equal(wrong.status, 401);
  assert.equal(unknown.status, 401);
  assert.deepEqual(await wrong.json(), await unknown.json(), 'without the password a pending account looks like any other');

  const pending = await state.login('target@example.com');
  assert.equal(pending.status, 403);
  const body = await pending.json();
  assert.equal(body.deletionPending, true);
  assert.match(body.error, /deletion was started/);
  assert.equal(pending.headers.get('Set-Cookie'), null, 'no session is issued');
  assert.equal((await state.login('target@example.com', WEB)).headers.get('Set-Cookie'), null);

  // Resume re-proves the password; a wrong one is an ordinary 401, the same as for unknown addresses.
  const resumeWrong = await state.resume('target@example.com', 'wrong-password');
  const resumeUnknown = await state.resume('nobody@example.com', 'wrong-password');
  assert.equal(resumeWrong.status, 401);
  assert.deepEqual(await resumeWrong.json(), await resumeUnknown.json());
  assert.ok(state.row(), 'a wrong password deletes nothing');
  assert.equal(state.calls.length, 0);

  const done = await state.resume('TARGET@example.com');
  assert.equal(done.status, 200);
  assertSessionEnded(done);
  assert.deepEqual(state.calls.map(({ url }) => url.pathname), ['/v1/customers/cus_target']);
  assertTargetDeleted(state.env);
});

test('resume does nothing for an account with no deletion started, and a failing resume never clears the marker', async (t) => {
  const state = await setup(t);
  const before = snapshot(state.env);
  const response = await state.resume();
  assert.equal(response.status, 409);
  assert.match((await response.json()).error, /No account deletion/);
  assert.deepEqual(snapshot(state.env), before);
  assert.equal(state.calls.length, 0);
  assert.equal((await state.resume('target@example.com', '')).status, 400);
  assert.equal((await state.resume('', state.env.password)).status, 400);

  state.env.sqlite.exec("UPDATE users SET deletion_started_at = '2026-01-01' WHERE id = 2");
  state.stripe(() => { throw new TypeError('network failed'); });
  const failed = await state.resume();
  assert.equal(failed.status, 502);
  assert.equal(state.row().deletion_started_at, '2026-01-01');
  assert.equal((await state.login('target@example.com')).status, 403, 'access is not restored while Stripe state is uncertain');
});

test('resume requires the web origin proof like login, and rejects missing or malformed input', async (t) => {
  const state = await setup(t);
  state.env.sqlite.exec("UPDATE users SET deletion_started_at = '2026-01-01' WHERE id = 2");
  assert.equal((await state.resume('target@example.com', state.env.password, { 'X-Tagstash-Client': 'web', Origin: 'https://evil.example' })).status, 403);
  assert.equal((await state.resume('target@example.com', state.env.password, { Cookie: state.targetCookie.Cookie })).status, 403);
  assert.equal((await call(state.env, 'auth/resume-deletion', { method: 'POST', headers: WEB, body: { email: 'target@example.com' } })).status, 400);
  assert.equal((await call(state.env, 'auth/resume-deletion', { method: 'POST', headers: WEB, body: { email: 'target@example.com', password: 12345678 } })).status, 400);
  assert.equal((await call(state.env, 'auth/resume-deletion', { method: 'GET', headers: WEB })).status, 404);
  assert.ok(state.row());
  assert.equal(state.calls.length, 0);
});

test('failures before deletion starts leave the account usable: no marker, session intact', async (t) => {
  const state = await setup(t);
  const before = snapshot(state.env);
  delete state.env.STRIPE_SECRET_KEY;
  const noStripe = await state.del(state.targetCookie);
  assert.equal(noStripe.status, 503);
  assert.equal((await noStripe.json()).deletionPending, undefined);
  assert.equal(noStripe.headers.get('Set-Cookie'), null);
  assert.equal((await call(state.env, 'auth/me', { headers: state.targetCookie })).status, 200, 'the session survives');
  state.env.STRIPE_SECRET_KEY = 'sk_test_isolated';
  state.env.sqlite.exec('ALTER TABLE users DROP COLUMN deletion_started_at');
  const noMigration = await state.del(state.targetCookie);
  assert.equal(noMigration.status, 503);
  assert.equal(noMigration.headers.get('Set-Cookie'), null);
  assert.equal((await call(state.env, 'auth/me', { headers: state.targetCookie })).status, 200);
  assert.deepEqual(stable(snapshot(state.env)), stable(before));
  assert.equal(state.calls.length, 0);
});

test('a double submit deletes once: the second request finds nothing to do', async (t) => {
  const state = await setup(t, { queryLatency: true });
  const [first, second] = await Promise.all([state.del(state.targetBearer), state.del(state.targetBearer)]);
  assert.ok([first.status, second.status].includes(200), `${first.status} ${second.status}`);
  assert.ok([first.status, second.status].every((status) => [200, 403, 404].includes(status)), `${first.status} ${second.status}`);
  assertTargetDeleted(state.env);
});

test('the admin delete route still finishes an account whose owner never completed deletion', async (t) => {
  const state = await setup(t);
  state.stripe(() => { throw new TypeError('network failed'); });
  assert.equal((await state.del(state.targetBearer)).status, 502);
  state.stripe(missing);
  const response = await call(state.env, 'auth/admin/users/2', { method: 'DELETE', headers: state.adminCookie });
  assert.equal(response.status, 200);
  assertTargetDeleted(state.env);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import bcrypt from 'bcryptjs';
import { onRequest } from '../functions/api/[[path]].js';
import { createAuthEnv } from './helpers/auth-env.mjs';
import { call } from './helpers/api.mjs';

const digest = (token) => createHash('sha256').update(token).digest('hex');
const webHeaders = { Origin: 'https://tagsta.sh', 'X-Tagstash-Client': 'web' };
const reset = (env, token, password) =>
  onRequest({ env, request: new Request('https://tagsta.sh/api/auth/reset-password', {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...webHeaders },
    body: JSON.stringify({ token, password }),
  }) });
const addToken = (env, token, expiresAt = new Date(Date.now() + 3600000).toISOString()) =>
  env.sqlite.prepare('INSERT INTO password_reset_tokens (user_id, token, token_hash, expires_at) VALUES (1, ?, ?, ?)')
    .run('sha256:' + digest(token), digest(token), expiresAt);
const state = (env) => env.sqlite.prepare('SELECT password_hash, token_version FROM users WHERE id = 1').get();

test('concurrent redemptions of one reset token: exactly one succeeds and sets the password', async () => {
  const env = await createAuthEnv({ queryLatency: true });
  try {
    addToken(env, 'race-token');
    const before = state(env);
    const results = await Promise.all(['first-password-1', 'second-password-2', 'third-password-3', 'fourth-password-4']
      .map((password) => reset(env, 'race-token', password).then(async (r) => ({ status: r.status, password }))));
    const winners = results.filter((r) => r.status === 200);
    assert.equal(winners.length, 1);
    assert.ok(results.filter((r) => r.status !== 200).every((r) => r.status === 400));
    const after = state(env);
    assert.equal(after.token_version, before.token_version + 1);
    assert.ok(await bcrypt.compare(winners[0].password, after.password_hash));
    assert.equal((await reset(env, 'race-token', 'fifth-password-5')).status, 400);
  } finally { env.sqlite.close(); }
});

const seedKey = (env, userId, value, revokedAt = null) => env.sqlite.prepare(
  `INSERT INTO api_keys (user_id, name, key_hash, key_prefix, key_last4, revoked_at)
   VALUES (?, 'Recovery test', ?, ?, ?, ?)`)
  .run(userId, digest(value), value.slice(0, 8), value.slice(-4), revokedAt);
const keyHeaders = (key) => ({ Authorization: `Bearer ${key}` });
const ownerKey = `tsk_${'1'.repeat(48)}`;
const otherKey = `tsk_${'2'.repeat(48)}`;

test('recovery revokes all active owner keys, rejects their library access and preserves other users and old revocations', async () => {
  const env = await createAuthEnv({ queryLatency: true });
  try {
    env.sqlite.exec("INSERT INTO users (id, username, email, password_hash, email_verified) VALUES (2, 'other', 'other@example.test', 'x', 1)");
    seedKey(env, 1, ownerKey);
    seedKey(env, 1, `tsk_${'3'.repeat(48)}`);
    seedKey(env, 1, `tsk_${'4'.repeat(48)}`, '2020-01-01 00:00:00');
    seedKey(env, 2, otherKey);
    const otherBefore = env.sqlite.prepare('SELECT * FROM api_keys WHERE user_id = 2').all();
    assert.equal((await call(env, 'bookmarks', { headers: keyHeaders(ownerKey) })).status, 200);
    addToken(env, 'recover-keys');
    const response = await reset(env, 'recover-keys', 'recovered-password-1');
    assert.equal(response.status, 200);
    assert.match((await response.json()).message, /API keys have been revoked/);
    assert.equal(env.sqlite.prepare('SELECT COUNT(*) AS n FROM api_keys WHERE user_id = 1 AND revoked_at IS NULL').get().n, 0);
    assert.equal(env.sqlite.prepare('SELECT revoked_at FROM api_keys WHERE key_hash = ?').get(digest(`tsk_${'4'.repeat(48)}`)).revoked_at, '2020-01-01 00:00:00');
    assert.deepEqual(env.sqlite.prepare('SELECT * FROM api_keys WHERE user_id = 2').all(), otherBefore);
    assert.equal((await call(env, 'bookmarks', { headers: keyHeaders(ownerKey) })).status, 403);
    assert.equal((await call(env, 'bookmarks', { headers: keyHeaders(otherKey) })).status, 200);
    assert.ok(await bcrypt.compare('recovered-password-1', state(env).password_hash));
  } finally { env.sqlite.close(); }
});

test('Settings password changes and Sign out of all devices keep keys usable', async () => {
  const env = await createAuthEnv();
  try {
    seedKey(env, 1, ownerKey);
    const initialLogin = await call(env, 'auth/login', { method: 'POST', headers: webHeaders,
      body: { email: 'session@example.com', password: env.password } });
    const headers = { ...webHeaders, Cookie: initialLogin.headers.get('Set-Cookie').split(';')[0] };
    const response = await call(env, 'auth/password', { method: 'PUT', headers,
      body: { currentPassword: env.password, newPassword: 'settings-password-1', confirmPassword: 'settings-password-1' } });
    assert.equal(response.status, 200);
    assert.equal(env.sqlite.prepare('SELECT revoked_at FROM api_keys').get().revoked_at, null);
    assert.equal((await call(env, 'bookmarks', { headers: keyHeaders(ownerKey) })).status, 200);
    const login = await call(env, 'auth/login', { method: 'POST', headers: webHeaders,
      body: { email: 'session@example.com', password: 'settings-password-1' } });
    const Cookie = login.headers.get('Set-Cookie').split(';')[0];
    assert.equal((await call(env, 'auth/logout-everywhere', { method: 'POST', headers: { ...webHeaders, Cookie } })).status, 200);
    assert.equal(env.sqlite.prepare('SELECT revoked_at FROM api_keys').get().revoked_at, null);
    assert.equal((await call(env, 'bookmarks', { headers: keyHeaders(ownerKey) })).status, 200);
  } finally { env.sqlite.close(); }
});

test('recovery fails closed without the key table or revocation column, preserving the password and unused token', async () => {
  for (const mutation of ['DROP TABLE api_keys', 'ALTER TABLE api_keys DROP COLUMN revoked_at']) {
    const env = await createAuthEnv();
    try {
      seedKey(env, 1, ownerKey);
      addToken(env, 'missing-schema');
      const before = state(env);
      env.sqlite.exec(mutation);
      const response = await reset(env, 'missing-schema', 'recovered-password-1');
      assert.equal(response.status, 503, mutation);
      assert.match((await response.json()).error, /Account recovery is temporarily unavailable/);
      assert.deepEqual(state(env), before);
      assert.equal(env.sqlite.prepare('SELECT used_at FROM password_reset_tokens').get().used_at, null);
      assert.equal(response.headers.get('Set-Cookie'), null);
    } finally { env.sqlite.close(); }
  }
});

test('a failed key revocation rolls back the password, sessions, keys and reset token together', async () => {
  const env = await createAuthEnv();
  try {
    seedKey(env, 1, ownerKey);
    addToken(env, 'atomic-recovery');
    env.sqlite.exec("CREATE TRIGGER refuse_revocation BEFORE UPDATE OF revoked_at ON api_keys BEGIN SELECT RAISE(ABORT, 'simulated D1 failure'); END");
    const before = state(env);
    const error = console.error;
    console.error = () => {};
    let response;
    try { response = await reset(env, 'atomic-recovery', 'recovered-password-1'); }
    finally { console.error = error; }
    assert.equal(response.status, 500);
    assert.deepEqual(state(env), before);
    assert.equal(env.sqlite.prepare('SELECT revoked_at FROM api_keys').get().revoked_at, null);
    assert.equal(env.sqlite.prepare('SELECT used_at FROM password_reset_tokens').get().used_at, null);
    env.sqlite.exec('DROP TRIGGER refuse_revocation');
    assert.equal((await reset(env, 'atomic-recovery', 'recovered-password-1')).status, 200);
    assert.equal((await call(env, 'bookmarks', { headers: keyHeaders(ownerKey) })).status, 403);
  } finally { env.sqlite.close(); }
});

test('concurrent recovery losers cannot revoke keys created after the winning reset', async () => {
  const env = await createAuthEnv({ queryLatency: true });
  try {
    seedKey(env, 1, ownerKey);
    addToken(env, 'key-race');
    let release;
    const allReady = new Promise((resolve) => { release = resolve; });
    const batch = env.DB.batch.bind(env.DB);
    let arrivals = 0;
    let minted = false;
    env.DB.batch = async (statements) => {
      arrivals += 1;
      if (arrivals === 3) release();
      await allReady;
      const result = await batch(statements);
      if (result[0].meta.changes && !minted) {
        minted = true;
        seedKey(env, 1, otherKey);
      }
      return result;
    };
    const responses = await Promise.all(Array.from({ length: 3 }, () => reset(env, 'key-race', 'recovered-password-1')));
    assert.deepEqual(responses.map((r) => r.status).sort(), [200, 400, 400]);
    assert.ok(env.sqlite.prepare('SELECT revoked_at FROM api_keys WHERE key_hash = ?').get(digest(ownerKey)).revoked_at);
    assert.equal(env.sqlite.prepare('SELECT revoked_at FROM api_keys WHERE key_hash = ?').get(digest(otherKey)).revoked_at, null);
    assert.equal((await call(env, 'bookmarks', { headers: keyHeaders(otherKey) })).status, 200);
  } finally { env.sqlite.close(); }
});

test('expired or already-used tokens change nothing; a good reset kills sibling links and lockout', async () => {
  const env = await createAuthEnv();
  try {
    addToken(env, 'expired-token', '2000-01-01T00:00:00.000Z');
    const before = state(env);
    assert.equal((await reset(env, 'expired-token', 'brand-new-password')).status, 400);
    assert.deepEqual(state(env), before);

    addToken(env, 'good-token');
    addToken(env, 'sibling-token');
    env.sqlite.exec('UPDATE users SET failed_attempts = 8, locked_until = 9999999999999');
    assert.equal((await reset(env, 'good-token', 'brand-new-password')).status, 200);
    assert.ok(await bcrypt.compare('brand-new-password', state(env).password_hash));
    assert.deepEqual({ ...env.sqlite.prepare('SELECT failed_attempts, locked_until FROM users').get() }, { failed_attempts: 0, locked_until: null });
    assert.equal((await reset(env, 'sibling-token', 'another-password-x')).status, 400);
    assert.equal(env.sqlite.prepare('SELECT COUNT(*) AS c FROM password_reset_tokens WHERE used_at IS NULL AND token_hash != ?').get(digest('expired-token')).c, 0);
  } finally { env.sqlite.close(); }
});

test('a failed batch leaves the password, session version and token untouched', async () => {
  const env = await createAuthEnv();
  try {
    addToken(env, 'fail-token');
    const before = state(env);
    const realBatch = env.DB.batch.bind(env.DB);
    env.DB.batch = async (statements) => realBatch([...statements, { run: async () => { throw new Error('simulated D1 failure'); } }]);
    const realError = console.error;
    console.error = () => {};
    try {
      assert.equal((await reset(env, 'fail-token', 'brand-new-password')).status, 500);
    } finally { console.error = realError; }
    assert.deepEqual(state(env), before);
    assert.equal(env.sqlite.prepare('SELECT used_at FROM password_reset_tokens').get().used_at, null);
  } finally { env.sqlite.close(); }
});

test('an authenticated password change invalidates reset links issued earlier', async () => {
  const env = await createAuthEnv();
  try {
    addToken(env, 'earlier-link');
    const login = await onRequest({ env, request: new Request('https://tagsta.sh/api/auth/login', {
      method: 'POST', headers: { 'Content-Type': 'application/json', ...webHeaders },
      body: JSON.stringify({ email: 'session@example.com', password: env.password }),
    }) });
    const change = await onRequest({ env, request: new Request('https://tagsta.sh/api/auth/password', {
      method: 'PUT', headers: { 'Content-Type': 'application/json', ...webHeaders, Cookie: login.headers.get('Set-Cookie').split(';')[0] },
      body: JSON.stringify({ currentPassword: env.password, newPassword: 'changed-by-owner-1', confirmPassword: 'changed-by-owner-1' }),
    }) });
    assert.equal(change.status, 200);
    const afterChange = state(env);
    assert.equal((await reset(env, 'earlier-link', 'attacker-chosen-pw')).status, 400);
    assert.deepEqual(state(env), afterChange);
    assert.ok(await bcrypt.compare('changed-by-owner-1', afterChange.password_hash));
  } finally { env.sqlite.close(); }
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import bcrypt from 'bcryptjs';
import { onRequest } from '../functions/api/[[path]].js';
import { createAuthEnv } from './helpers/auth-env.mjs';

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
  const env = await createAuthEnv();
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

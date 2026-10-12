import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { onRequest } from '../functions/api/[[path]].js';
import { createAuthEnv } from './helpers/auth-env.mjs';

const digest = (token) => createHash('sha256').update(token).digest('hex');
const webHeaders = { Origin: 'https://tagsta.sh', 'X-Tagstash-Client': 'web' };
const verify = (env, token, headers = webHeaders) =>
  onRequest({ env, request: new Request(`https://tagsta.sh/api/auth/verify-email?token=${token}`, { headers }) });
const addToken = (env, token, expiresAt = new Date(Date.now() + 3600000).toISOString()) =>
  env.sqlite.prepare('INSERT INTO email_verification_tokens (user_id, token, token_hash, expires_at) VALUES (1, ?, ?, ?)')
    .run('sha256:' + digest(token), digest(token), expiresAt);
const verified = (env) => env.sqlite.prepare('SELECT email_verified FROM users WHERE id = 1').get().email_verified;

test('concurrent redemptions of one verification link: exactly one wins and gets a session', async () => {
  const env = await createAuthEnv({ queryLatency: true });
  try {
    env.sqlite.exec('UPDATE users SET email_verified = 0');
    addToken(env, 'verify-race');
    const results = await Promise.all([1, 2, 3, 4, 5].map(async (n) => {
      // Mix web (cookie) and bearer (JSON token) redemptions; neither kind may double-issue.
      const response = await verify(env, 'verify-race', n % 2 ? webHeaders : {});
      const body = await response.json();
      return { status: response.status, cookie: response.headers.get('Set-Cookie'), token: body.token };
    }));
    const winners = results.filter((r) => r.status === 200);
    assert.equal(winners.length, 1);
    assert.ok(winners[0].cookie || winners[0].token, 'the winner is signed in');
    for (const loser of results.filter((r) => r.status !== 200)) {
      assert.equal(loser.status, 400);
      assert.equal(loser.cookie, null);
      assert.equal(loser.token, undefined);
    }
    assert.equal(verified(env), 1);
    assert.equal((await verify(env, 'verify-race')).status, 400);
  } finally { env.sqlite.close(); }
});

test('expired and used verification links neither verify the account nor sign anyone in', async () => {
  const env = await createAuthEnv({ queryLatency: true });
  try {
    env.sqlite.exec('UPDATE users SET email_verified = 0');
    addToken(env, 'verify-expired', '2000-01-01T00:00:00.000Z');
    const expired = await verify(env, 'verify-expired');
    assert.equal(expired.status, 400);
    assert.equal(expired.headers.get('Set-Cookie'), null);
    assert.equal(verified(env), 0);

    addToken(env, 'verify-used');
    env.sqlite.prepare('UPDATE email_verification_tokens SET used_at = CURRENT_TIMESTAMP WHERE token_hash = ?').run(digest('verify-used'));
    const used = await verify(env, 'verify-used');
    assert.equal(used.status, 400);
    assert.equal(used.headers.get('Set-Cookie'), null);
    assert.equal(verified(env), 0);
  } finally { env.sqlite.close(); }
});

test('a failed verification batch leaves the token unused and the account unverified', async () => {
  const env = await createAuthEnv({ queryLatency: true });
  try {
    env.sqlite.exec('UPDATE users SET email_verified = 0');
    addToken(env, 'verify-batch-failure');
    const realBatch = env.DB.batch;
    env.DB.batch = async (statements) => realBatch.call(env.DB, [...statements, env.DB.prepare('SELECT * FROM missing_table')]);
    const realError = console.error;
    console.error = () => {};
    try {
      const response = await verify(env, 'verify-batch-failure');
      assert.equal(response.status, 500);
      assert.equal(response.headers.get('Set-Cookie'), null);
    } finally { console.error = realError; env.DB.batch = realBatch; }
    assert.equal(verified(env), 0);
    assert.equal(env.sqlite.prepare('SELECT used_at FROM email_verification_tokens WHERE token_hash = ?').get(digest('verify-batch-failure')).used_at, null);
    // The link still works once the database recovers.
    assert.equal((await verify(env, 'verify-batch-failure')).status, 200);
    assert.equal(verified(env), 1);
  } finally { env.sqlite.close(); }
});

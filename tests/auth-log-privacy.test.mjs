import test from 'node:test';
import assert from 'node:assert/strict';
import { onRequest } from '../functions/api/[[path]].js';
import { createAuthEnv } from './helpers/auth-env.mjs';

const IP = '203.0.113.77';
const call = (env, path, body) =>
  onRequest({ env, request: new Request(`https://tagsta.sh/api/${path}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': IP }, body: JSON.stringify(body),
  }) });

// Collect everything written to the Worker log while running the given flow.
const captureLogs = async (run) => {
  const lines = [];
  const real = { log: console.log, warn: console.warn, error: console.error, info: console.info };
  for (const level of Object.keys(real)) console[level] = (...args) => lines.push(args.map(String).join(' '));
  try { await run(); } finally { Object.assign(console, real); }
  return lines.join('\n');
};

test('auth flows log no raw email, IP or account-existence detail; auth_events keeps the record', async () => {
  const env = await createAuthEnv();
  try {
    const logs = await captureLogs(async () => {
      // Registered address (email sending unconfigured, so the send fails and is logged).
      await call(env, 'auth/forgot-password', { email: 'Session@Example.com' });
      // Unregistered address.
      await call(env, 'auth/forgot-password', { email: 'ghost@example.com' });
      await call(env, 'auth/login', { email: 'session@example.com', password: 'wrong-password' });
      await call(env, 'auth/login', { email: 'ghost@example.com', password: 'wrong-password' });
    });
    for (const secret of ['session@example.com', 'Session@Example.com', 'ghost@example.com', IP]) {
      assert.ok(!logs.includes(secret), `Worker log must not contain ${secret}`);
    }
    assert.doesNotMatch(logs, /user found|no user found|raw email|lookup for/i);
    assert.match(logs, /\[auth\] password_reset_requested/);

    const events = env.sqlite.prepare('SELECT event_type, email, ip FROM auth_events ORDER BY id').all();
    assert.deepEqual(events.map((e) => [e.event_type, e.email, e.ip]), [
      ['password_reset_requested', 'session@example.com', IP],
      ['password_reset_requested', 'ghost@example.com', IP],
      ['login_failed', 'session@example.com', IP],
      ['login_failed', 'ghost@example.com', IP],
    ]);
  } finally { env.sqlite.close(); }
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
const digest = (token) => createHash('sha256').update(token).digest('hex');
import { SignJWT, jwtVerify } from 'jose';
import { onRequest, onRequestOptions } from '../functions/api/[[path]].js';
import { createAuthEnv } from './helpers/auth-env.mjs';

const webHeaders = { Origin: 'https://tagsta.sh', 'X-Tagstash-Client': 'web' };
const call = (env, path, { method = 'GET', headers = {}, body, origin = 'https://tagsta.sh' } = {}) =>
  onRequest({ env, request: new Request(`${origin}/api/${path}`, {
    method, headers: { 'Content-Type': 'application/json', ...headers },
    ...(body ? { body: JSON.stringify(body) } : {}),
  }) });
const login = (env, headers = webHeaders) => call(env, 'auth/login', {
  method: 'POST', headers, body: { email: 'session@example.com', password: env.password },
});
const cookieFrom = (response) => response.headers.get('Set-Cookie').split(';')[0];
const tokenFrom = (cookie) => cookie.slice(cookie.indexOf('=') + 1);

test('wrong passwords do not disclose unverified accounts; correct passwords get verification guidance', async () => {
  const env = await createAuthEnv();
  try {
    env.sqlite.exec('UPDATE users SET email_verified = 0');
    for (const email of ['session@example.com', 'missing@example.com']) {
      const response = await call(env, 'auth/login', { method: 'POST', body: { email, password: 'wrong-password' } });
      assert.equal(response.status, 401);
      assert.equal((await response.json()).error, 'Invalid email or password');
    }
    assert.equal(env.sqlite.prepare('SELECT failed_attempts FROM users').get().failed_attempts, 1);
    const response = await login(env);
    assert.equal(response.status, 403);
    assert.match((await response.json()).error, /verify your email/);
  } finally { env.sqlite.close(); }
});

test('email-token routes fail closed before migration, while login still works', async () => {
  const env = await createAuthEnv({ emailTokenHashes: false });
  try {
    for (const [path, method, body] of [
      ['auth/register', 'POST', { username: 'newuser', email: 'new@example.com', password: env.password }],
      ['auth/resend-verification', 'POST', { email: 'session@example.com' }],
      ['auth/verify-email?token=legacy', 'GET', undefined],
      ['auth/forgot-password', 'POST', { email: 'session@example.com' }],
      ['auth/reset-password', 'POST', { token: 'legacy', password: env.password }],
    ]) assert.equal((await call(env, path, { method, body, headers: webHeaders })).status, 503);
    assert.equal((await login(env)).status, 200);
    assert.equal(env.sqlite.prepare('SELECT COUNT(*) AS count FROM users').get().count, 1);
  } finally { env.sqlite.close(); }
});

test('email-token migration clears old secrets without removing users or passwords', async () => {
  const env = await createAuthEnv({ emailTokenHashes: false });
  try {
    for (const table of ['email_verification_tokens', 'password_reset_tokens']) {
      env.sqlite.prepare(`INSERT INTO ${table} (user_id, token, expires_at) VALUES (1, ?, ?)`).run('old-secret', '2099-01-01');
    }
    env.sqlite.exec(readFileSync(new URL('../d1/migrations/0013_email_token_hashes.sql', import.meta.url), 'utf8'));
    for (const table of ['email_verification_tokens', 'password_reset_tokens']) {
      assert.equal(env.sqlite.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get().count, 0);
    }
    assert.equal((await login(env)).status, 200);
  } finally { env.sqlite.close(); }
});

test('new emails store only digests; database digests are unusable as reset/verification links', async () => {
  const env = await createAuthEnv();
  const originalFetch = globalThis.fetch;
  const messages = [];
  globalThis.fetch = async (url, options) => {
    assert.match(String(url), /^https:\/\/api\.cloudflare\.com\//);
    messages.push(JSON.stringify(JSON.parse(options.body)));
    return Response.json({ success: true });
  };
  env.CLOUDFLARE_API_TOKEN = 'isolated-test';
  env.CLOUDFLARE_ACCOUNT_ID = 'isolated-test';
  try {
    for (const [path, body, table] of [
      ['auth/register', { username: 'newuser', email: 'new@example.com', password: env.password }, 'email_verification_tokens'],
      ['auth/forgot-password', { email: 'session@example.com' }, 'password_reset_tokens'],
      ['auth/resend-verification', { email: 'new@example.com' }, 'email_verification_tokens'],
    ]) {
      if (path.endsWith('resend-verification')) env.sqlite.exec("UPDATE email_verification_tokens SET created_at = datetime('now', '-2 minutes')");
      const response = await call(env, path, { method: 'POST', headers: webHeaders, body });
      assert.ok([200, 201].includes(response.status));
      const token = messages.at(-1).match(/token=([a-f0-9]{64})/)[1];
      const row = env.sqlite.prepare(`SELECT token, token_hash FROM ${table} WHERE token_hash = ?`).get(digest(token));
      assert.equal(row.token, 'sha256:' + row.token_hash);
      assert.notEqual(row.token_hash, token);
      const use = (value) => table === 'email_verification_tokens'
        ? call(env, `auth/verify-email?token=${value}`, { headers: webHeaders })
        : call(env, 'auth/reset-password', { method: 'POST', headers: webHeaders, body: { token: value, password: 'replacement-password' } });
      assert.equal((await use(row.token_hash)).status, 400);
      assert.equal((await use(row.token)).status, 400);
      assert.equal((await use(token)).status, 200);
      assert.equal((await use(token)).status, 400);
      if (table === 'email_verification_tokens') env.sqlite.exec("UPDATE users SET email_verified = 0 WHERE email = 'new@example.com'");
    }
  } finally { globalThis.fetch = originalFetch; env.sqlite.close(); }
});

test('web login issues a host-only, HttpOnly seven-day session without a JSON token', async () => {
  const env = await createAuthEnv();
  try {
    const response = await login(env);
    assert.equal(response.status, 200);
    assert.equal((await response.json()).token, undefined);
    const cookie = response.headers.get('Set-Cookie');
    assert.match(cookie, /^__Host-tagstash-session=/);
    for (const attribute of ['HttpOnly', 'Secure', 'SameSite=Lax', 'Path=/', 'Max-Age=604800']) assert.ok(cookie.includes(attribute));
    assert.ok(!cookie.includes('Domain='));
    const { payload } = await jwtVerify(tokenFrom(cookieFrom(response)), new TextEncoder().encode(env.JWT_SECRET));
    assert.equal(payload.exp - payload.iat, 604800);
    assert.equal(payload.session, 'web');
    assert.equal(response.headers.get('Cache-Control'), 'no-store');
    assert.equal((await call(env, 'auth/me', { headers: { ...webHeaders, Cookie: cookieFrom(response) } })).status, 200);
  } finally { env.sqlite.close(); }
});

test('CSRF rejects hostile, missing-origin and simple-form mutations before changing data', async () => {
  const env = await createAuthEnv();
  try {
    const cookie = cookieFrom(await login(env));
    for (const headers of [
      { Cookie: cookie },
      { Cookie: cookie, Origin: 'https://tagsta.sh' },
      { Cookie: cookie, 'X-Tagstash-Client': 'web' },
      { Cookie: cookie, 'X-Tagstash-Client': 'web', Origin: 'https://evil.example' },
      { Cookie: cookie, 'X-Tagstash-Client': 'web', Origin: 'null' },
      { Cookie: cookie, 'X-Tagstash-Client': 'web', Origin: 'moz-extension://test' },
    ]) {
      assert.equal((await call(env, 'auth/theme', { method: 'PUT', headers, body: { theme: 'light' } })).status, 403);
    }
    assert.equal(env.sqlite.prepare('SELECT theme FROM users').get().theme, null);
    assert.equal((await call(env, 'auth/theme', { method: 'PUT', headers: { ...webHeaders, Cookie: cookie }, body: { theme: 'light' } })).status, 200);
    assert.equal(env.sqlite.prepare('SELECT theme FROM users').get().theme, 'light');
    assert.equal((await login(env, { 'X-Tagstash-Client': 'web', Origin: 'https://evil.example' })).status, 403);
  } finally { env.sqlite.close(); }
});

test('extension bearer auth remains compatible, and cookie/bearer token types cannot be swapped', async () => {
  const env = await createAuthEnv();
  try {
    const response = await login(env, {});
    const { token } = await response.json();
    assert.ok(token);
    assert.equal(response.headers.get('Set-Cookie'), null);
    const { payload } = await jwtVerify(token, new TextEncoder().encode(env.JWT_SECRET));
    assert.equal(payload.exp - payload.iat, 60 * 86400);
    assert.equal((await call(env, 'auth/me', { headers: { Authorization: `Bearer ${token}` } })).status, 200);
    assert.equal((await call(env, 'auth/me', { headers: { Cookie: `__Host-tagstash-session=${token}` } })).status, 403);
    const cookie = cookieFrom(await login(env));
    assert.equal((await call(env, 'auth/me', { headers: { Authorization: `Bearer ${tokenFrom(cookie)}` } })).status, 403);
    // Cookie presence cannot force an explicit extension bearer request into web auth.
    assert.equal((await call(env, 'auth/theme', { method: 'PUT', headers: { Cookie: cookie, Authorization: `Bearer ${token}` }, body: { theme: 'light' } })).status, 200);
  } finally { env.sqlite.close(); }
});

test('legacy tokens upgrade to cookies and logout clears the session with matching attributes', async () => {
  const env = await createAuthEnv();
  try {
    const { token } = await (await login(env, {})).json();
    const upgraded = await call(env, 'auth/session', { method: 'POST', headers: { ...webHeaders, Authorization: `Bearer ${token}` } });
    assert.equal(upgraded.status, 200);
    assert.equal((await upgraded.json()).token, undefined);
    const cookie = cookieFrom(upgraded);
    const logout = await call(env, 'auth/logout', { method: 'POST', headers: { ...webHeaders, Cookie: cookie } });
    assert.match(logout.headers.get('Set-Cookie'), /^__Host-tagstash-session=;.*Max-Age=0; Secure$/);
    assert.equal((await call(env, 'auth/me')).status, 401);
    env.sqlite.exec('UPDATE users SET token_version = token_version + 1');
    assert.equal((await call(env, 'auth/session', { method: 'POST', headers: { ...webHeaders, Authorization: `Bearer ${token}` } })).status, 403);
  } finally { env.sqlite.close(); }
});

test('password change replaces the current cookie and revokes older web and extension sessions', async () => {
  const env = await createAuthEnv();
  try {
    const cookie = cookieFrom(await login(env));
    const { token } = await (await login(env, {})).json();
    const response = await call(env, 'auth/password', { method: 'PUT', headers: { ...webHeaders, Cookie: cookie },
      body: { currentPassword: env.password, newPassword: 'new-session-password', confirmPassword: 'new-session-password' } });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).token, undefined);
    assert.equal((await call(env, 'auth/me', { headers: { Cookie: cookie } })).status, 403);
    assert.equal((await call(env, 'auth/me', { headers: { Authorization: `Bearer ${token}` } })).status, 403);
    assert.equal((await call(env, 'auth/me', { headers: { Cookie: cookieFrom(response) } })).status, 200);
  } finally { env.sqlite.close(); }
});

test('expired sessions and deleted users cannot authenticate', async () => {
  const env = await createAuthEnv();
  try {
    const expired = await new SignJWT({ id: 1, tv: 0, session: 'web' }).setProtectedHeader({ alg: 'HS256' })
      .setExpirationTime(Math.floor(Date.now() / 1000) - 1).sign(new TextEncoder().encode(env.JWT_SECRET));
    assert.equal((await call(env, 'auth/me', { headers: { Cookie: `__Host-tagstash-session=${expired}` } })).status, 403);
    const cookie = cookieFrom(await login(env));
    env.sqlite.exec('DELETE FROM users WHERE id = 1');
    assert.equal((await call(env, 'auth/me', { headers: { Cookie: cookie } })).status, 403);
  } finally { env.sqlite.close(); }
});

test('verification issues no session; reset issues a cookie and revokes the previous session', async () => {
  const env = await createAuthEnv();
  try {
    const expiry = new Date(Date.now() + 3600000).toISOString();
    env.sqlite.exec('UPDATE users SET email_verified = 0');
    env.sqlite.prepare('INSERT INTO email_verification_tokens (user_id, token, token_hash, expires_at) VALUES (1, ?, ?, ?)').run('sha256:' + digest('verification-test'), digest('verification-test'), expiry);
    const verified = await call(env, 'auth/verify-email?token=verification-test', { headers: webHeaders });
    assert.equal(verified.status, 200);
    const verifiedBody = await verified.json();
    assert.equal(verifiedBody.token, undefined);
    assert.equal(verifiedBody.verified, true);
    assert.equal(verified.headers.get('Set-Cookie'), null);
    assert.equal(env.sqlite.prepare('SELECT email_verified FROM users WHERE id = 1').get().email_verified, 1);
    const login = await call(env, 'auth/login', { method: 'POST', headers: webHeaders, body: { email: 'session@example.com', password: env.password } });
    assert.equal(login.status, 200);
    const cookie = cookieFrom(login);
    assert.equal((await call(env, 'auth/me', { headers: { Cookie: cookie } })).status, 200);
    env.sqlite.prepare('INSERT INTO password_reset_tokens (user_id, token, token_hash, expires_at) VALUES (1, ?, ?, ?)').run('sha256:' + digest('reset-test'), digest('reset-test'), expiry);
    const reset = await call(env, 'auth/reset-password', { method: 'POST', headers: webHeaders, body: { token: 'reset-test', password: 'reset-session-password' } });
    assert.equal(reset.status, 200);
    assert.equal((await reset.json()).token, undefined);
    assert.equal((await call(env, 'auth/me', { headers: { Cookie: cookie } })).status, 403);
    assert.equal((await call(env, 'auth/me', { headers: { Cookie: cookieFrom(reset) } })).status, 200);
  } finally { env.sqlite.close(); }
});

test('Stripe webhook continues to use signature validation even if a session cookie is present', async () => {
  const env = await createAuthEnv();
  try {
    env.STRIPE_WEBHOOK_SECRET = 'isolated-webhook-secret';
    const response = await call(env, 'billing/webhook', { method: 'POST', headers: { Cookie: cookieFrom(await login(env)) }, body: {} });
    assert.equal(response.status, 400);
    assert.equal((await response.json()).error, 'Invalid webhook signature');
  } finally { env.sqlite.close(); }
});

test('CORS credentials only cover trusted web origins; public API retains wildcard', async () => {
  const env = await createAuthEnv();
  try {
    for (const origin of ['https://tagsta.sh', 'https://evil.example', 'moz-extension://test']) {
      const response = await onRequestOptions({ env, request: new Request('https://tagsta.sh/api/auth/login', { method: 'OPTIONS', headers: { Origin: origin } }) });
      assert.equal(response.headers.get('Access-Control-Allow-Credentials'), origin === 'https://tagsta.sh' ? 'true' : null);
      assert.match(response.headers.get('Access-Control-Allow-Headers'), /X-Tagstash-Client/);
      if (origin === 'https://evil.example') assert.equal(response.headers.get('Access-Control-Allow-Origin'), null);
    }
    const publicResponse = await call(env, 'profiles/missing', { headers: { Origin: 'https://evil.example' } });
    assert.equal(publicResponse.headers.get('Access-Control-Allow-Origin'), '*');
    assert.equal(publicResponse.headers.get('Access-Control-Allow-Credentials'), null);
  } finally { env.sqlite.close(); }
});

test('localhost proxy supports cookies without permitting insecure remote-host cookies', async () => {
  const env = await createAuthEnv();
  try {
    const response = await call(env, 'auth/login', { method: 'POST', origin: 'http://127.0.0.1:5000',
      headers: { 'X-Tagstash-Client': 'web', Origin: 'http://localhost:3000' }, body: { email: 'session@example.com', password: env.password } });
    assert.equal(response.status, 200);
    assert.match(response.headers.get('Set-Cookie'), /^tagstash-session=/);
    assert.ok(!response.headers.get('Set-Cookie').includes('Secure'));
    const remote = await call(env, 'auth/login', { method: 'POST', origin: 'http://example.test',
      headers: { 'X-Tagstash-Client': 'web', Origin: 'http://example.test' }, body: { email: 'session@example.com', password: env.password } });
    assert.match(remote.headers.get('Set-Cookie'), /^__Host-tagstash-session=.*; Secure$/);
  } finally { env.sqlite.close(); }
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { createAuthEnv } from './helpers/auth-env.mjs';
import { call, loginHeaders } from './helpers/api.mjs';

const webHeaders = { Origin: 'https://tagsta.sh', 'X-Tagstash-Client': 'web' };
const login = (env) => call(env, 'auth/login', {
  method: 'POST', headers: webHeaders, body: { email: 'session@example.com', password: env.password },
});
const cookieFrom = (response) => response.headers.get('Set-Cookie').split(';')[0];
const webSession = async (env) => ({ ...webHeaders, Cookie: cookieFrom(await login(env)) });
const signOut = (env, headers) => call(env, 'auth/logout-everywhere', { method: 'POST', headers });

test('sign out everywhere revokes all old cookies and extension JWTs, preserves API keys and permits fresh login', async () => {
  const env = await createAuthEnv();
  try {
    const first = await webSession(env);
    const second = await webSession(env);
    const extension = await loginHeaders(env);
    const created = await call(env, 'auth/api-keys', { method: 'POST', headers: first, body: { name: 'Separate credential' } });
    assert.equal(created.status, 201);
    const keysBefore = env.sqlite.prepare('SELECT * FROM api_keys').all();
    // Another account must keep its version and credentials.
    env.sqlite.exec("INSERT INTO users (username, email, password_hash, email_verified, token_version) SELECT 'other', 'other@example.com', password_hash, 1, 7 FROM users WHERE id = 1");

    const response = await signOut(env, first);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { message: 'Signed out of all devices' });
    assert.match(response.headers.get('Set-Cookie'), /^__Host-tagstash-session=;.*Max-Age=0; Secure$/);
    assert.equal(response.headers.get('Cache-Control'), 'no-store');
    assert.equal(env.sqlite.prepare('SELECT token_version FROM users WHERE id = 1').get().token_version, 1);
    assert.equal(env.sqlite.prepare('SELECT token_version FROM users WHERE id = 2').get().token_version, 7);
    assert.deepEqual(env.sqlite.prepare('SELECT * FROM api_keys').all(), keysBefore);
    assert.equal(env.sqlite.prepare("SELECT user_id FROM auth_events WHERE event_type = 'logout_everywhere'").get().user_id, 1);
    for (const headers of [first, second, extension]) {
      assert.equal((await call(env, 'auth/me', { headers })).status, 403);
      assert.equal((await call(env, 'bookmarks', { headers })).status, 403);
    }
    assert.equal((await signOut(env, first)).status, 403);
    assert.equal((await call(env, 'auth/me', { headers: await webSession(env) })).status, 200);
    assert.equal((await call(env, 'auth/me', { headers: await loginHeaders(env) })).status, 200);
  } finally { env.sqlite.close(); }
});

test('sign out everywhere requires a web cookie session, refusing anonymous, bearer and API-key calls', async () => {
  const env = await createAuthEnv();
  try {
    assert.equal((await signOut(env, webHeaders)).status, 401);
    const extension = await loginHeaders(env);
    assert.equal((await signOut(env, extension)).status, 403);
    assert.equal((await signOut(env, { ...extension, ...webHeaders })).status, 403);
    const cookie = await webSession(env);
    const created = await call(env, 'auth/api-keys', { method: 'POST', headers: cookie, body: { name: 'No session authority' } });
    const { apiKey: key } = await created.json();
    assert.equal(typeof key, 'string');
    for (const headers of [{ Authorization: `Bearer ${key}` }, { ...cookie, Authorization: `Bearer ${key}` }]) {
      assert.equal((await signOut(env, headers)).status, 403);
    }
    assert.equal(env.sqlite.prepare('SELECT token_version FROM users').get().token_version, 0);
  } finally { env.sqlite.close(); }
});

test('the dispatcher rejects missing web headers and hostile origins before revocation', async () => {
  const env = await createAuthEnv();
  try {
    const { Cookie } = await webSession(env);
    for (const headers of [
      { Cookie },
      { Cookie, Origin: webHeaders.Origin },
      { Cookie, 'X-Tagstash-Client': 'web' },
      { Cookie, ...webHeaders, Origin: 'https://evil.example' },
      { Cookie, ...webHeaders, Origin: 'moz-extension://test' },
    ]) assert.equal((await signOut(env, headers)).status, 403);
    assert.equal(env.sqlite.prepare('SELECT token_version FROM users').get().token_version, 0);
    assert.equal((await call(env, 'auth/me', { headers: { ...webHeaders, Cookie } })).status, 200);
  } finally { env.sqlite.close(); }
});

test('sign out everywhere fails closed without token_version and leaves the current cookie intact', async () => {
  const env = await createAuthEnv();
  try {
    env.sqlite.exec('ALTER TABLE users DROP COLUMN token_version');
    const headers = await webSession(env);
    const response = await signOut(env, headers);
    assert.equal(response.status, 503);
    assert.equal(response.headers.get('Set-Cookie'), null);
    assert.equal((await call(env, 'auth/me', { headers })).status, 200);
  } finally { env.sqlite.close(); }
});

test('a failed version bump does not clear the cookie or log success', async () => {
  const env = await createAuthEnv();
  try {
    const headers = await webSession(env);
    env.sqlite.exec("CREATE TRIGGER refuse_bump BEFORE UPDATE OF token_version ON users BEGIN SELECT RAISE(ABORT, 'test failure'); END");
    const response = await signOut(env, headers);
    assert.equal(response.status, 500);
    assert.equal(response.headers.get('Set-Cookie'), null);
    assert.equal(env.sqlite.prepare("SELECT COUNT(*) AS n FROM auth_events WHERE event_type = 'logout_everywhere'").get().n, 0);
    assert.equal((await call(env, 'auth/me', { headers })).status, 200);
  } finally { env.sqlite.close(); }
});

test('simultaneous sign-outs increment token_version atomically', async () => {
  const env = await createAuthEnv({ queryLatency: true });
  try {
    const headers = await webSession(env);
    const responses = await Promise.all([signOut(env, headers), signOut(env, headers)]);
    // JWT verification timing decides whether the second request reads token_version before or
    // after the first bump (a 403 is correct then); either way no increment may be lost.
    const statuses = responses.map((r) => r.status);
    assert.ok(statuses.every((s) => s === 200 || s === 403), `unexpected statuses ${statuses}`);
    const succeeded = statuses.filter((s) => s === 200).length;
    assert.ok(succeeded >= 1);
    assert.equal(env.sqlite.prepare('SELECT token_version FROM users').get().token_version, succeeded);
    assert.equal((await call(env, 'auth/me', { headers })).status, 403);
    assert.equal((await call(env, 'auth/me', { headers: await webSession(env) })).status, 200);
  } finally { env.sqlite.close(); }
});

test('ordinary logout continues to clear only the cookie without revoking copied credentials', async () => {
  const env = await createAuthEnv();
  try {
    const headers = await webSession(env);
    const extension = await loginHeaders(env);
    const response = await call(env, 'auth/logout', { method: 'POST', headers });
    assert.equal(response.status, 200);
    assert.match(response.headers.get('Set-Cookie'), /Max-Age=0/);
    assert.equal(env.sqlite.prepare('SELECT token_version FROM users').get().token_version, 0);
    for (const credential of [headers, extension]) {
      assert.equal((await call(env, 'auth/me', { headers: credential })).status, 200);
    }
  } finally { env.sqlite.close(); }
});

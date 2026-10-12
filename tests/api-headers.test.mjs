import test from 'node:test';
import assert from 'node:assert/strict';
import { onRequest, onRequestOptions } from '../functions/api/[[path]].js';
import { createAuthEnv } from './helpers/auth-env.mjs';

const request = (path, { method = 'GET', headers = {}, body, origin = 'https://tagsta.sh' } = {}) =>
  new Request(`${origin}/api/${path}`, {
    method, headers: { 'Content-Type': 'application/json', ...headers },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });

const assertHardened = (response, label, { https = true } = {}) => {
  assert.equal(response.headers.get('X-Content-Type-Options'), 'nosniff', label);
  assert.equal(response.headers.get('Referrer-Policy'), 'no-referrer', label);
  assert.equal(response.headers.get('X-Frame-Options'), 'DENY', label);
  assert.equal(response.headers.get('Content-Security-Policy'), "default-src 'none'; frame-ancestors 'none'", label);
  assert.equal(response.headers.get('Cache-Control'), 'no-store', label);
  assert.equal(response.headers.get('Vary'), 'Origin', label);
  if (https) {
    assert.equal(response.headers.get('Strict-Transport-Security'), 'max-age=63072000; includeSubDomains', label);
    assert.doesNotMatch(response.headers.get('Strict-Transport-Security'), /preload/, label);
  } else {
    assert.equal(response.headers.get('Strict-Transport-Security'), null, label);
  }
};

test('every API response path carries the security headers, no-store and CORS', async () => {
  const env = await createAuthEnv();
  const realError = console.error;
  console.error = () => {};
  try {
    const cases = [
      ['health (no DB needed)', request('health'), 200],
      ['unknown route', request('nope'), 404],
      ['missing auth', request('auth/me'), 401],
      ['invalid token', request('auth/me', { headers: { Authorization: 'Bearer not-a-jwt' } }), 403],
      ['web request from a hostile origin', request('auth/login', { method: 'POST', headers: { Origin: 'https://evil.example', 'X-Tagstash-Client': 'web' }, body: {} }), 403],
      ['bad input', request('auth/login', { method: 'POST', body: {} }), 400],
      ['public profile', request('profiles/nobody', { headers: { Origin: 'https://example.com' } }), 404],
    ];
    for (const [label, req, status] of cases) {
      const response = await onRequest({ env, request: req });
      assert.equal(response.status, status, label);
      assert.match(response.headers.get('Content-Type'), /application\/json/, label);
      assertHardened(response, label);
    }

    // A handler that throws is still answered through the same wrapper.
    const broken = {
      DB: { prepare: () => ({ bind() { return this; }, async first() { throw new Error('boom'); }, async all() { return { results: [{ name: 'profile_public' }, { name: 'is_private' }] }; } }) },
    };
    const crashed = await onRequest({ env: broken, request: request('profiles/someone') });
    assert.equal(crashed.status, 500);
    assertHardened(crashed, 'handler error');
    assert.equal(crashed.headers.get('Access-Control-Allow-Origin'), '*');

    // Successful web login: the session cookie response keeps no-store and gains the headers.
    const login = await onRequest({ env, request: request('auth/login', {
      method: 'POST', headers: { Origin: 'https://tagsta.sh', 'X-Tagstash-Client': 'web' },
      body: { email: 'session@example.com', password: env.password },
    }) });
    assert.equal(login.status, 200);
    assert.ok(login.headers.get('Set-Cookie'));
    assertHardened(login, 'web login');
    assert.equal(login.headers.get('Access-Control-Allow-Credentials'), 'true');
  } finally { console.error = realError; env.sqlite.close(); }
});

test('preflights carry the security headers without changing the CORS allowlist or public wildcard', async () => {
  const env = await createAuthEnv();
  try {
    const preflight = (path, origin) => onRequestOptions({ env, request: new Request(`https://tagsta.sh/api/${path}`, {
      method: 'OPTIONS', headers: { Origin: origin, 'Access-Control-Request-Method': 'POST' },
    }) });

    const trusted = await preflight('auth/login', 'https://tagsta.sh');
    assert.equal(trusted.status, 204);
    assertHardened(trusted, 'trusted preflight');
    assert.equal(trusted.headers.get('Access-Control-Allow-Origin'), 'https://tagsta.sh');
    assert.equal(trusted.headers.get('Access-Control-Allow-Credentials'), 'true');

    const hostile = await preflight('auth/login', 'https://evil.example');
    assertHardened(hostile, 'hostile preflight');
    assert.equal(hostile.headers.get('Access-Control-Allow-Origin'), null);
    assert.equal(hostile.headers.get('Access-Control-Allow-Credentials'), null);

    const publicApi = await preflight('profiles/someone', 'https://example.com');
    assertHardened(publicApi, 'public profile preflight');
    assert.equal(publicApi.headers.get('Access-Control-Allow-Origin'), '*');
    assert.equal(publicApi.headers.get('Access-Control-Allow-Credentials'), null);
  } finally { env.sqlite.close(); }
});

test('local HTTP development gets the headers but no HSTS', async () => {
  const env = await createAuthEnv();
  try {
    const response = await onRequest({ env, request: request('health', { origin: 'http://127.0.0.1:5105' }) });
    assert.equal(response.status, 200);
    assertHardened(response, 'local http', { https: false });
    const preflight = await onRequestOptions({ env, request: new Request('http://localhost:5105/api/auth/login', { method: 'OPTIONS', headers: { Origin: 'http://localhost:3000' } }) });
    assertHardened(preflight, 'local preflight', { https: false });
  } finally { env.sqlite.close(); }
});

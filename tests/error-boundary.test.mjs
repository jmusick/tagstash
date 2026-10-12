import test from 'node:test';
import assert from 'node:assert/strict';
import { onRequest } from '../functions/api/[[path]].js';
import { onRequestGet } from '../functions/u/[username].js';
import { createAuthEnv } from './helpers/auth-env.mjs';

const call = (env, path, { method = 'GET', headers = {}, body } = {}) =>
  onRequest({ env, request: new Request(`https://tagsta.sh/api/${path}`, {
    method, headers: { 'Content-Type': 'application/json', ...headers },
    ...(body ? { body: JSON.stringify(body) } : {}),
  }) });

test('a rejected handler is caught and answered with generic JSON, no-store and CORS', async () => {
  const env = {
    DB: {
      prepare: () => ({
        bind() { return this; },
        async first() { throw new Error('D1 internal detail'); },
        async all() { return { results: [{ name: 'profile_public' }, { name: 'is_private' }] }; },
      }),
    },
  };
  const realError = console.error;
  console.error = () => {};
  try {
    const response = await call(env, 'profiles/someone', { headers: { Origin: 'https://example.com' } });
    assert.equal(response.status, 500);
    assert.deepEqual(await response.json(), { error: 'Something went wrong!' });
    assert.equal(response.headers.get('Cache-Control'), 'no-store');
    assert.equal(response.headers.get('Access-Control-Allow-Origin'), '*');
  } finally { console.error = realError; }
});

test('malformed percent-encoding in a profile name is a 404, not a crash', async () => {
  const env = await createAuthEnv();
  try {
    const response = await call(env, 'profiles/%E0%A4%A');
    assert.equal(response.status, 404);
    assert.deepEqual(await response.json(), { error: 'Not found' });
  } finally { env.sqlite.close(); }

  globalThis.HTMLRewriter = class {
    constructor() { this.handlers = {}; }
    on(selector, handler) { this.handlers[selector] = handler; return this; }
    async transform(response) {
      let appended = '';
      this.handlers.head?.element({ append: (content) => { appended += content; } });
      return new Response((await response.text()).replace('</head>', `${appended}</head>`), response);
    }
  };
  const page = await onRequestGet({
    request: new Request('https://tagsta.sh/u/%E0%A4%A'),
    env: {},
    params: { username: '%E0%A4%A' },
    next: async () => new Response('<html><head></head></html>', { headers: { 'Content-Type': 'text/html' } }),
  });
  assert.equal(page.status, 200);
  assert.match(await page.text(), /<meta name="robots" content="noindex" \/>/);
});

test('non-string passwords are rejected as bad input', async () => {
  const env = await createAuthEnv();
  try {
    const register = await call(env, 'auth/register', {
      method: 'POST', body: { username: 'someone', email: 'someone@example.com', password: { length: 99 } },
    });
    assert.equal(register.status, 400);
    const login = await call(env, 'auth/login', {
      method: 'POST', body: { email: 'session@example.com', password: ['x'] },
    });
    assert.equal(login.status, 400);
  } finally { env.sqlite.close(); }
});

test('non-string tags are skipped on import and on create', async () => {
  const env = await createAuthEnv();
  try {
    const login = await call(env, 'auth/login', {
      method: 'POST', body: { email: 'session@example.com', password: env.password },
    });
    const { token } = await login.json();
    const headers = { Authorization: `Bearer ${token}` };

    const imported = await call(env, 'bookmarks/import', {
      method: 'POST', headers,
      body: { bookmarks: [{ title: 'Example', url: 'https://example.com/', tags: [42, null, 'kept'] }] },
    });
    assert.equal(imported.status, 200, await imported.clone().text());
    assert.equal((await imported.json()).imported, 1);

    const created = await call(env, 'bookmarks', {
      method: 'POST', headers,
      body: { title: 'Other', url: 'https://example.org/', tags: [{}, 'also-kept'] },
    });
    assert.equal(created.status, 201, await created.clone().text());

    const names = env.sqlite.prepare('SELECT name FROM tags ORDER BY name').all().map((row) => row.name);
    assert.deepEqual(names, ['also-kept', 'kept']);
  } finally { env.sqlite.close(); }
});

test('resend-verification keeps its generic answer when the email cannot be sent', async () => {
  const env = await createAuthEnv();
  const realError = console.error;
  console.error = () => {};
  try {
    env.sqlite.exec('UPDATE users SET email_verified = 0');
    const response = await call(env, 'auth/resend-verification', {
      method: 'POST', body: { email: 'session@example.com' },
    });
    assert.equal(response.status, 200);
    assert.match((await response.json()).message, /If that address is awaiting verification/);
  } finally { console.error = realError; env.sqlite.close(); }
});

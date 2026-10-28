import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import bcrypt from 'bcryptjs';
import { createAuthEnv } from './helpers/auth-env.mjs';
import { call, loginHeaders } from './helpers/api.mjs';
import { RESERVED_USERNAMES, newUsernameError } from '../src/utils/usernamePolicy.js';

// [username, accepted]
const CASES = [
  ['ab', true],
  ['Alice', true],
  ['john.doe', true],
  ['jane_doe-99', true],
  ['a.b-c_d', true],
  ['7', false],
  ['a'.repeat(50), true],
  ['a'.repeat(51), false],
  ['has space', false],
  ['a/b', false],
  ['what?', false],
  ['tag#1', false],
  ['50%off', false],
  ['zero​width', false],
  ['аdmin', false], // Cyrillic а
  ['émile', false],
  ['.leading', false],
  ['trailing-', false],
  ['_x', false],
  ['double..dot', false],
  ['mixed._run', false],
  ['admin', false],
  ['Admin', false],
  ['TAGSTASH', false],
  ['u', false],
  ['api', false],
  ['settings', false],
  ['verify-email', false],
  ['admin2', true],
];

test('newUsernameError accepts only ASCII letters, digits and single inner . _ -, and no reserved names', () => {
  for (const [username, accepted] of CASES) {
    assert.equal(newUsernameError(username) === null, accepted, JSON.stringify(username));
  }
  assert.equal(newUsernameError(''), 'Username is required');
  assert.equal(newUsernameError(undefined), 'Username is required');
  assert.equal(newUsernameError('admin'), 'That username is reserved');
});

test('reserved names cover the issue list and are stored lowercase', () => {
  for (const name of ['admin', 'support', 'tagstash', 'api', 'u']) assert.ok(RESERVED_USERNAMES.has(name), name);
  for (const name of RESERVED_USERNAMES) assert.equal(name, name.toLowerCase(), name);
});

test('reserved names include every top-level app route', async () => {
  const app = await readFile(new URL('../src/App.jsx', import.meta.url), 'utf8');
  const routes = [...app.matchAll(/path="\/([a-z-]+)"/g)].map(([, name]) => name);
  assert.ok(routes.length > 5, 'found the routes');
  for (const route of routes) assert.ok(RESERVED_USERNAMES.has(route), route);
});

test('register refuses usernames outside the policy before touching the database', async () => {
  const env = await createAuthEnv();
  try {
    for (const username of ['a/b', 'support', '.dot', 'zero​width']) {
      const response = await call(env, 'auth/register', {
        method: 'POST', body: { username, email: 'new@example.com', password: 'a-long-enough-password' },
      });
      assert.equal(response.status, 400, username);
      assert.equal((await response.json()).error, newUsernameError(username));
    }
    assert.equal(env.sqlite.prepare('SELECT COUNT(*) AS n FROM users').get().n, 1);
  } finally { env.sqlite.close(); }
});

test('a rename must meet the policy', async () => {
  const env = await createAuthEnv();
  try {
    const headers = await loginHeaders(env);
    const rename = (newUsername) => call(env, 'auth/username', {
      method: 'PUT', headers, body: { newUsername, password: env.password },
    });
    for (const username of ['a/b', 'Admin', 'trailing.', 'tab\there']) {
      const response = await rename(username);
      assert.equal(response.status, 400, username);
      assert.equal((await response.json()).error, newUsernameError(username));
    }
    const ok = await rename('session.tester');
    assert.equal(ok.status, 200);
    assert.equal((await ok.json()).user.username, 'session.tester');
  } finally { env.sqlite.close(); }
});

test('grandfathered usernames keep signing in and serving their profile, but must rename into the policy', async () => {
  const env = await createAuthEnv();
  try {
    const legacy = 'old/name?';
    env.sqlite.prepare('INSERT INTO users (username, email, password_hash, email_verified, profile_public) VALUES (?, ?, ?, 1, 1)')
      .run(legacy, 'legacy@example.com', await bcrypt.hash(env.password, 4));

    const login = await call(env, 'auth/login', { method: 'POST', body: { email: 'legacy@example.com', password: env.password } });
    assert.equal(login.status, 200);
    const { token } = await login.json();
    const headers = { Authorization: `Bearer ${token}` };

    const me = await call(env, 'auth/me', { headers });
    assert.equal((await me.json()).user.username, legacy);

    const profile = await call(env, `profiles/${encodeURIComponent(legacy)}`);
    assert.equal(profile.status, 200);

    const refused = await call(env, 'auth/username', { method: 'PUT', headers, body: { newUsername: 'old/name', password: env.password } });
    assert.equal(refused.status, 400);

    const renamed = await call(env, 'auth/username', { method: 'PUT', headers, body: { newUsername: 'old-name', password: env.password } });
    assert.equal(renamed.status, 200);
  } finally { env.sqlite.close(); }
});

test('the API and both forms use the shared username policy', async () => {
  const read = (path) => readFile(new URL(path, import.meta.url), 'utf8');
  const api = await read('../functions/api/[[path]].js');
  assert.match(api, /import \{ newUsernameError \} from '\.\.\/\.\.\/src\/utils\/usernamePolicy\.js';/);
  assert.equal((api.match(/newUsernameError\(trimmedUsername\)/g) || []).length, 2, 'register and rename');
  for (const form of ['../src/components/Home.jsx', '../src/components/Settings.jsx']) {
    assert.match(await read(form), /newUsernameError\(/, form);
  }
});

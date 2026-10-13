import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import bcrypt from 'bcryptjs';
import { createAuthEnv } from './helpers/auth-env.mjs';
import { call, loginHeaders } from './helpers/api.mjs';
import { newPasswordError } from '../src/utils/passwordPolicy.js';

const sha1 = (value) => createHash('sha1').update(value, 'utf8').digest('hex').toUpperCase();
const bytes = (value) => Buffer.byteLength(value, 'utf8');
const pwnedMiss = async () => new Response('0000000000000000000000000000000000A:0\r\n0000000000000000000000000000000000B:3\r\n');
const pwnedHit = (password, count = 42) => async () =>
  new Response(`0000000000000000000000000000000000A:1\r\n${sha1(password).slice(5)}:${count}\r\n`);
const emailOk = async () => Response.json({ success: true });

// Route outgoing fetches by host and record them. `timeoutMs` shortens AbortSignal.timeout so the
// 3-second Pwned Passwords deadline is exercised for real but quickly.
const withUpstreams = async ({ pwned = pwnedMiss, email = emailOk, timeoutMs } = {}, run) => {
  const realFetch = globalThis.fetch;
  const realTimeout = AbortSignal.timeout;
  const calls = [];
  const deadlines = [];
  if (timeoutMs) AbortSignal.timeout = (ms) => { deadlines.push(ms); return realTimeout.call(AbortSignal, timeoutMs); };
  globalThis.fetch = async (url, options = {}) => {
    const { host, pathname } = new URL(String(url));
    calls.push({ url: String(url), host, pathname, options });
    if (host === 'api.pwnedpasswords.com') return pwned({ pathname, options });
    if (host === 'api.cloudflare.com') return email({ options });
    throw new Error(`unexpected fetch to ${host}`);
  };
  try { return await run({ calls, deadlines }); } finally {
    globalThis.fetch = realFetch;
    AbortSignal.timeout = realTimeout;
  }
};

const captureLogs = async (run) => {
  const lines = [];
  const real = { log: console.log, warn: console.warn, error: console.error, info: console.info };
  for (const level of Object.keys(real)) console[level] = (...args) => lines.push(args.map(String).join(' '));
  try { await run(); } finally { Object.assign(console, real); }
  return lines.join('\n');
};

const emailEnv = async () => Object.assign(await createAuthEnv(), { CLOUDFLARE_API_TOKEN: 'isolated-test', CLOUDFLARE_ACCOUNT_ID: 'isolated-test' });

let registrations = 0;
const register = (env, password) => {
  registrations += 1;
  return call(env, 'auth/register', {
    method: 'POST', body: { username: `policy${registrations}`, email: `policy${registrations}@example.com`, password },
  });
};

// [label, password, accepted]
const BOUNDARIES = [
  ['7 ASCII characters', 'a'.repeat(7), false],
  ['8 ASCII characters', 'a'.repeat(8), true],
  ['7 emoji (14 UTF-16 units, but 7 characters)', '😀'.repeat(7), false],
  ['8 emoji (32 bytes)', '😀'.repeat(8), true],
  ['72 ASCII bytes', 'a'.repeat(72), true],
  ['73 ASCII bytes', 'a'.repeat(73), false],
  ['36 two-byte characters = 72 bytes', 'é'.repeat(36), true],
  ['37 characters but 73 bytes', `${'é'.repeat(36)}a`, false],
  ['two-byte character ending exactly at byte 72', `${'a'.repeat(70)}é`, true],
  ['two-byte character straddling byte 72', `${'a'.repeat(71)}é`, false],
  ['three-byte characters = 72 bytes', '€'.repeat(24), true],
  ['three-byte character straddling byte 72', `${'a'.repeat(70)}€`, false],
  ['four-byte emoji ending exactly at byte 72', `${'a'.repeat(68)}😀`, true],
  ['four-byte emoji straddling byte 72', `${'a'.repeat(69)}😀`, false],
];

test('the new-password policy counts characters for the minimum and UTF-8 bytes for the maximum', async () => {
  const env = await emailEnv();
  try {
    await withUpstreams({}, async () => {
      for (const [label, password, accepted] of BOUNDARIES) {
        assert.equal(bytes(password) <= 72 && [...password].length >= 8, accepted, `fixture: ${label}`);
        const response = await register(env, password);
        assert.equal(response.status, accepted ? 201 : 400, label);
        if (!accepted) {
          const { error } = await response.json();
          assert.match(error, [...password].length < 8 ? /at least 8 characters/ : /72 bytes/, label);
        }
        // The client mirror agrees with the server on every boundary.
        assert.equal(newPasswordError(password) === null, accepted, `client: ${label}`);
      }
    });
  } finally { env.sqlite.close(); }
});

test('password change and password reset enforce the same policy', async () => {
  const env = await emailEnv();
  try {
    const headers = await loginHeaders(env);
    const change = (newPassword) => call(env, 'auth/password', {
      method: 'PUT', headers, body: { currentPassword: env.password, newPassword, confirmPassword: newPassword },
    });
    const digest = (token) => createHash('sha256').update(token).digest('hex');
    env.sqlite.prepare('INSERT INTO password_reset_tokens (user_id, token, token_hash, expires_at) VALUES (1, ?, ?, ?)')
      .run(`sha256:${digest('policy-token')}`, digest('policy-token'), new Date(Date.now() + 3600000).toISOString());
    const reset = (password) => call(env, 'auth/reset-password', { method: 'POST', body: { token: 'policy-token', password } });

    await withUpstreams({}, async () => {
      for (const [label, password, accepted] of BOUNDARIES.filter(([, , ok]) => !ok)) {
        const changed = await change(password);
        assert.equal(changed.status, 400, `change: ${label}`);
        assert.match((await changed.json()).error, /^New password (must be at least 8|is too long)/, `change: ${label}`);
        assert.equal((await reset(password)).status, 400, `reset: ${label}`);
        assert.equal(accepted, false);
      }
      // A refused reset leaves its link usable.
      assert.equal(env.sqlite.prepare('SELECT used_at FROM password_reset_tokens').get().used_at, null);
      assert.equal((await reset('é'.repeat(36))).status, 200);
      assert.ok(await bcrypt.compare('é'.repeat(36), env.sqlite.prepare('SELECT password_hash FROM users WHERE id = 1').get().password_hash));
    });
  } finally { env.sqlite.close(); }
});

test('grandfathered passwords of any length still sign in and still confirm sensitive changes', async () => {
  const env = await createAuthEnv();
  try {
    // Set before this policy: 5 and 6 characters (old minimum), 256 characters (the old cap) and
    // 2000 characters (before there was any cap).
    const legacy = {
      'short@example.com': 'abc12',
      'sixer@example.com': 'abc123',
      'capped@example.com': 'L'.repeat(256),
      'huge@example.com': `${'é'.repeat(1000)}`,
    };
    for (const [email, password] of Object.entries(legacy)) {
      env.sqlite.prepare('INSERT INTO users (username, email, password_hash, email_verified) VALUES (?, ?, ?, 1)')
        .run(email.split('@')[0], email, await bcrypt.hash(password, 4));
    }
    for (const [email, password] of Object.entries(legacy)) {
      const response = await call(env, 'auth/login', { method: 'POST', body: { email, password } });
      assert.equal(response.status, 200, `${email} signs in with its old password`);
    }

    // Re-entry (confirmCurrentPassword) accepts them too: a short legacy password can change the
    // username without first being forced through the new policy.
    const login = await call(env, 'auth/login', { method: 'POST', body: { email: 'short@example.com', password: 'abc12' } });
    const { token } = await login.json();
    const renamed = await call(env, 'auth/username', {
      method: 'PUT', headers: { Authorization: `Bearer ${token}` }, body: { newUsername: 'shorty', password: 'abc12' },
    });
    assert.equal(renamed.status, 200);

    // A wrong guess is still just a wrong guess.
    const wrong = await call(env, 'auth/login', { method: 'POST', body: { email: 'short@example.com', password: 'abc13' } });
    assert.equal(wrong.status, 401);
  } finally { env.sqlite.close(); }
});

test('the API enforces the same length policy module the web forms import', async () => {
  const source = await readFile(new URL('../functions/api/[[path]].js', import.meta.url), 'utf8');
  assert.match(source, /import \{ newPasswordError \} from '\.\.\/\.\.\/src\/utils\/passwordPolicy\.js';/);
  assert.match(source, /const passwordPolicyError = newPasswordError;/);
  for (const setter of ['register', 'password', 'reset-password']) {
    assert.ok(source.includes(`segments[1] === '${setter}'`), setter);
  }
  assert.equal((source.match(/await validateNewPassword\(/g) || []).length, 3, 'register, change and reset');
  assert.equal((source.match(/bcrypt\.hash\(/g) || []).length, 3, 'no other route sets a password');
});

test('Pwned Passwords: a hit is refused, a miss or a padding row is accepted, and only the hash prefix is sent', async () => {
  const env = await emailEnv();
  try {
    const breached = 'correct horse battery';
    const logs = await captureLogs(() => withUpstreams({ pwned: pwnedHit(breached) }, async ({ calls }) => {
      const response = await register(env, breached);
      assert.equal(response.status, 400);
      assert.match((await response.json()).error, /known data breach/);

      const [lookup] = calls.filter((c) => c.host === 'api.pwnedpasswords.com');
      assert.equal(lookup.url, `https://api.pwnedpasswords.com/range/${sha1(breached).slice(0, 5)}`);
      assert.equal(new Headers(lookup.options.headers).get('Add-Padding'), 'true');
      assert.equal(lookup.options.body, undefined);
      const sent = JSON.stringify({ url: lookup.url, headers: lookup.options.headers });
      for (const secret of [breached, sha1(breached), sha1(breached).slice(5)]) {
        assert.ok(!sent.includes(secret), 'nothing but the 5-character prefix leaves the Worker');
      }
      // A refused password created nothing.
      assert.equal(env.sqlite.prepare('SELECT COUNT(*) AS n FROM users').get().n, 1);
    }));
    for (const secret of [breached, sha1(breached), sha1(breached).slice(5)]) {
      assert.ok(!logs.includes(secret), 'the password, its hash and its suffix are never logged');
    }

    await withUpstreams({ pwned: pwnedMiss }, async () => {
      assert.equal((await register(env, 'unbreached passphrase')).status, 201);
    });
    // Padding rows carry a count of 0 and are not breaches, even when the suffix matches.
    await withUpstreams({ pwned: pwnedHit('padded passphrase', 0) }, async () => {
      assert.equal((await register(env, 'padded passphrase')).status, 201);
    });
  } finally { env.sqlite.close(); }
});

test('Pwned Passwords fails open on timeout, network failure or a bad response, without logging secrets', async () => {
  const env = await emailEnv();
  try {
    const hang = ({ options }) => new Promise((_, reject) => {
      options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true });
    });
    const outcomes = [
      ['timeout', hang],
      ['network failure', async () => { throw new TypeError('fetch failed'); }],
      ['HTTP 503', async () => new Response('busy', { status: 503 })],
    ];
    for (const [label, pwned] of outcomes) {
      const password = `fail-open ${label}`;
      const logs = await captureLogs(() => withUpstreams({ pwned, timeoutMs: 25 }, async ({ deadlines }) => {
        const started = Date.now();
        assert.equal((await register(env, password)).status, 201, label);
        assert.equal(deadlines[0], 3000, `${label}: the check has its own 3-second deadline`);
        assert.ok(Date.now() - started < 2000, `${label}: answered without waiting on the check`);
      }));
      assert.match(logs, /Pwned Passwords check skipped/, label);
      for (const secret of [password, sha1(password)]) assert.ok(!logs.includes(secret), label);
    }
  } finally { env.sqlite.close(); }
});

test('password change and reset run the breach check too (after the current password / a live link)', async () => {
  const env = await emailEnv();
  try {
    const headers = await loginHeaders(env);
    const breached = 'password1234';
    await withUpstreams({ pwned: pwnedHit(breached) }, async ({ calls }) => {
      const wrongCurrent = await call(env, 'auth/password', {
        method: 'PUT', headers, body: { currentPassword: 'not-the-password', newPassword: breached, confirmPassword: breached },
      });
      assert.equal(wrongCurrent.status, 401);
      assert.equal(calls.length, 0, 'no breach lookup before the current password is proved');
      const changed = await call(env, 'auth/password', {
        method: 'PUT', headers, body: { currentPassword: env.password, newPassword: breached, confirmPassword: breached },
      });
      assert.equal(changed.status, 400);
      assert.match((await changed.json()).error, /known data breach/);

      const deadLink = await call(env, 'auth/reset-password', { method: 'POST', body: { token: 'no-such-token', password: breached } });
      assert.equal(deadLink.status, 400);
      assert.equal(calls.length, 1, 'no breach lookup for an invalid reset link');
    });
    assert.ok(await bcrypt.compare(env.password, env.sqlite.prepare('SELECT password_hash FROM users WHERE id = 1').get().password_hash));
  } finally { env.sqlite.close(); }
});

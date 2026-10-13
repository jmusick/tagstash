import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import bcrypt from 'bcryptjs';
import { createAuthEnv } from './helpers/auth-env.mjs';
import { call, loginHeaders } from './helpers/api.mjs';

// Outgoing mail is captured; Pwned Passwords answers "not found". `gate` (optional) holds every
// email send open until released, to prove a response doesn't wait for delivery.
const withMail = async ({ gate, emailStatus = 200 } = {}, run) => {
  const realFetch = globalThis.fetch;
  const mail = [];
  globalThis.fetch = async (url, options = {}) => {
    const { host } = new URL(String(url));
    if (host === 'api.pwnedpasswords.com') return new Response('0000000000000000000000000000000000A:0\r\n');
    if (host !== 'api.cloudflare.com') throw new Error(`unexpected fetch to ${host}`);
    mail.push(JSON.parse(options.body));
    if (gate) await gate.promise;
    return emailStatus === 200
      ? Response.json({ success: true })
      : Response.json({ success: false, errors: [{ message: 'provider exploded for someone@example.com' }] }, { status: emailStatus });
  };
  try { return await run(mail); } finally { globalThis.fetch = realFetch; }
};
const makeGate = () => {
  let release;
  const promise = new Promise((resolve) => { release = resolve; });
  return { promise, release };
};
// Fails the test instead of hanging if a response waits on a gated email.
const answeredWithin = (promise, ms = 2000) => Promise.race([
  promise,
  new Promise((_, reject) => setTimeout(() => reject(new Error('response waited for email delivery')), ms)),
]);
const quietly = async (run) => {
  const real = { warn: console.warn, error: console.error };
  console.warn = () => {};
  console.error = () => {};
  try { return await run(); } finally { Object.assign(console, real); }
};

const emailEnv = async () => {
  const env = await createAuthEnv();
  Object.assign(env, { CLOUDFLARE_API_TOKEN: 'isolated-test', CLOUDFLARE_ACCOUNT_ID: 'isolated-test' });
  env.sqlite.prepare('INSERT INTO users (username, email, password_hash, email_verified) VALUES (?, ?, ?, 0)')
    .run('pendinguser', 'pending@example.com', await bcrypt.hash('pending-password', 4));
  return env;
};
const snapshot = async (response) => ({ status: response.status, body: await response.json() });
const register = (env, body, waitUntil) => call(env, 'auth/register', { method: 'POST', body, waitUntil });
const userCount = (env) => env.sqlite.prepare('SELECT COUNT(*) AS n FROM users').get().n;

test('register: an existing email gets the same 201 body as a new one, and its owner is emailed after the response', async () => {
  const env = await emailEnv();
  try {
    const gate = makeGate();
    const pending = [];
    const waitUntil = (promise) => pending.push(promise);
    const hashBefore = env.sqlite.prepare('SELECT password_hash FROM users WHERE id = 1').get().password_hash;

    await withMail({ gate }, async (mail) => {
      const fresh = await snapshot(await answeredWithin(register(env, { username: 'brandnew', email: 'brandnew@example.com', password: 'a-new-passphrase' }, waitUntil)));
      const existing = await snapshot(await answeredWithin(register(env, { username: 'impostor', email: 'Session@Example.com', password: 'a-new-passphrase' }, waitUntil)));
      assert.deepEqual(existing, fresh);
      assert.equal(fresh.status, 201);
      assert.equal(fresh.body.pendingVerification, true);
      assert.equal(pending.length, 2, 'both emails are sent through waitUntil');

      gate.release();
      await Promise.all(pending);
      const bySubject = Object.fromEntries(mail.map((m) => [m.to, m.subject]));
      assert.deepEqual(bySubject, {
        'brandnew@example.com': 'Verify your Tagstash email address',
        'session@example.com': 'Someone tried to sign up with your email address',
      });
      const notice = mail.find((m) => m.to === 'session@example.com');
      assert.match(notice.text, /Forgot password\?/);
      assert.doesNotMatch(notice.text, /token=/, 'the notice carries no link that acts on the account');
    });

    // The existing account is untouched and no second account or token was created for it.
    assert.equal(env.sqlite.prepare('SELECT password_hash FROM users WHERE id = 1').get().password_hash, hashBefore);
    assert.equal(env.sqlite.prepare("SELECT COUNT(*) AS n FROM users WHERE username = 'impostor'").get().n, 0);
    assert.equal(env.sqlite.prepare('SELECT COUNT(*) AS n FROM email_verification_tokens WHERE user_id = 1').get().n, 0);
    assert.deepEqual(
      env.sqlite.prepare("SELECT email, user_id FROM auth_events WHERE event_type = 'register_owner_notified'").all().map((r) => ({ ...r })),
      [{ email: 'session@example.com', user_id: 1 }],
    );
  } finally { env.sqlite.close(); }
});

test('register: an unverified owner is pointed at "Resend verification email"', async () => {
  const env = await emailEnv();
  try {
    await withMail({}, async (mail) => {
      const response = await register(env, { username: 'second-try', email: 'pending@example.com', password: 'a-new-passphrase' });
      assert.equal(response.status, 201);
      assert.equal(mail.length, 1);
      assert.equal(mail[0].to, 'pending@example.com');
      assert.match(mail[0].text, /Resend verification email/);
    });
  } finally { env.sqlite.close(); }
});

test('register: a taken username answers the same whether or not the email has an account', async () => {
  const env = await emailEnv();
  try {
    await withMail({}, async (mail) => {
      const withNewEmail = await snapshot(await register(env, { username: 'SessionTester', email: 'unused@example.com', password: 'a-new-passphrase' }));
      const withKnownEmail = await snapshot(await register(env, { username: 'SessionTester', email: 'session@example.com', password: 'a-new-passphrase' }));
      const withPendingEmail = await snapshot(await register(env, { username: 'sessiontester', email: 'pending@example.com', password: 'a-new-passphrase' }));
      assert.equal(withNewEmail.status, 400);
      assert.match(withNewEmail.body.error, /username is already taken/i);
      assert.deepEqual(withKnownEmail, withNewEmail);
      assert.deepEqual(withPendingEmail, withNewEmail);
      assert.equal(mail.length, 0);
    });
    assert.equal(userCount(env), 2);
  } finally { env.sqlite.close(); }
});

test('register: owner notices are capped per address, silently', async () => {
  const env = await emailEnv();
  try {
    await withMail({}, async (mail) => {
      const responses = [];
      for (let i = 0; i < 5; i += 1) {
        responses.push(await snapshot(await register(env, { username: `spammer${i}`, email: 'session@example.com', password: 'a-new-passphrase' })));
      }
      for (const response of responses) assert.deepEqual(response, responses[0]);
      assert.equal(responses[0].status, 201);
      assert.equal(mail.length, 3);
    });
  } finally { env.sqlite.close(); }
});

test('register: email provider failures never reach the caller, for new or existing addresses', async () => {
  const env = await emailEnv();
  try {
    await quietly(() => withMail({ emailStatus: 500 }, async () => {
      const fresh = await snapshot(await register(env, { username: 'unlucky', email: 'unlucky@example.com', password: 'a-new-passphrase' }));
      const existing = await snapshot(await register(env, { username: 'unlucky2', email: 'session@example.com', password: 'a-new-passphrase' }));
      assert.deepEqual(existing, fresh);
      assert.equal(fresh.status, 201);
    }));
    // The new account whose verification email failed is kept (unverified), without a live
    // undelivered token, so "Resend verification email" recovers it straight away.
    assert.equal(env.sqlite.prepare("SELECT COUNT(*) AS n FROM users WHERE email = 'unlucky@example.com' AND email_verified = 0").get().n, 1);
    assert.equal(env.sqlite.prepare('SELECT COUNT(*) AS n FROM email_verification_tokens WHERE used_at IS NULL').get().n, 0);
    await withMail({}, async (mail) => {
      const resend = await call(env, 'auth/resend-verification', { method: 'POST', body: { email: 'unlucky@example.com' } });
      assert.equal(resend.status, 200);
      assert.deepEqual(mail.map((m) => [m.to, m.subject]), [['unlucky@example.com', 'Verify your Tagstash email address']]);
    });
  } finally { env.sqlite.close(); }
});

test('register: a failure to store the verification token keeps the account too', async () => {
  const env = await emailEnv();
  try {
    env.sqlite.exec(`CREATE TRIGGER fail_token BEFORE INSERT ON email_verification_tokens
      BEGIN SELECT RAISE(ABORT, 'token storage unavailable'); END`);
    await quietly(() => withMail({}, async (mail) => {
      const response = await register(env, { username: 'tokenless', email: 'tokenless@example.com', password: 'a-new-passphrase' });
      assert.equal(response.status, 201);
      assert.equal(mail.length, 0);
    }));
    assert.equal(env.sqlite.prepare("SELECT COUNT(*) AS n FROM users WHERE email = 'tokenless@example.com'").get().n, 1);

    // Once storage works again, Resend recovers it.
    env.sqlite.exec('DROP TRIGGER fail_token');
    await withMail({}, async (mail) => {
      const resend = await call(env, 'auth/resend-verification', { method: 'POST', body: { email: 'tokenless@example.com' } });
      assert.equal(resend.status, 200);
      assert.deepEqual(mail.map((m) => m.to), ['tokenless@example.com']);
    });
  } finally { env.sqlite.close(); }
});

test('email change: "already in use" is only revealed after the correct password', async () => {
  const env = await emailEnv();
  try {
    const headers = await loginHeaders(env);
    const change = (newEmail, password) => call(env, 'auth/email', { method: 'PUT', headers, body: { newEmail, password } });
    const takenWrong = await snapshot(await change('pending@example.com', 'wrong-password'));
    const freeWrong = await snapshot(await change('free@example.com', 'wrong-password'));
    assert.deepEqual(takenWrong, freeWrong);
    assert.equal(takenWrong.status, 401);
    // Both misses counted toward the lockout.
    assert.equal(env.sqlite.prepare('SELECT failed_attempts FROM users WHERE id = 1').get().failed_attempts, 2);

    const takenRight = await snapshot(await change('pending@example.com', env.password));
    assert.deepEqual(takenRight, { status: 400, body: { error: 'Email is already in use' } });
  } finally { env.sqlite.close(); }
});

test('resend-verification: unknown, verified and unverified addresses get the same answers, throttle included', async () => {
  const env = await emailEnv();
  try {
    const pending = [];
    const resend = (email) => call(env, 'auth/resend-verification', { method: 'POST', body: { email }, waitUntil: (p) => pending.push(p) });
    await withMail({}, async (mail) => {
      const first = [];
      const second = [];
      for (const email of ['ghost@example.com', 'session@example.com', 'pending@example.com']) {
        first.push(await snapshot(await resend(email)));
        second.push(await snapshot(await resend(email)));
      }
      for (const response of first) assert.deepEqual(response, first[0]);
      for (const response of second) assert.deepEqual(response, second[0]);
      assert.equal(first[0].status, 200);
      assert.equal(second[0].status, 429);
      assert.equal(pending.length, 3, 'the lookup and send run after the response for every address');
      await Promise.all(pending);
      assert.deepEqual(mail.map((m) => m.to), ['pending@example.com']);
    });

    // A link issued moments ago (by sign-up, say) no longer produces a distinct 429 either.
    env.sqlite.prepare('DELETE FROM auth_events').run();
    await withMail({}, async (mail) => {
      const again = await snapshot(await resend('pending@example.com'));
      assert.equal(again.status, 200);
      await Promise.all(pending);
      assert.equal(mail.length, 0, 'the fresh link is not replaced');
    });
  } finally { env.sqlite.close(); }
});

test('forgot-password: the response is sent before the reset email and is identical for known and unknown addresses', async () => {
  const env = await emailEnv();
  try {
    const gate = makeGate();
    const pending = [];
    const forgot = (email) => call(env, 'auth/forgot-password', { method: 'POST', body: { email }, waitUntil: (p) => pending.push(p) });
    await withMail({ gate }, async (mail) => {
      const known = await snapshot(await answeredWithin(forgot('session@example.com')));
      const unknown = await snapshot(await answeredWithin(forgot('ghost@example.com')));
      assert.deepEqual(known, unknown);
      assert.equal(known.status, 200);
      assert.equal(pending.length, 2);
      gate.release();
      await Promise.all(pending);
      assert.deepEqual(mail.map((m) => m.to), ['session@example.com']);
    });
    assert.equal(env.sqlite.prepare('SELECT COUNT(*) AS n FROM password_reset_tokens WHERE user_id = 1').get().n, 1);
  } finally { env.sqlite.close(); }
});

test('forgot-password: provider failures and fresh links stay invisible', async () => {
  const env = await emailEnv();
  try {
    await quietly(() => withMail({ emailStatus: 500 }, async () => {
      const known = await snapshot(await call(env, 'auth/forgot-password', { method: 'POST', body: { email: 'session@example.com' } }));
      const unknown = await snapshot(await call(env, 'auth/forgot-password', { method: 'POST', body: { email: 'ghost@example.com' } }));
      assert.deepEqual(known, unknown);
      assert.equal(known.status, 200);
    }));

    // A reset link issued under a minute ago used to produce a 429 only for real accounts.
    env.sqlite.prepare('DELETE FROM auth_events').run();
    const digest = createHash('sha256').update('fresh').digest('hex');
    env.sqlite.prepare('INSERT INTO password_reset_tokens (user_id, token, token_hash, expires_at) VALUES (1, ?, ?, ?)')
      .run(`sha256:${digest}`, digest, new Date(Date.now() + 3600000).toISOString());
    await withMail({}, async (mail) => {
      const known = await snapshot(await call(env, 'auth/forgot-password', { method: 'POST', body: { email: 'session@example.com' } }));
      assert.equal(known.status, 200);
      assert.equal(mail.length, 0);
    });
  } finally { env.sqlite.close(); }
});

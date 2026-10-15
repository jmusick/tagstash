import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { createAuthEnv } from './helpers/auth-env.mjs';
import { call, loginHeaders } from './helpers/api.mjs';

const missing = () => Response.json({ error: { code: 'resource_missing', message: 'No such customer: private-provider-value' } }, { status: 404 });
const removed = (id = 'cus_target') => Response.json({ id, deleted: true });
const deferred = () => {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
};

async function setup(t, { customer = 'cus_target', subscription = 'sub_target' } = {}) {
  const env = await createAuthEnv({ queryLatency: true });
  t.after(() => env.sqlite.close());
  env.SUPER_ADMIN_EMAIL = 'session@example.com';
  env.STRIPE_SECRET_KEY = 'sk_test_isolated';
  env.STRIPE_MONTHLY_PRICE_ID = 'price_test';
  const headers = await loginHeaders(env);
  const insertUser = env.sqlite.prepare(`INSERT INTO users (username, email, password_hash, email_verified, stripe_customer_id, stripe_subscription_id)
    SELECT ?, ?, password_hash, 1, ?, ? FROM users WHERE id = 1`);
  insertUser.run('target', 'target@example.com', customer, subscription);
  insertUser.run('other', 'other@example.com', 'cus_other', 'sub_other');
  const targetLogin = await call(env, 'auth/login', { method: 'POST', body: { email: 'target@example.com', password: env.password } });
  const targetHeaders = { Authorization: `Bearer ${(await targetLogin.json()).token}` };
  const webHeaders = { Origin: 'https://tagsta.sh', 'X-Tagstash-Client': 'web' };
  const webLogin = await call(env, 'auth/login', { method: 'POST', headers: webHeaders, body: { email: 'target@example.com', password: env.password } });
  const targetCookie = { ...webHeaders, Cookie: webLogin.headers.get('Set-Cookie').split(';')[0] };

  env.sqlite.exec(`
    INSERT INTO bookmarks (id, user_id, title, url) VALUES (1, 2, 'Target', 'https://target.example/'), (2, 3, 'Other', 'https://other.example/');
    INSERT INTO tags (id, name) VALUES (1, 'shared'), (2, 'target-only'), (3, 'others-favorite'), (4, 'target-favorite-only');
    INSERT INTO bookmark_tags VALUES (1, 1), (1, 2), (1, 3), (2, 1);
    INSERT INTO favorite_tags (user_id, tag_id) VALUES (2, 1), (2, 2), (2, 4), (3, 3);
    INSERT INTO api_keys (user_id, name, key_hash, key_prefix, key_last4) VALUES (2, 'Target', 'target-hash', 'tsk_a', 'abcd'), (3, 'Other', 'other-hash', 'tsk_b', 'bcde');
    INSERT INTO email_verification_tokens (user_id, token, token_hash, expires_at) VALUES (2, 'target-verify', 'verify-hash', '2099-01-01'), (3, 'other-verify', 'other-verify-hash', '2099-01-01');
    INSERT INTO password_reset_tokens (user_id, token, token_hash, expires_at) VALUES (2, 'target-reset', 'reset-hash', '2099-01-01'), (3, 'other-reset', 'other-reset-hash', '2099-01-01');
    INSERT INTO email_change_tokens (user_id, new_email, token_hash, expires_at) VALUES (2, 'new@example.com', 'change-hash', '2099-01-01'), (3, 'new-other@example.com', 'other-change-hash', '2099-01-01');
    INSERT INTO auth_events (event_type, email, user_id) VALUES ('login_failed', 'previous@example.com', 2), ('login_failed', 'TARGET@example.com', NULL), ('login_failed', 'other@example.com', 3);
    INSERT INTO auth_events (event_type, email, user_id, actor_user_id) VALUES ('admin_profile_made_private', 'other@example.com', 3, 2);
    UPDATE users SET suspended_at = '2026-01-01', suspended_by = 2 WHERE id = 3;
  `);
  const calls = [];
  let stripe = async ({ url }) => removed(url.pathname.split('/').at(-1));
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    const request = { url: new URL(String(url)), options };
    calls.push(request);
    assert.equal(request.url.origin, 'https://api.stripe.com', 'tests must never contact live services');
    return stripe(request);
  };
  const logs = [];
  const originalError = console.error;
  console.error = (...args) => logs.push(args);
  t.after(() => { globalThis.fetch = originalFetch; console.error = originalError; });
  return {
    env, headers, targetHeaders, targetCookie, calls, logs,
    stripe: (handler) => { stripe = handler; },
    delete: (id = 2, auth = headers) => call(env, `auth/admin/users/${id}`, { method: 'DELETE', headers: auth }),
  };
}

const tables = ['users', 'bookmarks', 'tags', 'bookmark_tags', 'favorite_tags', 'api_keys', 'email_verification_tokens', 'password_reset_tokens', 'email_change_tokens', 'auth_events'];
const snapshot = (env) => Object.fromEntries(tables.map((table) => [table, env.sqlite.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()]));
const withoutDeletionState = (data) => ({ ...data, users: data.users.map(({ deletion_started_at: _pending, ...user }) => user) });
const assertDeleted = (env) => {
  assert.equal(env.sqlite.prepare('SELECT * FROM users WHERE id = 2').get(), undefined);
  for (const table of ['bookmarks', 'favorite_tags', 'api_keys', 'email_verification_tokens', 'password_reset_tokens', 'email_change_tokens', 'auth_events']) {
    assert.equal(env.sqlite.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE user_id = 2`).get().n, 0, table);
    assert.ok(env.sqlite.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE user_id = 3`).get().n > 0, `other account retains ${table}`);
  }
  assert.deepEqual(env.sqlite.prepare('SELECT * FROM bookmark_tags').all().map((row) => ({ ...row })), [{ bookmark_id: 2, tag_id: 1 }]);
  assert.deepEqual(env.sqlite.prepare('SELECT name FROM tags ORDER BY id').all().map((row) => row.name), ['shared', 'others-favorite']);
  assert.equal(env.sqlite.prepare("SELECT COUNT(*) AS n FROM auth_events WHERE LOWER(email) = 'target@example.com'").get().n, 0);
  assert.equal(env.sqlite.prepare('SELECT COUNT(*) AS n FROM auth_events WHERE actor_user_id = 2').get().n, 0);
  const other = env.sqlite.prepare('SELECT suspended_at, suspended_by FROM users WHERE id = 3').get();
  assert.equal(other.suspended_at, '2026-01-01', 'deleting a former admin must not lift moderation');
  assert.equal(other.suspended_by, null);
  assert.deepEqual(env.sqlite.prepare('PRAGMA foreign_key_check').all(), []);
};

test('admin deletion removes a Stripe customer before account data and preserves other accounts', async (t) => {
  const state = await setup(t);
  const { env, calls } = state;
  env.sqlite.exec("UPDATE users SET membership_tier = 'paid' WHERE id = 2");
  state.stripe(({ url, options }) => {
    assert.equal(options.method, 'DELETE');
    assert.equal(url.pathname, '/v1/customers/cus_target');
    assert.ok(options.signal instanceof AbortSignal);
    assert.equal(options.headers.Authorization, `Basic ${btoa('sk_test_isolated:')}`);
    assert.ok(env.sqlite.prepare('SELECT deletion_started_at FROM users WHERE id = 2').get().deletion_started_at);
    assert.equal(env.sqlite.prepare('SELECT COUNT(*) AS n FROM bookmarks WHERE user_id = 2').get().n, 1);
    return removed();
  });
  const response = await state.delete();
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('Cache-Control'), 'no-store');
  assert.equal(response.headers.get('X-Content-Type-Options'), 'nosniff');
  assert.equal(calls.length, 1, 'customer removal covers every active subscription');
  assertDeleted(env);
  for (const headers of [state.targetHeaders, state.targetCookie]) {
    assert.equal((await call(env, 'auth/me', { headers })).status, 403);
  }
  assert.equal((await state.delete()).status, 404, 'a completed deletion is a harmless not-found on retry');
});

test('a free account without billing is deleted even when Stripe is unconfigured', async (t) => {
  const state = await setup(t, { customer: null, subscription: null });
  delete state.env.STRIPE_SECRET_KEY;
  assert.equal((await state.delete()).status, 200);
  assert.equal(state.calls.length, 0);
  assertDeleted(state.env);
});

test('a customer is removed even without a recorded subscription or paid tier', async (t) => {
  const state = await setup(t, { subscription: null });
  assert.equal((await state.delete()).status, 200);
  assert.equal(state.calls[0].url.pathname, '/v1/customers/cus_target');
});

test('a legacy subscription without a customer ID is canceled; terminal subscriptions need no second cancellation', async (t) => {
  const state = await setup(t, { customer: null });
  state.stripe(({ url, options }) => {
    assert.equal(url.pathname, '/v1/subscriptions/sub_target');
    return Response.json({ id: 'sub_target', status: options.method === 'GET' ? 'active' : 'canceled' });
  });
  assert.equal((await state.delete()).status, 200);
  assert.deepEqual(state.calls.map(({ options }) => options.method), ['GET', 'DELETE']);
});

for (const status of ['canceled', 'incomplete_expired']) {
  test(`a legacy ${status} subscription is safe to retry`, async (t) => {
    const state = await setup(t, { customer: null });
    state.stripe(() => Response.json({ id: 'sub_target', status }));
    assert.equal((await state.delete()).status, 200);
    assert.equal(state.calls.length, 1);
    assert.equal(state.calls[0].options.method, 'GET');
  });
}

test('missing billing configuration and missing deletion migration fail before any account changes', async (t) => {
  const state = await setup(t);
  const before = snapshot(state.env);
  delete state.env.STRIPE_SECRET_KEY;
  assert.equal((await state.delete()).status, 503);
  assert.deepEqual(snapshot(state.env), before);
  state.env.STRIPE_SECRET_KEY = 'sk_test_isolated';
  state.env.sqlite.exec('ALTER TABLE users DROP COLUMN deletion_started_at');
  const beforeMigration = snapshot(state.env);
  assert.equal((await state.delete()).status, 503);
  assert.deepEqual(snapshot(state.env), beforeMigration);
  assert.equal(state.calls.length, 0);
});

test('Stripe failures or unconfirmed responses keep all data and leave deletion retryable', async (t) => {
  const state = await setup(t);
  const before = withoutDeletionState(snapshot(state.env));
  for (const [label, handler] of [
    ['network failure', () => { throw new TypeError('network failed'); }],
    ['provider failure', () => Response.json({ error: { message: 'private-provider-value' } }, { status: 500 })],
    ['wrong key', () => Response.json({ error: { message: 'private-provider-value' } }, { status: 401 })],
    ['unstructured 404', () => Response.json({ error: { message: 'No such customer: private-provider-value' } }, { status: 404 })],
    ['wrong missing status', () => Response.json({ error: { code: 'resource_missing' } }, { status: 400 })],
    ['bad JSON', () => new Response('invalid JSON')],
    ['empty body', () => Response.json({})],
    ['not deleted', () => Response.json({ id: 'cus_target', deleted: false })],
    ['wrong customer', () => removed('cus_other')],
  ]) {
    state.stripe(handler);
    const response = await state.delete();
    assert.equal(response.status, 502, label);
    assert.equal(response.headers.get('Cache-Control'), 'no-store');
    assert.deepEqual(withoutDeletionState(snapshot(state.env)), before, label);
    assert.ok(state.env.sqlite.prepare('SELECT deletion_started_at FROM users WHERE id = 2').get().deletion_started_at);
    assert.doesNotMatch(JSON.stringify(await response.json()), /private-provider-value/);
  }
  assert.doesNotMatch(JSON.stringify(state.logs), /private-provider-value|target@example.com|sk_test_isolated/);
  for (const headers of [state.targetHeaders, state.targetCookie]) {
    assert.equal((await call(state.env, 'auth/me', { headers })).status, 403, 'pending accounts cannot start another checkout');
    assert.equal((await call(state.env, 'billing/checkout-session', { method: 'POST', headers, body: { plan: 'monthly' } })).status, 403);
  }
  const login = await call(state.env, 'auth/login', { method: 'POST', body: { email: 'target@example.com', password: state.env.password } });
  assert.equal(login.status, 403);
  assert.match((await login.json()).error, /deletion is in progress/);
  state.stripe(missing);
  assert.equal((await state.delete()).status, 200);
  assertDeleted(state.env);
});

test('a real deadline abort keeps the account; a missing-customer retry completes deletion', async (t) => {
  const state = await setup(t);
  const originalTimeout = AbortSignal.timeout;
  let deadline;
  AbortSignal.timeout = (ms) => { deadline = ms; return originalTimeout(20); };
  t.after(() => { AbortSignal.timeout = originalTimeout; });
  state.stripe(({ options }) => new Promise((_, reject) => {
    options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true });
  }));
  // AbortSignal's timer is unref'ed; keep the event loop alive during this test.
  const keepAlive = setInterval(() => {}, 1000);
  t.after(() => clearInterval(keepAlive));
  assert.equal((await state.delete()).status, 502);
  assert.equal(deadline, 15000);
  assert.ok(state.env.sqlite.prepare('SELECT id FROM users WHERE id = 2').get());
  state.stripe(missing);
  assert.equal((await state.delete()).status, 200);
  assertDeleted(state.env);
});

test('a failed cleanup transaction rolls back all account data; a retry finishes after billing was removed', async (t) => {
  const state = await setup(t);
  const before = withoutDeletionState(snapshot(state.env));
  state.env.sqlite.exec("CREATE TRIGGER fail_deletion BEFORE DELETE ON users WHEN OLD.id = 2 BEGIN SELECT RAISE(ABORT, 'simulated cleanup failure'); END");
  const response = await state.delete();
  assert.equal(response.status, 503);
  assert.match((await response.json()).error, /retry to finish cleanup/);
  assert.deepEqual(withoutDeletionState(snapshot(state.env)), before);
  state.env.sqlite.exec('DROP TRIGGER fail_deletion');
  state.stripe(missing);
  assert.equal((await state.delete()).status, 200);
  assertDeleted(state.env);
});

test('authorization, invalid IDs and protected admins are rejected before billing or deletion', async (t) => {
  const state = await setup(t);
  const before = snapshot(state.env);
  assert.equal((await state.delete(2, {})).status, 401);
  assert.equal((await state.delete(3, state.targetHeaders)).status, 403);
  for (const id of ['bad', '0', '-1', '1.5', '1']) assert.equal((await state.delete(id)).status, 400, id);
  assert.equal((await state.delete(999)).status, 404);
  state.env.sqlite.exec("UPDATE users SET role = 'super_admin' WHERE id = 3");
  assert.equal((await state.delete(3)).status, 400);
  state.env.sqlite.exec("UPDATE users SET role = 'user' WHERE id = 3");
  assert.deepEqual(snapshot(state.env), before);
  assert.equal(state.calls.length, 0);
});

test('deletion supports installations without the older optional cleanup tables and moderation columns', async (t) => {
  const state = await setup(t, { customer: null, subscription: null });
  state.env.sqlite.exec('DROP TABLE email_change_tokens; DROP TABLE auth_events; ALTER TABLE users DROP COLUMN suspended_by');
  assert.equal((await state.delete()).status, 200);
  assert.equal(state.env.sqlite.prepare('SELECT id FROM users WHERE id = 2').get(), undefined);
});

test('an in-flight billing status refresh cannot clear identifiers needed by a pending deletion', async (t) => {
  const state = await setup(t);
  const statusStarted = deferred();
  const releaseStatus = deferred();
  const deleting = deferred();
  const releaseDelete = deferred();
  state.stripe(async ({ options }) => {
    if (options.method === 'GET') {
      statusStarted.resolve();
      await releaseStatus.promise;
      return missing();
    }
    deleting.resolve();
    await releaseDelete.promise;
    return removed();
  });
  const status = call(state.env, 'billing/status', { headers: state.targetHeaders });
  await statusStarted.promise;
  const deletion = state.delete();
  await deleting.promise;
  try {
    releaseStatus.resolve();
    assert.equal((await status).status, 200);
    const pending = state.env.sqlite.prepare('SELECT * FROM users WHERE id = 2').get();
    assert.ok(pending.deletion_started_at);
    assert.equal(pending.stripe_customer_id, 'cus_target');
    assert.equal(pending.stripe_subscription_id, 'sub_target');
  } finally { releaseDelete.resolve(); }
  assert.equal((await deletion).status, 200);
});

for (const race of [false, true]) {
  test(`Stripe webhooks cannot change billing after deletion starts (in-flight read: ${race})`, async (t) => {
    const state = await setup(t);
    state.env.STRIPE_WEBHOOK_SECRET = 'whsec_isolated';
    const originalPrepare = state.env.DB.prepare;
    if (race) {
      state.env.DB.prepare = (sql) => {
        const statement = originalPrepare(sql);
        if (sql.startsWith('SELECT * FROM users WHERE')) {
          const originalFirst = statement.first;
          statement.first = async () => {
            const user = await originalFirst();
            if (user?.id === 2) state.env.sqlite.exec("UPDATE users SET deletion_started_at = '2026-01-01' WHERE id = 2");
            return user;
          };
        }
        return statement;
      };
    }
    for (const [type, object] of [
      ['checkout.session.completed', { metadata: { userId: '2' }, customer: 'cus_replacement', subscription: 'sub_replacement' }],
      ['customer.subscription.updated', { customer: 'cus_target', status: 'active' }],
      ['customer.subscription.deleted', { customer: 'cus_target' }],
    ]) {
      state.env.sqlite.prepare('UPDATE users SET deletion_started_at = ? WHERE id = 2').run(race ? null : '2026-01-01');
      const before = withoutDeletionState(snapshot(state.env));
      const body = JSON.stringify({ type, data: { object } });
      const timestamp = Math.floor(Date.now() / 1000);
      const signature = createHmac('sha256', state.env.STRIPE_WEBHOOK_SECRET).update(`${timestamp}.${body}`).digest('hex');
      const response = await call(state.env, 'billing/webhook', {
        method: 'POST', body, headers: { 'stripe-signature': `t=${timestamp},v1=${signature}` },
      });
      assert.equal(response.status, 200, type);
      assert.deepEqual(withoutDeletionState(snapshot(state.env)), before, type);
    }
  });
}

test('checkout still works before the deletion migration is applied', async (t) => {
  const state = await setup(t, { customer: null, subscription: null });
  state.env.sqlite.exec('ALTER TABLE users DROP COLUMN deletion_started_at');
  state.stripe(({ url }) => url.pathname === '/v1/customers'
    ? Response.json({ id: 'cus_created' })
    : Response.json({ url: 'https://checkout.stripe.com/test' }));
  const response = await call(state.env, 'billing/checkout-session', {
    method: 'POST', headers: state.targetHeaders, body: { plan: 'monthly' },
  });
  assert.equal(response.status, 200);
  assert.equal(state.env.sqlite.prepare('SELECT stripe_customer_id FROM users WHERE id = 2').get().stripe_customer_id, 'cus_created');
});

for (const cleanupFails of [false, true]) {
  test(`checkout cannot attach a customer created during deletion (cleanup failure: ${cleanupFails})`, async (t) => {
    const state = await setup(t, { customer: null, subscription: null });
    const created = deferred();
    const release = deferred();
    state.stripe(async ({ url, options }) => {
      if (options.method === 'POST' && url.pathname === '/v1/customers') {
        created.resolve();
        await release.promise;
        return Response.json({ id: 'cus_late' });
      }
      assert.equal(options.method, 'DELETE');
      assert.equal(url.pathname, '/v1/customers/cus_late');
      return removed('cus_late');
    });
    const checkout = call(state.env, 'billing/checkout-session', { method: 'POST', headers: state.targetHeaders, body: { plan: 'monthly' } });
    await created.promise;
    if (cleanupFails) state.env.sqlite.exec("CREATE TRIGGER fail_deletion BEFORE DELETE ON users WHEN OLD.id = 2 BEGIN SELECT RAISE(ABORT, 'test failure'); END");
    try {
      assert.equal((await state.delete()).status, cleanupFails ? 503 : 200);
    } finally { release.resolve(); }
    assert.equal((await checkout).status, 409);
    assert.deepEqual(state.calls.map(({ url }) => url.pathname), ['/v1/customers', '/v1/customers/cus_late']);
    if (cleanupFails) {
      const user = state.env.sqlite.prepare('SELECT * FROM users WHERE id = 2').get();
      assert.equal(user.stripe_customer_id, null);
      assert.ok(user.deletion_started_at);
    }
  });
}

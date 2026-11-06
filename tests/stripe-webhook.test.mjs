import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { createAuthEnv } from './helpers/auth-env.mjs';
import { call } from './helpers/api.mjs';

const SECRET = 'whsec_isolated';
const ROTATED_SECRET = 'whsec_isolated_previous';

const sign = (body, { secret = SECRET, timestamp = Math.floor(Date.now() / 1000) } = {}) =>
  createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex');

// Seeds user 1 (from createAuthEnv) as a paying customer on sub_current. `subscriptions` is what
// the fake Stripe API answers for GET /v1/subscriptions/:id; anything else fails the test.
async function setup(t, { tier = 'paid', customer = 'cus_current', subscription = 'sub_current' } = {}) {
  const env = await createAuthEnv();
  t.after(() => env.sqlite.close());
  Object.assign(env, { STRIPE_SECRET_KEY: 'sk_test_isolated', STRIPE_WEBHOOK_SECRET: SECRET });
  env.sqlite.prepare('UPDATE users SET membership_tier = ?, stripe_customer_id = ?, stripe_subscription_id = ? WHERE id = 1')
    .run(tier, customer, subscription);
  env.sqlite.prepare(`INSERT INTO users (username, email, password_hash, email_verified, membership_tier)
    VALUES ('emailtwin', 'twin@example.com', 'x', 1, 'free')`).run();

  const subscriptions = {};
  const calls = [];
  let failWith = null;
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, options = {}) => {
    const { origin, pathname } = new URL(String(url));
    assert.equal(origin, 'https://api.stripe.com', 'tests must never contact live services');
    assert.equal(options.method, 'GET');
    calls.push(pathname);
    if (failWith) return failWith();
    const id = decodeURIComponent(pathname.replace('/v1/subscriptions/', ''));
    if (!subscriptions[id]) {
      return Response.json({ error: { code: 'resource_missing', message: `No such subscription: '${id}'` } }, { status: 404 });
    }
    return Response.json({ id, ...subscriptions[id] });
  };
  t.after(() => { globalThis.fetch = realFetch; });

  const deliver = (type, object, { signatureHeader } = {}) => {
    const body = JSON.stringify({ id: `evt_${Math.random().toString(16).slice(2)}`, type, created: 1, data: { object } });
    const timestamp = Math.floor(Date.now() / 1000);
    return call(env, 'billing/webhook', {
      method: 'POST', body, headers: { 'stripe-signature': signatureHeader?.(body, timestamp) ?? `t=${timestamp},v1=${sign(body, { timestamp })}` },
    });
  };
  const user = (id = 1) => env.sqlite.prepare('SELECT membership_tier, stripe_customer_id, stripe_subscription_id FROM users WHERE id = ?').get(id);
  return { env, subscriptions, calls, deliver, user, fail: (handler) => { failWith = handler; } };
}

test('any of several v1 signatures is accepted, so a webhook secret can be rolled', async (t) => {
  const { deliver, subscriptions, user } = await setup(t, { tier: 'free' });
  subscriptions.sub_current = { customer: 'cus_current', status: 'active' };
  const response = await deliver('customer.subscription.updated', { id: 'sub_current' }, {
    signatureHeader: (body, timestamp) => `t=${timestamp},v1=${sign(body, { timestamp, secret: ROTATED_SECRET })},v1=${sign(body, { timestamp })},v0=ignored`,
  });
  assert.equal(response.status, 200);
  assert.equal(user().membership_tier, 'paid');
});

test('bad, stale or malformed signatures are rejected before any Stripe call or write', async (t) => {
  const { deliver, subscriptions, calls, user } = await setup(t, { tier: 'free' });
  subscriptions.sub_current = { customer: 'cus_current', status: 'active' };
  const stale = Math.floor(Date.now() / 1000) - 301;
  for (const [label, header] of [
    ['wrong secret only', (body, ts) => `t=${ts},v1=${sign(body, { timestamp: ts, secret: ROTATED_SECRET })}`],
    ['stale timestamp', (body) => `t=${stale},v1=${sign(body, { timestamp: stale })}`],
    ['non-numeric timestamp', (body) => `t=abc,v1=${sign(body, { timestamp: 'abc' })}`],
    ['no timestamp', (body, ts) => `v1=${sign(body, { timestamp: ts })}`],
    ['no v1', (body, ts) => `t=${ts}`],
    ['truncated signature', (body, ts) => `t=${ts},v1=${sign(body, { timestamp: ts }).slice(0, 63)}`],
    ['non-hex signature', (body, ts) => `t=${ts},v1=${'z'.repeat(64)}`],
    ['empty header', () => ''],
  ]) {
    const response = await deliver('customer.subscription.updated', { id: 'sub_current' }, { signatureHeader: header });
    assert.equal(response.status, 400, label);
    assert.deepEqual(await response.json(), { error: 'Invalid webhook signature' }, label);
  }
  assert.equal(calls.length, 0);
  assert.equal(user().membership_tier, 'free');
});

test('a deleted event for an older subscription does not downgrade the current one', async (t) => {
  const { deliver, subscriptions, calls, user } = await setup(t);
  subscriptions.sub_old = { customer: 'cus_current', status: 'canceled' };
  subscriptions.sub_current = { customer: 'cus_current', status: 'active' };
  for (const type of ['customer.subscription.deleted', 'customer.subscription.updated']) {
    const response = await deliver(type, { id: 'sub_old', customer: 'cus_current', status: 'canceled' });
    assert.equal(response.status, 200, type);
    assert.equal((await response.json()).result.handled, false, type);
  }
  assert.deepEqual({ ...user() }, { membership_tier: 'paid', stripe_customer_id: 'cus_current', stripe_subscription_id: 'sub_current' });
  assert.equal(calls.length, 0, 'unmatched events never reach Stripe');
});

test('out-of-order events apply Stripe\'s current state, not the payload', async (t) => {
  const { deliver, subscriptions, user } = await setup(t);
  // A stale past_due update arrives after the subscription recovered: the user stays paid.
  subscriptions.sub_current = { customer: 'cus_current', status: 'active' };
  let response = await deliver('customer.subscription.updated', { id: 'sub_current', status: 'past_due' });
  assert.equal(response.status, 200);
  assert.equal(user().membership_tier, 'paid');

  // A stale "active" update arrives after the subscription lapsed: the user is downgraded.
  subscriptions.sub_current.status = 'unpaid';
  response = await deliver('customer.subscription.updated', { id: 'sub_current', status: 'active' });
  assert.equal(response.status, 200);
  assert.deepEqual({ ...user() }, { membership_tier: 'free', stripe_customer_id: 'cus_current', stripe_subscription_id: 'sub_current' });

  // It recovers, then the duplicate of that recovery is harmless.
  subscriptions.sub_current.status = 'active';
  for (let i = 0; i < 2; i += 1) {
    response = await deliver('customer.subscription.updated', { id: 'sub_current', status: 'active' });
    assert.equal(response.status, 200);
    assert.equal(user().membership_tier, 'paid');
  }

  // Ended: downgraded and the subscription is unlinked; a duplicate deletion then matches nothing.
  subscriptions.sub_current.status = 'canceled';
  for (const handled of [true, false]) {
    response = await deliver('customer.subscription.deleted', { id: 'sub_current' });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).result.handled, handled);
    assert.deepEqual({ ...user() }, { membership_tier: 'free', stripe_customer_id: 'cus_current', stripe_subscription_id: null });
  }
});

test('a subscription Stripe no longer knows counts as ended', async (t) => {
  const { deliver, user } = await setup(t);
  const response = await deliver('customer.subscription.deleted', { id: 'sub_current' });
  assert.equal(response.status, 200);
  assert.deepEqual({ ...user() }, { membership_tier: 'free', stripe_customer_id: 'cus_current', stripe_subscription_id: null });
});

test('a Stripe failure answers 502 so Stripe retries, and changes nothing', async (t) => {
  const { deliver, fail, user } = await setup(t);
  const before = { ...user() };
  for (const handler of [
    () => Response.json({ error: { message: 'Rate limited' } }, { status: 429 }),
    () => { throw new TypeError('network down'); },
    () => Response.json({ id: 'sub_someone_else', customer: 'cus_current', status: 'canceled' }),
  ]) {
    fail(handler);
    const response = await deliver('customer.subscription.deleted', { id: 'sub_current' });
    assert.equal(response.status, 502);
    assert.deepEqual({ ...user() }, before);
  }
});

test('the webhook answers 503 without a Stripe secret key, before touching anything', async (t) => {
  const { env, deliver, calls, user } = await setup(t);
  delete env.STRIPE_SECRET_KEY;
  const before = { ...user() };
  const response = await deliver('customer.subscription.deleted', { id: 'sub_current' });
  assert.equal(response.status, 503);
  assert.equal(calls.length, 0);
  assert.deepEqual({ ...user() }, before);
});

test('a paid checkout upgrades the account named in its metadata', async (t) => {
  const { deliver, subscriptions, user } = await setup(t, { tier: 'free', customer: 'cus_current', subscription: null });
  subscriptions.sub_new = { customer: 'cus_current', status: 'active' };
  const response = await deliver('checkout.session.completed', {
    mode: 'subscription', payment_status: 'paid', metadata: { userId: '1' }, customer: 'cus_current', subscription: 'sub_new',
  });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).result.action, 'membership_upgraded');
  assert.deepEqual({ ...user() }, { membership_tier: 'paid', stripe_customer_id: 'cus_current', stripe_subscription_id: 'sub_new' });
});

test('an unpaid checkout links the subscription but upgrades only once Stripe says it is active', async (t) => {
  const { deliver, subscriptions, user } = await setup(t, { tier: 'free', customer: 'cus_current', subscription: null });
  subscriptions.sub_new = { customer: 'cus_current', status: 'incomplete' };
  let response = await deliver('checkout.session.completed', {
    mode: 'subscription', payment_status: 'unpaid', metadata: { userId: '1' }, customer: 'cus_current', subscription: 'sub_new',
  });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).result.action, 'subscription_linked');
  assert.deepEqual({ ...user() }, { membership_tier: 'free', stripe_customer_id: 'cus_current', stripe_subscription_id: 'sub_new' });

  subscriptions.sub_new.status = 'active';
  response = await deliver('customer.subscription.updated', { id: 'sub_new', status: 'active' });
  assert.equal(response.status, 200);
  assert.equal(user().membership_tier, 'paid');
});

test('a late checkout for a subscription that already ended is ignored', async (t) => {
  const { deliver, subscriptions, user } = await setup(t, { tier: 'free', customer: 'cus_current', subscription: null });
  subscriptions.sub_new = { customer: 'cus_current', status: 'canceled' };
  const before = { ...user() };
  const response = await deliver('checkout.session.completed', {
    mode: 'subscription', payment_status: 'paid', metadata: { userId: '1' }, customer: 'cus_current', subscription: 'sub_new',
  });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).result.handled, false);
  assert.deepEqual({ ...user() }, before);
});

test('a checkout whose subscription belongs to another customer is ignored', async (t) => {
  const { deliver, subscriptions, user } = await setup(t, { tier: 'free', customer: 'cus_current', subscription: null });
  subscriptions.sub_new = { customer: 'cus_someone_else', status: 'active' };
  const before = { ...user() };
  const response = await deliver('checkout.session.completed', {
    mode: 'subscription', metadata: { userId: '1' }, customer: 'cus_current', subscription: 'sub_new',
  });
  assert.equal(response.status, 200);
  assert.deepEqual({ ...user() }, before);
});

test('a checkout without metadata.userId never matches by email, only by the stored customer', async (t) => {
  const { deliver, subscriptions, calls, user } = await setup(t, { tier: 'free', customer: 'cus_current', subscription: null });
  subscriptions.sub_new = { customer: 'cus_unknown', status: 'active' };
  subscriptions.sub_mine = { customer: 'cus_current', status: 'active' };
  const twinBefore = { ...user(2) };
  let response = await deliver('checkout.session.completed', {
    mode: 'subscription', customer: 'cus_unknown', subscription: 'sub_new',
    customer_email: 'twin@example.com', customer_details: { email: 'twin@example.com' },
  });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).result.handled, false);
  assert.deepEqual({ ...user(2) }, twinBefore);
  assert.equal(calls.length, 0);

  response = await deliver('checkout.session.completed', { mode: 'subscription', customer: 'cus_current', subscription: 'sub_mine' });
  assert.equal(response.status, 200);
  assert.deepEqual({ ...user() }, { membership_tier: 'paid', stripe_customer_id: 'cus_current', stripe_subscription_id: 'sub_mine' });
});

test('non-subscription checkouts and malformed IDs are ignored without a Stripe call', async (t) => {
  const { deliver, calls, user } = await setup(t, { tier: 'free' });
  const before = { ...user() };
  for (const [type, object] of [
    ['checkout.session.completed', { mode: 'payment', metadata: { userId: '1' }, customer: 'cus_current', subscription: null }],
    ['checkout.session.completed', { mode: 'subscription', metadata: { userId: '1' }, customer: 'cus_current', subscription: { id: 'sub_x' } }],
    ['checkout.session.completed', { mode: 'subscription', metadata: { userId: '1' }, customer: 'cus_current', subscription: '../customers/cus_current' }],
    ['customer.subscription.updated', { customer: 'cus_current', status: 'active' }],
    ['customer.subscription.deleted', { id: 42 }],
    ['invoice.paid', { customer: 'cus_current' }],
  ]) {
    const response = await deliver(type, object);
    assert.equal(response.status, 200, type);
    assert.equal((await response.json()).result.handled, false, type);
  }
  assert.equal(calls.length, 0);
  assert.deepEqual({ ...user() }, before);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { createAuthEnv } from './helpers/auth-env.mjs';
import { call, loginHeaders } from './helpers/api.mjs';

async function setup(t, { existingCustomer = false } = {}) {
  const env = await createAuthEnv();
  t.after(() => env.sqlite.close());
  Object.assign(env, {
    STRIPE_SECRET_KEY: 'sk_test_isolated',
    STRIPE_MONTHLY_PRICE_ID: 'price_monthly_isolated',
    STRIPE_ANNUAL_PRICE_ID: 'price_annual_isolated',
  });
  const headers = await loginHeaders(env);
  if (existingCustomer) {
    env.sqlite.exec("UPDATE users SET stripe_customer_id = 'cus_isolated' WHERE id = 1");
  }

  const calls = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, options = {}) => {
    calls.push({ url: String(url), options });
    assert.equal(new URL(url).origin, 'https://api.stripe.com');
    assert.equal(options.method, 'POST');
    switch (new URL(url).pathname) {
      case '/v1/customers':
      case '/v1/customers/cus_isolated':
        return Response.json({ id: 'cus_isolated' });
      case '/v1/checkout/sessions':
        return Response.json({ id: 'cs_isolated', url: 'https://checkout.stripe.com/c/pay/cs_isolated' });
      default:
        throw new Error('Unexpected Stripe route');
    }
  };
  t.after(() => { globalThis.fetch = realFetch; });
  const checkout = (body) => call(env, 'billing/checkout-session', { method: 'POST', headers, body });
  return { env, calls, checkout };
}

for (const existingCustomer of [false, true]) {
  test(`invalid checkout plans are rejected before Stripe calls or writes (existing customer: ${existingCustomer})`, async (t) => {
    const { env, calls, checkout } = await setup(t, { existingCustomer });
    const before = env.sqlite.prepare('SELECT * FROM users WHERE id = 1').get();
    for (const plan of [
      undefined, null, true, false, 0, 1, {}, [], ['monthly'], ['annual'],
      { toString: 'monthly' }, '', 'weekly', 'Monthly', ' monthly', 'annual ',
      'constructor', 'toString', 'valueOf', '__proto__', 'hasOwnProperty',
    ]) {
      const response = await checkout({ plan });
      const label = `plan=${JSON.stringify(plan)}`;
      assert.equal(response.status, 400, label);
      assert.deepEqual(await response.json(), { error: 'Invalid or unavailable plan' }, label);
      assert.equal(response.headers.get('Cache-Control'), 'no-store', label);
      assert.equal(calls.length, 0, `${label}: no Stripe side effects`);
      assert.deepEqual(env.sqlite.prepare('SELECT * FROM users WHERE id = 1').get(), before, label);
    }
  });
}

test('allowed checkout plans without a configured price are rejected before Stripe calls or writes', async (t) => {
  const { env, calls, checkout } = await setup(t);
  const before = env.sqlite.prepare('SELECT * FROM users WHERE id = 1').get();
  for (const [plan, priceVariable] of [['monthly', 'STRIPE_MONTHLY_PRICE_ID'], ['annual', 'STRIPE_ANNUAL_PRICE_ID']]) {
    for (const value of [undefined, '']) {
      env[priceVariable] = value;
      const response = await checkout({ plan });
      assert.equal(response.status, 400, plan);
      assert.deepEqual(await response.json(), { error: 'Invalid or unavailable plan' });
      assert.equal(calls.length, 0);
      assert.deepEqual(env.sqlite.prepare('SELECT * FROM users WHERE id = 1').get(), before);
    }
  }
});

test('monthly and annual checkout use their configured Stripe prices and return the session URL', async (t) => {
  const { env, calls, checkout } = await setup(t);
  for (const [plan, price] of [['monthly', env.STRIPE_MONTHLY_PRICE_ID], ['annual', env.STRIPE_ANNUAL_PRICE_ID]]) {
    const response = await checkout({ plan });
    assert.equal(response.status, 200, plan);
    assert.deepEqual(await response.json(), { url: 'https://checkout.stripe.com/c/pay/cs_isolated' });
    const { options } = calls.at(-1);
    assert.equal(calls.at(-1).url, 'https://api.stripe.com/v1/checkout/sessions');
    const params = new URLSearchParams(options.body);
    assert.equal(params.get('line_items[0][price]'), price, plan);
    assert.equal(params.get('customer'), 'cus_isolated');
    assert.equal(params.get('mode'), 'subscription');
    assert.equal(params.get('line_items[0][quantity]'), '1');
  }
  assert.equal(calls.length, 4, 'one customer creation/update and one session per checkout');
  assert.equal(env.sqlite.prepare('SELECT stripe_customer_id FROM users WHERE id = 1').get().stripe_customer_id, 'cus_isolated');
});

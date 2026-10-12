import test from 'node:test';
import assert from 'node:assert/strict';
import { onRequest } from '../functions/api/[[path]].js';
import { createAuthEnv } from './helpers/auth-env.mjs';

const call = (env, path, { method = 'GET', headers = {}, body, origin = 'https://tagsta.sh' } = {}) =>
  onRequest({ env, request: new Request(`${origin}/api/${path}`, {
    method, headers: { 'Content-Type': 'application/json', ...headers },
    ...(body ? { body: JSON.stringify(body) } : {}),
  }) });

// Route outgoing fetches to per-host handlers and record them. Real AbortSignal.timeout deadlines
// are recorded and shortened to 25ms, so hung upstreams are exercised for real but quickly.
const withUpstreams = async (handlers, run) => {
  const realFetch = globalThis.fetch;
  const realTimeout = AbortSignal.timeout;
  const calls = [];
  const deadlines = [];
  AbortSignal.timeout = (ms) => { deadlines.push(ms); return realTimeout.call(AbortSignal, 25); };
  globalThis.fetch = async (url, options = {}) => {
    const { host, pathname } = new URL(String(url));
    calls.push({ host, pathname, options });
    const handler = handlers[host];
    if (!handler) throw new Error(`unexpected fetch to ${host}`);
    return handler({ pathname, options });
  };
  const realLog = { error: console.error, warn: console.warn };
  console.error = () => {};
  console.warn = () => {};
  try { await run({ calls, deadlines }); } finally {
    globalThis.fetch = realFetch;
    AbortSignal.timeout = realTimeout;
    Object.assign(console, realLog);
  }
};
const hang = ({ options }) => new Promise((_, reject) => {
  assert.ok(options.signal instanceof AbortSignal, 'every upstream call carries a deadline signal');
  options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true });
});
const networkDown = async () => { throw new TypeError('fetch failed'); };
const turnstileOk = (overrides = {}) => async () => Response.json({ success: true, hostname: 'tagsta.sh', action: 'support', ...overrides });
const emailOk = async () => Response.json({ success: true });

const supportEnv = async () => {
  const env = await createAuthEnv();
  Object.assign(env, { TURNSTILE_SECRET_KEY: 'isolated-test', CLOUDFLARE_API_TOKEN: 'isolated-test', CLOUDFLARE_ACCOUNT_ID: 'isolated-test' });
  return env;
};
const support = (env, origin) => call(env, 'support', {
  method: 'POST', origin, body: { email: 'visitor@example.com', message: 'Hello, I need some help please.', captchaToken: 'solved' },
});

test('Turnstile tokens solved on another hostname or for another action are refused', async () => {
  const env = await supportEnv();
  try {
    for (const [label, verdict, origin, expected] of [
      ['foreign hostname', { hostname: 'evil.example' }, undefined, 400],
      ['missing hostname', { hostname: undefined }, undefined, 400],
      ['wrong action', { action: 'login' }, undefined, 400],
      ['no action', { action: '' }, undefined, 400],
      ['success not strictly true', { success: 'true' }, undefined, 400],
      ['valid on the app hostname', {}, undefined, 201],
      ['APP_URL host from a preview deployment', {}, 'https://abc123.tagstash.pages.dev', 201],
      ['the preview host itself', { hostname: 'abc123.tagstash.pages.dev' }, 'https://abc123.tagstash.pages.dev', 201],
      ['local dev with a test-key placeholder hostname', { hostname: 'example.com' }, 'http://localhost:5105', 201],
    ]) {
      await withUpstreams({ 'challenges.cloudflare.com': turnstileOk(verdict), 'api.cloudflare.com': emailOk }, async ({ calls }) => {
        const response = await support(env, origin);
        assert.equal(response.status, expected, label);
        const sentEmail = calls.some((c) => c.host === 'api.cloudflare.com');
        assert.equal(sentEmail, expected === 201, `${label}: email sent only after a valid CAPTCHA`);
      });
    }
  } finally { env.sqlite.close(); }
});

test('hung or failing Turnstile and email upstreams answer 502 within their deadlines', async () => {
  const env = await supportEnv();
  try {
    await withUpstreams({ 'challenges.cloudflare.com': hang }, async ({ deadlines }) => {
      const response = await support(env);
      assert.equal(response.status, 502);
      assert.match((await response.json()).error, /Could not verify CAPTCHA/);
      assert.deepEqual(deadlines, [5000]);
    });
    await withUpstreams({ 'challenges.cloudflare.com': async () => new Response('<html>oops</html>', { status: 500 }) }, async () => {
      assert.equal((await support(env)).status, 502);
    });
    await withUpstreams({ 'challenges.cloudflare.com': turnstileOk(), 'api.cloudflare.com': hang }, async ({ deadlines }) => {
      const response = await support(env);
      assert.equal(response.status, 502);
      assert.deepEqual(deadlines, [5000, 10000]);
    });
    await withUpstreams({ 'challenges.cloudflare.com': turnstileOk(), 'api.cloudflare.com': networkDown }, async () => {
      assert.equal((await support(env)).status, 502);
    });
  } finally { env.sqlite.close(); }
});

test('registration rolls back with 502 when email times out, 503 when email is not configured', async () => {
  const env = await supportEnv();
  try {
    const register = () => call(env, 'auth/register', { method: 'POST', body: { username: 'newuser', email: 'new@example.com', password: 'new-user-password' } });
    await withUpstreams({ 'api.cloudflare.com': hang }, async ({ deadlines }) => {
      const response = await register();
      assert.equal(response.status, 502);
      assert.deepEqual(deadlines, [10000]);
    });
    assert.equal(env.sqlite.prepare("SELECT COUNT(*) AS n FROM users WHERE email = 'new@example.com'").get().n, 0);
    delete env.CLOUDFLARE_API_TOKEN;
    await withUpstreams({}, async ({ calls }) => {
      assert.equal((await register()).status, 503);
      assert.equal(calls.length, 0);
    });
    assert.equal(env.sqlite.prepare("SELECT COUNT(*) AS n FROM users WHERE email = 'new@example.com'").get().n, 0);
  } finally { env.sqlite.close(); }
});

const billingEnv = async () => {
  const env = await createAuthEnv();
  Object.assign(env, { STRIPE_SECRET_KEY: 'sk_test_isolated', STRIPE_MONTHLY_PRICE_ID: 'price_isolated' });
  const { token } = await (await call(env, 'auth/login', { method: 'POST', body: { email: 'session@example.com', password: env.password } })).json();
  return { env, headers: { Authorization: `Bearer ${token}` } };
};
const checkout = (env, headers) => call(env, 'billing/checkout-session', { method: 'POST', headers, body: { plan: 'monthly' } });

test('a hung or failing Stripe answers 502 with a predictable message, never a 500', async () => {
  const { env, headers } = await billingEnv();
  try {
    for (const [label, handler] of [
      ['timeout', hang],
      ['network failure', networkDown],
      ['Stripe 500', async () => Response.json({ error: { message: 'internal' } }, { status: 500 })],
      ['non-JSON body', async () => new Response('<html>bad gateway</html>', { status: 502 })],
    ]) {
      await withUpstreams({ 'api.stripe.com': handler }, async ({ deadlines }) => {
        const response = await checkout(env, headers);
        assert.equal(response.status, 502, label);
        assert.equal((await response.json()).error, 'The billing provider is temporarily unavailable. Please try again later.', label);
        assert.equal(deadlines[0], 15000, label);
      });
    }
    assert.equal(env.sqlite.prepare('SELECT stripe_customer_id FROM users').get().stripe_customer_id, null);

    // Status sync with a stored subscription takes the same path.
    env.sqlite.exec("UPDATE users SET stripe_customer_id = 'cus_1', stripe_subscription_id = 'sub_1'");
    await withUpstreams({ 'api.stripe.com': hang }, async () => {
      assert.equal((await call(env, 'billing/status', { headers })).status, 502);
    });
  } finally { env.sqlite.close(); }
});

test('customer and checkout creation send stable Idempotency-Keys, so a retry after a timeout reuses them', async () => {
  const { env, headers } = await billingEnv();
  try {
    let timeOutFirstCustomer = true;
    const stripe = async ({ pathname, options }) => {
      if (pathname === '/v1/customers') {
        if (timeOutFirstCustomer) { timeOutFirstCustomer = false; return hang({ options }); }
        return Response.json({ id: 'cus_isolated' });
      }
      if (pathname === '/v1/checkout/sessions') return Response.json({ id: 'cs_isolated', url: 'https://checkout.stripe.com/c/pay/cs_isolated' });
      return Response.json({ id: 'cus_isolated' });
    };
    await withUpstreams({ 'api.stripe.com': stripe }, async ({ calls }) => {
      assert.equal((await checkout(env, headers)).status, 502);
      const retry = await checkout(env, headers);
      assert.equal(retry.status, 200);
      assert.equal((await retry.json()).url, 'https://checkout.stripe.com/c/pay/cs_isolated');

      const keyOf = (c) => new Headers(c.options.headers).get('Idempotency-Key');
      const customerCalls = calls.filter((c) => c.pathname === '/v1/customers');
      assert.equal(customerCalls.length, 2);
      assert.match(keyOf(customerCalls[0]), /^tagstash-customer-1-\d+-[0-9a-f]{32}$/);
      assert.equal(keyOf(customerCalls[0]), keyOf(customerCalls[1]), 'the retry replays the same customer creation');
      const sessionCall = calls.find((c) => c.pathname === '/v1/checkout/sessions');
      assert.match(keyOf(sessionCall), /^tagstash-checkout-1-\d+-[0-9a-f]{32}$/);
    });
    assert.equal(env.sqlite.prepare('SELECT stripe_customer_id FROM users').get().stripe_customer_id, 'cus_isolated');

    // A customer Stripe no longer knows is replaced under a different key, never replayed.
    env.sqlite.exec("UPDATE users SET stripe_customer_id = 'cus_deleted'");
    let sessionAttempts = 0;
    await withUpstreams({
      'api.stripe.com': async ({ pathname }) => {
        if (pathname === '/v1/checkout/sessions' && sessionAttempts++ === 0) {
          return Response.json({ error: { message: "No such customer: 'cus_deleted'" } }, { status: 400 });
        }
        if (pathname === '/v1/customers') return Response.json({ id: 'cus_replacement' });
        return Response.json({ id: 'cs_2', url: 'https://checkout.stripe.com/c/pay/cs_2' });
      },
    }, async ({ calls }) => {
      assert.equal((await checkout(env, headers)).status, 200);
      const keys = calls.filter((c) => c.options.method === 'POST' && c.pathname !== '/v1/customers/cus_deleted')
        .map((c) => new Headers(c.options.headers).get('Idempotency-Key'));
      assert.equal(new Set(keys).size, keys.length, 'each distinct creation has its own key');
      // Updating an existing customer is naturally idempotent and sends no key.
      const update = calls.find((c) => c.pathname === '/v1/customers/cus_deleted');
      assert.equal(new Headers(update.options.headers).get('Idempotency-Key'), null);
    });
    assert.equal(env.sqlite.prepare('SELECT stripe_customer_id FROM users').get().stripe_customer_id, 'cus_replacement');
  } finally { env.sqlite.close(); }
});

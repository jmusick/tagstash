import test from 'node:test';
import assert from 'node:assert/strict';
import { createAuthEnv } from './helpers/auth-env.mjs';
import { call, loginHeaders } from './helpers/api.mjs';

const realFetch = globalThis.fetch;
const encoder = new TextEncoder();

// Installs a fake upstream. `routes` maps a URL to a function returning a Response.
function mockUpstream(routes) {
  const requested = [];
  globalThis.fetch = async (url, init = {}) => {
    requested.push({ url: String(url), redirect: init.redirect });
    const route = routes[String(url)];
    if (!route) throw new Error(`unexpected upstream fetch: ${url}`);
    return route();
  };
  return requested;
}

const html = (body, headers = {}) => () =>
  new Response(body, { headers: { 'Content-Type': 'text/html; charset=utf-8', ...headers } });
const redirect = (location, status = 302) => () => new Response(null, { status, headers: { Location: location } });

// A body that never ends; counts how much of it the server pulled and whether it hung up.
function endlessBody(firstChunk, chunkSize = 64 * 1024) {
  const state = { pulled: 0, cancelled: false };
  const filler = encoder.encode('<!-- '.padEnd(chunkSize, 'x'));
  state.stream = new ReadableStream({
    pull(controller) {
      state.pulled += 1;
      controller.enqueue(state.pulled === 1 ? encoder.encode(firstChunk) : filler);
    },
    cancel() { state.cancelled = true; },
  }, { highWaterMark: 0 });
  return state;
}

async function setup() {
  const env = await createAuthEnv();
  return { env, headers: await loginHeaders(env) };
}

const meta = (env, headers, url, route = 'bookmarks/meta') => call(env, route, { method: 'POST', headers, body: { url } });

test('local, private, link-local and credentialed destinations are refused before any fetch', async () => {
  const { env, headers } = await setup();
  const requested = mockUpstream({});
  try {
    for (const url of [
      'http://localhost/', 'http://LOCALHOST./admin', 'http://app.localhost:5106/', 'http://intranet/',
      'http://printer.local/', 'http://metadata.google.internal/computeMetadata/v1/', 'http://router.home.arpa/',
      'http://127.0.0.1/', 'http://127.1/', 'http://2130706433/', 'http://0x7f000001/', 'http://0.0.0.0/',
      'http://10.1.2.3/', 'http://172.20.0.1/', 'http://192.168.0.10/', 'http://100.64.0.1/',
      'http://169.254.169.254/latest/meta-data/', 'http://224.0.0.1/', 'http://255.255.255.255/',
      'http://[::1]/', 'http://[::]/', 'http://[::ffff:127.0.0.1]/', 'http://[::ffff:a9fe:a9fe]/',
      'http://[fe80::1]/', 'http://[fd12:3456::1]/', 'http://[fc00::1]/', 'http://[ff02::1]/',
      'http://[64:ff9b::a00:1]/', 'http://[2002:c0a8:0101::1]/', 'http://[2001:db8::1]/',
      'https://user:secret@example.com/', 'https://user@example.com/',
      'ftp://example.com/', 'file:///etc/passwd',
    ]) {
      const response = await meta(env, headers, url);
      assert.equal(response.status, 400, url);
      assert.ok((await response.json()).error, url);
    }
    assert.deepEqual(requested, []);
  } finally { globalThis.fetch = realFetch; env.sqlite.close(); }
});

test('public hosts, including public IPv4/IPv6 literals, are fetched with manual redirects', async () => {
  const { env, headers } = await setup();
  const page = html('<html><head><title>Tom&#x27;s &amp;amp; bar</title><meta name="description" content="Tom\'s diner &amp; bar"></head></html>');
  const requested = mockUpstream({
    'https://example.com/': page,
    'http://93.184.216.34/': page,
    'http://[2606:4700:4700::1111]/': page,
    'https://medium.com/@someone?ref=a@b.co': page,
  });
  try {
    for (const url of ['example.com', 'http://93.184.216.34/', 'http://[2606:4700:4700::1111]/', 'https://medium.com/@someone?ref=a@b.co']) {
      const response = await meta(env, headers, url);
      assert.equal(response.status, 200, url);
      // cleanScrapedText decodes exactly once: &amp;amp; stays &amp;.
      assert.deepEqual(await response.json(), { title: 'Tom\'s &amp; bar', description: 'Tom\'s diner & bar' });
    }
    assert.ok(requested.every((r) => r.redirect === 'manual'));
  } finally { globalThis.fetch = realFetch; env.sqlite.close(); }
});

test('every redirect hop is validated: a pivot to a private address is refused unfetched', async () => {
  const { env, headers } = await setup();
  const requested = mockUpstream({
    'https://example.com/go': redirect('/next', 301),
    'https://example.com/next': redirect('http://169.254.169.254/latest/meta-data/'),
    'https://example.com/creds': redirect('https://admin:pw@example.org/'),
    'https://example.com/ok': redirect('https://www.example.com/landing', 308),
    'https://www.example.com/landing': html('<title>Landed</title>'),
  });
  try {
    let response = await meta(env, headers, 'https://example.com/go');
    assert.equal(response.status, 502);
    assert.match((await response.json()).error, /redirected to a URL that cannot be fetched/);
    assert.deepEqual(requested.map((r) => r.url), ['https://example.com/go', 'https://example.com/next']);

    response = await meta(env, headers, 'https://example.com/creds');
    assert.equal(response.status, 502);

    response = await meta(env, headers, 'https://example.com/ok');
    assert.equal(response.status, 200);
    assert.equal((await response.json()).title, 'Landed');
  } finally { globalThis.fetch = realFetch; env.sqlite.close(); }
});

test('redirect chains are capped at five hops', async () => {
  const { env, headers } = await setup();
  const routes = {};
  for (let i = 0; i < 10; i += 1) routes[`https://example.com/${i}`] = redirect(`https://example.com/${i + 1}`);
  const requested = mockUpstream(routes);
  try {
    const response = await meta(env, headers, 'https://example.com/0');
    assert.equal(response.status, 502);
    assert.match((await response.json()).error, /too many times/);
    assert.equal(requested.length, 6); // the original request plus five followed redirects
  } finally { globalThis.fetch = realFetch; env.sqlite.close(); }
});

test('non-HTML responses are refused without reading the body', async () => {
  const { env, headers } = await setup();
  const body = endlessBody('%PDF-1.7');
  mockUpstream({
    'https://example.com/file.pdf': () => new Response(body.stream, { headers: { 'Content-Type': 'application/pdf' } }),
    'https://example.com/untyped': () => new Response('<title>x</title>', { headers: { 'Content-Type': '' } }),
  });
  try {
    let response = await meta(env, headers, 'https://example.com/file.pdf');
    assert.equal(response.status, 422);
    assert.match((await response.json()).error, /did not return an HTML page/);
    assert.equal(body.pulled, 0);
    assert.equal(body.cancelled, true);

    response = await meta(env, headers, 'https://example.com/untyped', 'bookmarks/meta-description');
    assert.equal(response.status, 422);
  } finally { globalThis.fetch = realFetch; env.sqlite.close(); }
});

test('oversized HTML is read only up to the cap, then the stream is cancelled', async () => {
  const { env, headers } = await setup();
  const huge = endlessBody('<html><head><title>Big page</title><meta name="description" content="Still found">');
  const tidy = endlessBody('<html><head><title>Small</title></head><body>');
  mockUpstream({
    'https://example.com/huge': () => new Response(huge.stream, { headers: { 'Content-Type': 'text/html' } }),
    'https://example.com/tidy': () => new Response(tidy.stream, { headers: { 'Content-Type': 'application/xhtml+xml' } }),
  });
  try {
    let response = await meta(env, headers, 'https://example.com/huge');
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { title: 'Big page', description: 'Still found' });
    // 512 KB in 64 KB chunks: nine pulls at most (the first chunk is tiny), never the whole stream.
    assert.ok(huge.pulled <= 10, `pulled ${huge.pulled} chunks`);
    assert.equal(huge.cancelled, true);

    // A page whose </head> arrives early stops right there.
    response = await meta(env, headers, 'https://example.com/tidy');
    assert.equal((await response.json()).title, 'Small');
    assert.equal(tidy.pulled, 1);
    assert.equal(tidy.cancelled, true);
  } finally { globalThis.fetch = realFetch; env.sqlite.close(); }
});

test('scraped values are clamped to the bookmark field limits', async () => {
  const { env, headers } = await setup();
  mockUpstream({
    'https://example.com/': html(`<title>${'t'.repeat(5000)}</title><meta name="description" content="${'d'.repeat(20000)}">`),
  });
  try {
    const body = await (await meta(env, headers, 'https://example.com/')).json();
    assert.equal(body.title.length, 1000);
    assert.equal(body.description.length, 10000);
  } finally { globalThis.fetch = realFetch; env.sqlite.close(); }
});

test('metadata lookups are rate limited per account and the log stays out of the admin view', async () => {
  const { env, headers } = await setup();
  const requested = mockUpstream({ 'https://example.com/': html('<title>Hi</title>') });
  try {
    const insert = env.sqlite.prepare("INSERT INTO auth_events (event_type, user_id) VALUES ('metadata_fetch', ?)");
    for (let i = 0; i < 59; i += 1) insert.run(1);
    insert.run(2); // another account's lookups don't count against this one

    assert.equal((await meta(env, headers, 'https://example.com/')).status, 200);
    const limited = await meta(env, headers, 'https://example.com/', 'bookmarks/meta-description');
    assert.equal(limited.status, 429);
    assert.match((await limited.json()).error, /Too many page lookups/);
    assert.equal(requested.length, 1);

    // Old rows age out of the window (and are pruned on the next recorded use).
    env.sqlite.exec("UPDATE auth_events SET created_at = datetime('now', '-2 days') WHERE event_type = 'metadata_fetch'");
    assert.equal((await meta(env, headers, 'https://example.com/')).status, 200);
    assert.equal(env.sqlite.prepare("SELECT COUNT(*) AS n FROM auth_events WHERE event_type = 'metadata_fetch' AND user_id = 1").get().n, 1);
  } finally { globalThis.fetch = realFetch; env.sqlite.close(); }
});

test('without the auth_events table the budget fails open', async () => {
  const { env, headers } = await setup();
  mockUpstream({ 'https://example.com/': html('<title>Hi</title>') });
  try {
    env.sqlite.exec('DROP TABLE auth_events');
    assert.equal((await meta(env, headers, 'https://example.com/')).status, 200);
  } finally { globalThis.fetch = realFetch; env.sqlite.close(); }
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { onRequest } from '../functions/api/[[path]].js';
import { onRequestGet } from '../functions/u/[username].js';
import { createAuthEnv } from './helpers/auth-env.mjs';

const hostile = '</script><img/src=x/onerror=alert(1)>';
const webHeaders = { Origin: 'https://tagsta.sh', 'X-Tagstash-Client': 'web', 'Content-Type': 'application/json' };

// Minimal stand-in for the Workers HTMLRewriter: only the <head> append is needed here.
class FakeRewriter {
  constructor() { this.handlers = {}; }
  on(selector, handler) { this.handlers[selector] = handler; return this; }
  async transform(response) {
    let appended = '';
    this.handlers.head?.element({ append: (content) => { appended += content; } });
    return new Response((await response.text()).replace('</head>', `${appended}</head>`), response);
  }
}

test('profile JSON-LD cannot close its script element', async () => {
  globalThis.HTMLRewriter = FakeRewriter;
  const shell = '<html><head><title>x</title></head><body></body></html>';
  const env = {
    DB: {
      prepare: () => ({
        bind() { return this; },
        async first() { return { id: 1, username: hostile, profile_public: 1 }; },
        async all() { return { results: [{ name: 'profile_public' }, { name: 'is_private' }] }; },
      }),
    },
  };
  const response = await onRequestGet({
    request: new Request(`https://tagsta.sh/u/${encodeURIComponent(hostile)}`),
    env,
    params: { username: encodeURIComponent(hostile) },
    next: async () => new Response(shell, { headers: { 'Content-Type': 'text/html' } }),
  });
  const html = await response.text();
  const block = html.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/);
  assert.ok(block, 'JSON-LD block present');
  assert.ok(!block[1].includes('<'));
  assert.equal(JSON.parse(block[1]).mainEntity.name, hostile);
  assert.ok(!html.includes('<img/src=x'));
});

test('registration refuses hostile usernames; grandfathered ones are HTML-escaped in email', async () => {
  const env = await createAuthEnv();
  env.CLOUDFLARE_API_TOKEN = 't'; env.CLOUDFLARE_ACCOUNT_ID = 'a';
  const sent = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => { sent.push(JSON.parse(init.body)); return new Response('{"success":true}', { status: 200 }); };
  try {
    const register = (username) => onRequest({ env, request: new Request('https://tagsta.sh/api/auth/register', {
      method: 'POST', headers: webHeaders, body: JSON.stringify({ username, email: `${username.length}@example.com`, password: 'long-enough-pass' }) }) });
    assert.equal((await register('a')).status, 400);
    assert.equal((await register('x'.repeat(51))).status, 400);
    assert.equal((await register(hostile)).status, 400);
    // Names from before the username policy (#17) can still hold markup, so emails must escape them.
    env.sqlite.prepare('INSERT INTO users (username, email, password_hash, email_verified) VALUES (?, ?, ?, 1)')
      .run(hostile, 'hostile@example.com', 'x');
    const background = [];
    const reset = await onRequest({ env, waitUntil: (promise) => background.push(promise), request: new Request('https://tagsta.sh/api/auth/forgot-password', {
      method: 'POST', headers: webHeaders, body: JSON.stringify({ email: 'hostile@example.com' }) }) });
    assert.equal(reset.status, 200, await reset.clone().text());
    await Promise.all(background);
    assert.ok(sent.length > 0, 'reset email sent');
    const html = sent.map((m) => m.html || '').join('');
    assert.ok(html.includes('&lt;/script&gt;'));
    assert.ok(!html.includes('<img/src=x'));
  } finally { globalThis.fetch = realFetch; env.sqlite.close(); }
});

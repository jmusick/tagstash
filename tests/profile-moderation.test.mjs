import test from 'node:test';
import assert from 'node:assert/strict';
import bcrypt from 'bcryptjs';
import { onRequest } from '../functions/api/[[path]].js';
import { onRequestGet as profilePage } from '../functions/u/[username].js';
import { onRequestGet as sitemap } from '../functions/sitemap.xml.js';
import { PROFILE_INDEXING_BAR, isProfileIndexable } from '../functions/_lib/profileVisibility.js';
import { createAuthEnv } from './helpers/auth-env.mjs';

// Minimal stand-in for the Workers HTMLRewriter: only the <head> append matters here.
class FakeRewriter {
  constructor() { this.handlers = {}; }
  on(selector, handler) { this.handlers[selector] = handler; return this; }
  async transform(response) {
    let appended = '';
    this.handlers.head?.element({ append: (content) => { appended += content; } });
    return new Response((await response.text()).replace('</head>', `${appended}</head>`), response);
  }
}

const shell = '<!doctype html><html><head><title>x</title></head><body><div id="root"></div></body></html>';
const webHeaders = { Origin: 'https://tagsta.sh', 'X-Tagstash-Client': 'web' };
const OLD = '2025-01-01 00:00:00';
const OTHER_PASSWORD = 'other-user-password';

const call = (env, path, { method = 'GET', headers = {}, body } = {}) =>
  onRequest({ env, request: new Request(`https://tagsta.sh/api/${path}`, {
    method, headers: { 'Content-Type': 'application/json', ...headers },
    ...(body ? { body: JSON.stringify(body) } : {}),
  }) });

const sessionFor = async (env, email, password) => {
  const response = await call(env, 'auth/login', { method: 'POST', headers: webHeaders, body: { email, password } });
  assert.equal(response.status, 200, `login as ${email}`);
  return { ...webHeaders, Cookie: response.headers.get('Set-Cookie').split(';')[0] };
};

// sessiontester (session@example.com, from the helper) is the configured super admin.
const setup = async () => {
  const env = await createAuthEnv();
  env.SUPER_ADMIN_EMAIL = 'session@example.com';
  return env;
};

const insertUser = async (env, username, { isPublic = 1, verified = 1, createdAt = OLD, password } = {}) =>
  Number(env.sqlite.prepare(
    `INSERT INTO users (username, email, password_hash, email_verified, profile_public, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(username, `${username}@example.com`, password ? await bcrypt.hash(password, 4) : 'x', verified, isPublic, createdAt)
    .lastInsertRowid);

const addBookmarks = (env, userId, count, { isPrivate = 0 } = {}) => {
  for (let i = 0; i < count; i += 1) {
    env.sqlite.prepare(
      `INSERT INTO bookmarks (user_id, title, url, is_private, created_at, updated_at)
       VALUES (?, 't', ?, ?, '2026-03-04 10:00:00', '2026-03-04 10:00:00')`,
    ).run(userId, `https://example.com/${userId}/${i}`, isPrivate);
  }
};

const getProfilePage = (env, username) => {
  globalThis.HTMLRewriter = FakeRewriter;
  return profilePage({
    request: new Request(`https://tagsta.sh/u/${username}`),
    env,
    params: { username },
    next: async () => new Response(shell, { headers: { 'Content-Type': 'text/html' } }),
  });
};

const getSitemap = async (env) =>
  (await sitemap({ request: new Request('https://tagsta.sh/sitemap.xml'), env })).text();

test('a non-admin cannot suspend, unsuspend or make a profile private', async () => {
  const env = await setup();
  try {
    await insertUser(env, 'regular', { password: OTHER_PASSWORD });
    const target = await insertUser(env, 'spammer');
    const headers = await sessionFor(env, 'regular@example.com', OTHER_PASSWORD);
    for (const action of ['suspend', 'unsuspend', 'make-private']) {
      const response = await call(env, `auth/admin/users/${target}/${action}`, { method: 'POST', headers });
      assert.equal(response.status, 403, action);
    }
    assert.equal((await call(env, `auth/admin/users/${target}/suspend`, { method: 'POST', headers: webHeaders })).status, 401);
    const row = env.sqlite.prepare('SELECT suspended_at, profile_public FROM users WHERE id = ?').get(target);
    assert.equal(row.suspended_at, null);
    assert.equal(row.profile_public, 1);
  } finally { env.sqlite.close(); }
});

test('a suspended profile is a 404 in SSR and the API, identical to a missing one, and leaves the sitemap', async () => {
  const env = await setup();
  try {
    const spammer = await insertUser(env, 'spammer');
    addBookmarks(env, spammer, 6);
    assert.equal((await getProfilePage(env, 'spammer')).status, 200);
    assert.ok((await getSitemap(env)).includes('/u/spammer'));

    const admin = await sessionFor(env, 'session@example.com', env.password);
    const response = await call(env, `auth/admin/users/${spammer}/suspend`, { method: 'POST', headers: admin });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).changed, true);

    const page = await getProfilePage(env, 'spammer');
    assert.equal(page.status, 404);
    assert.equal(page.headers.get('X-Robots-Tag'), 'noindex');
    const html = await page.text();
    assert.ok(!/suspend/i.test(html));
    assert.ok(html.includes("This profile doesn&#39;t exist or isn&#39;t public."));

    const api = await call(env, 'profiles/spammer');
    const missing = await call(env, 'profiles/nobodyhere');
    assert.equal(api.status, 404);
    assert.deepEqual(await api.json(), await missing.json());
    assert.ok(!(await getSitemap(env)).includes('/u/spammer'));

    // profile_public itself was left alone; the event names the acting admin.
    const row = env.sqlite.prepare('SELECT profile_public, suspended_at, suspended_by FROM users WHERE id = ?').get(spammer);
    assert.equal(row.profile_public, 1);
    assert.ok(row.suspended_at);
    assert.equal(row.suspended_by, 1);
    const event = env.sqlite.prepare("SELECT * FROM auth_events WHERE event_type = 'admin_account_suspended'").get();
    assert.equal(event.user_id, spammer);
    assert.equal(event.actor_user_id, 1);
    assert.equal(event.email, 'spammer@example.com');

    const events = await (await call(env, 'auth/admin/auth-events', { headers: admin })).json();
    assert.equal(events.events.find((e) => e.event_type === 'admin_account_suspended').actor_username, 'sessiontester');
  } finally { env.sqlite.close(); }
});

test('a suspended user can still sign in, but cannot set profile_public=1 until unsuspended', async () => {
  const env = await setup();
  try {
    const owner = await insertUser(env, 'owner', { isPublic: 0, password: OTHER_PASSWORD });
    const admin = await sessionFor(env, 'session@example.com', env.password);
    assert.equal((await call(env, `auth/admin/users/${owner}/suspend`, { method: 'POST', headers: admin })).status, 200);

    const headers = await sessionFor(env, 'owner@example.com', OTHER_PASSWORD);
    const me = await (await call(env, 'auth/me', { headers })).json();
    assert.equal(me.user.suspended, true);
    assert.equal((await call(env, 'bookmarks', { headers })).status, 200);

    const refused = await call(env, 'auth/profile-public', { method: 'PUT', headers, body: { profilePublic: true } });
    assert.equal(refused.status, 403);
    assert.equal((await refused.json()).suspended, true);
    assert.equal(env.sqlite.prepare('SELECT profile_public FROM users WHERE id = ?').get(owner).profile_public, 0);
    // Turning it off is always allowed.
    assert.equal((await call(env, 'auth/profile-public', { method: 'PUT', headers, body: { profilePublic: false } })).status, 200);

    assert.equal((await call(env, `auth/admin/users/${owner}/unsuspend`, { method: 'POST', headers: admin })).status, 200);
    assert.equal((await (await call(env, 'auth/me', { headers })).json()).user.suspended, false);
    assert.equal((await call(env, 'auth/profile-public', { method: 'PUT', headers, body: { profilePublic: true } })).status, 200);
  } finally { env.sqlite.close(); }
});

test('suspending signs the account out everywhere; the owner can sign back in', async () => {
  const env = await setup();
  try {
    const owner = await insertUser(env, 'signedin', { password: OTHER_PASSWORD });
    const before = await sessionFor(env, 'signedin@example.com', OTHER_PASSWORD);
    assert.equal((await call(env, 'auth/me', { headers: before })).status, 200);

    const admin = await sessionFor(env, 'session@example.com', env.password);
    assert.equal((await call(env, `auth/admin/users/${owner}/suspend`, { method: 'POST', headers: admin })).status, 200);

    assert.equal((await call(env, 'auth/me', { headers: before })).status, 403);
    const after = await sessionFor(env, 'signedin@example.com', OTHER_PASSWORD);
    assert.equal((await call(env, 'auth/me', { headers: after })).status, 200);
    // The admin's own session is untouched.
    assert.equal((await call(env, 'auth/me', { headers: admin })).status, 200);
  } finally { env.sqlite.close(); }
});

test('unsuspending does not re-publish a profile an admin made private', async () => {
  const env = await setup();
  try {
    const target = await insertUser(env, 'target');
    addBookmarks(env, target, 5);
    const admin = await sessionFor(env, 'session@example.com', env.password);
    for (const action of ['make-private', 'suspend', 'unsuspend']) {
      assert.equal((await call(env, `auth/admin/users/${target}/${action}`, { method: 'POST', headers: admin })).status, 200, action);
    }
    assert.equal(env.sqlite.prepare('SELECT profile_public FROM users WHERE id = ?').get(target).profile_public, 0);
    assert.equal((await getProfilePage(env, 'target')).status, 404);
    const types = env.sqlite.prepare('SELECT event_type, actor_user_id FROM auth_events ORDER BY id').all()
      .filter((e) => e.event_type.startsWith('admin_'));
    assert.deepEqual(types.map((e) => e.event_type), ['admin_profile_made_private', 'admin_account_suspended', 'admin_account_unsuspended']);
    assert.ok(types.every((e) => e.actor_user_id === 1));
  } finally { env.sqlite.close(); }
});

test('admins cannot suspend themselves or the configured super admin', async () => {
  const env = await setup();
  try {
    const admin = await sessionFor(env, 'session@example.com', env.password);
    const response = await call(env, 'auth/admin/users/1/suspend', { method: 'POST', headers: admin });
    assert.equal(response.status, 400);
    assert.equal(env.sqlite.prepare('SELECT suspended_at FROM users WHERE id = 1').get().suspended_at, null);
    assert.equal((await call(env, 'auth/admin/users/999/suspend', { method: 'POST', headers: admin })).status, 404);
  } finally { env.sqlite.close(); }
});

test('a public profile below the bar renders 200 with noindex, is out of the sitemap, and the API says so', async () => {
  const env = await setup();
  try {
    // Each fails exactly one criterion of the bar.
    addBookmarks(env, await insertUser(env, 'thin'), PROFILE_INDEXING_BAR.minPublicBookmarks - 1);
    const thinPrivate = await insertUser(env, 'thinprivate');
    addBookmarks(env, thinPrivate, 4);
    addBookmarks(env, thinPrivate, 10, { isPrivate: 1 });
    addBookmarks(env, await insertUser(env, 'brandnew', { createdAt: new Date().toISOString().slice(0, 19).replace('T', ' ') }), 6);
    addBookmarks(env, await insertUser(env, 'unverified', { verified: 0 }), 6);

    const xml = await getSitemap(env);
    for (const username of ['thin', 'thinprivate', 'brandnew', 'unverified']) {
      const page = await getProfilePage(env, username);
      assert.equal(page.status, 200, username);
      assert.equal(page.headers.get('X-Robots-Tag'), 'noindex', username);
      const html = await page.text();
      assert.match(html, /<meta name="robots" content="noindex" \/>/, username);
      assert.ok(html.includes(`<link rel="canonical" href="https://tagsta.sh/u/${username}" />`));
      assert.ok(!xml.includes(`/u/${username}<`), username);

      const api = await call(env, `profiles/${username}`);
      assert.equal(api.status, 200);
      const body = await api.json();
      assert.equal(body.profile.indexable, false, username);
      assert.equal(body.profile.username, username);
    }
  } finally { env.sqlite.close(); }
});

test('a public profile above the bar is indexed and listed', async () => {
  const env = await setup();
  try {
    const good = await insertUser(env, 'goodprofile');
    addBookmarks(env, good, PROFILE_INDEXING_BAR.minPublicBookmarks);
    const page = await getProfilePage(env, 'goodprofile');
    assert.equal(page.status, 200);
    assert.equal(page.headers.get('X-Robots-Tag'), null);
    assert.ok(!(await page.text()).includes('name="robots"'));
    assert.match(await getSitemap(env), /<loc>https:\/\/tagsta\.sh\/u\/goodprofile<\/loc><lastmod>2026-03-04<\/lastmod>/);
    const body = await (await call(env, 'profiles/goodprofile')).json();
    assert.equal(body.profile.indexable, true);
    // The documented fields are unchanged.
    assert.deepEqual(Object.keys(body).sort(), ['appliedTags', 'bookmarks', 'profile', 'tags']);
    assert.equal(body.bookmarks.length, 5);
  } finally { env.sqlite.close(); }
});

test('the bar treats D1 timestamps as UTC and needs a full 14 days', () => {
  const now = Date.parse('2026-10-15T12:00:00Z');
  const base = { email_verified: 1, public_bookmark_count: 5 };
  assert.equal(isProfileIndexable({ ...base, created_at: '2026-10-01 12:00:00' }, now), true);
  assert.equal(isProfileIndexable({ ...base, created_at: '2026-10-01 12:00:01' }, now), false);
  assert.equal(isProfileIndexable({ ...base, created_at: 'garbage' }, now), false);
  assert.equal(isProfileIndexable({ ...base, created_at: OLD, suspended_at: '2026-10-02 00:00:00' }, now), false);
});

test('before migration 0016 everything fails safe: nobody is suspended and suspend answers 503', async () => {
  const env = await setup();
  try {
    env.sqlite.exec('ALTER TABLE users DROP COLUMN suspended_at; ALTER TABLE users DROP COLUMN suspended_by; ALTER TABLE auth_events DROP COLUMN actor_user_id');
    const owner = await insertUser(env, 'legacyowner', { password: OTHER_PASSWORD });
    addBookmarks(env, owner, 5);
    const admin = await sessionFor(env, 'session@example.com', env.password);

    for (const action of ['suspend', 'unsuspend']) {
      assert.equal((await call(env, `auth/admin/users/${owner}/${action}`, { method: 'POST', headers: admin })).status, 503, action);
    }
    const users = await (await call(env, 'auth/admin/users', { headers: admin })).json();
    assert.equal(users.moderationAvailable, false);
    assert.equal(users.users.find((u) => u.username === 'legacyowner').suspended_at, null);
    assert.equal((await call(env, 'auth/admin/auth-events', { headers: admin })).status, 200);

    assert.equal((await getProfilePage(env, 'legacyowner')).status, 200);
    assert.equal((await call(env, 'profiles/legacyowner')).status, 200);
    assert.ok((await getSitemap(env)).includes('/u/legacyowner'));

    const headers = await sessionFor(env, 'legacyowner@example.com', OTHER_PASSWORD);
    assert.equal((await (await call(env, 'auth/me', { headers })).json()).user.suspended, false);
    assert.equal((await call(env, 'auth/profile-public', { method: 'PUT', headers, body: { profilePublic: true } })).status, 200);

    // make-private only needs profile_public, so it keeps working and is still logged.
    assert.equal((await call(env, `auth/admin/users/${owner}/make-private`, { method: 'POST', headers: admin })).status, 200);
    assert.equal(env.sqlite.prepare("SELECT COUNT(*) AS n FROM auth_events WHERE event_type = 'admin_profile_made_private'").get().n, 1);
  } finally { env.sqlite.close(); }
});

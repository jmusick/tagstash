import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createAuthEnv } from './helpers/auth-env.mjs';
import { call, loginHeaders } from './helpers/api.mjs';

async function setup(options) {
  const env = await createAuthEnv(options);
  const session = await loginHeaders(env);
  const response = await call(env, 'auth/api-keys', { method: 'POST', headers: session, body: { name: 'Library script' } });
  assert.equal(response.status, 201);
  const { apiKey, apiKeyMetadata } = await response.json();
  return { env, session, apiKey, id: apiKeyMetadata.id, headers: { Authorization: `Bearer ${apiKey}` } };
}

test('keys read and write bookmarks and tags, import, and export the complete owner library', async () => {
  const { env, headers } = await setup();
  try {
    env.sqlite.exec(`INSERT INTO users (id, username, email, password_hash) VALUES (2, 'other', 'other@example.test', 'x');
      INSERT INTO bookmarks (user_id, title, url) VALUES (2, 'Foreign', 'https://foreign.example/');`);
    const created = await call(env, 'bookmarks', { method: 'POST', headers,
      body: { title: 'Saved', url: 'https://example.test/', tags: ['old'] } });
    assert.equal(created.status, 201);
    const { bookmark } = await created.json();
    assert.equal((await call(env, `bookmarks/${bookmark.id}`, { method: 'PUT', headers,
      body: { title: 'Edited', url: bookmark.url, tags: ['old'], description: 'Script note' } })).status, 200);
    assert.equal((await call(env, `bookmarks/${bookmark.id}/favorite`, { method: 'POST', headers })).status, 200);
    assert.equal((await call(env, `bookmarks/${bookmark.id}/private`, { method: 'POST', headers })).status, 200);
    const { tags } = await (await call(env, 'bookmarks/tags/all', { headers })).json();
    assert.equal(tags.length, 1);
    assert.equal((await call(env, `bookmarks/tags/${tags[0].id}`, { method: 'PUT', headers, body: { name: 'renamed' } })).status, 200);
    const { tags: renamed } = await (await call(env, 'bookmarks/tags/all', { headers })).json();
    assert.equal(renamed[0].name, 'renamed');
    assert.equal((await call(env, `bookmarks/tags/${renamed[0].id}/favorite`, { method: 'POST', headers })).status, 200);
    const imported = await call(env, 'bookmarks/import', { method: 'POST', headers,
      body: { bookmarks: [{ title: 'Imported', url: 'https://import.example/', tags: ['imported'] }] } });
    assert.equal(imported.status, 200);
    assert.equal((await imported.json()).imported, 1);
    // Export uses GET /bookmarks, the same complete library the Settings exporters consume.
    const { bookmarks } = await (await call(env, 'bookmarks', { headers })).json();
    assert.equal(bookmarks.length, 2);
    assert.ok(bookmarks.some((row) => row.id === bookmark.id && row.is_private));
    assert.ok(!bookmarks.some((row) => row.user_id === 2));
    assert.equal((await call(env, `bookmarks/tags/${renamed[0].id}`, { method: 'DELETE', headers })).status, 200);
    assert.equal((await call(env, `bookmarks/${bookmark.id}`, { method: 'DELETE', headers })).status, 200);
    assert.equal((await call(env, 'bookmarks/1', { method: 'DELETE', headers })).status, 404);
    assert.equal(env.sqlite.prepare('SELECT COUNT(*) AS n FROM bookmarks WHERE user_id = 2').get().n, 1);
  } finally { env.sqlite.close(); }
});

test('keys cannot authenticate any excluded route category, even alongside a valid session cookie', async () => {
  const { env, headers } = await setup();
  try {
    const login = await call(env, 'auth/login', { method: 'POST',
      headers: { Origin: env.APP_URL, 'X-Tagstash-Client': 'web' },
      body: { email: 'session@example.com', password: env.password } });
    const Cookie = login.headers.get('Set-Cookie').split(';')[0];
    const excluded = [
      ['GET', 'auth/me'], ['PUT', 'auth/username'], ['PUT', 'auth/theme'],
      ['PUT', 'auth/password'], ['POST', 'auth/forgot-password'], ['POST', 'auth/reset-password'],
      ['PUT', 'auth/email'], ['GET', 'auth/verify-email?token=x'], ['PUT', 'auth/profile-public'],
      ['POST', 'auth/session'], ['POST', 'auth/login'], ['POST', 'auth/logout'],
      ['GET', 'auth/api-keys'], ['POST', 'auth/api-keys'],
      ['DELETE', 'auth/api-keys/1'], ['DELETE', 'auth/api-keys/1/permanent'],
      ['POST', 'auth/delete-account'], ['POST', 'auth/resume-deletion'], ['POST', 'auth/reset-library'],
      ['GET', 'billing/status'], ['POST', 'billing/checkout-session'], ['POST', 'billing/portal-session'],
      ['POST', 'billing/webhook'], ['GET', 'auth/admin/users'], ['PATCH', 'auth/admin/users/2'],
      ['DELETE', 'auth/admin/users/2'], ['POST', 'auth/admin/users/2/suspend'],
      ['POST', 'auth/admin/users/2/make-private'], ['GET', 'auth/admin/auth-events'], ['POST', 'support'],
    ];
    for (const [method, path] of excluded) {
      const response = await call(env, path, { method, headers: { ...headers, Cookie },
        ...(method !== 'GET' ? { body: {} } : {}) });
      assert.equal(response.status, 403, `${method} ${path}`);
      assert.deepEqual(await response.json(), { error: 'Invalid or expired token' });
      assert.equal(response.headers.get('Set-Cookie'), null);
    }
    assert.equal(env.sqlite.prepare('SELECT last_used_at FROM api_keys').get().last_used_at, null);
    assert.equal(env.sqlite.prepare('SELECT revoked_at FROM api_keys').get().revoked_at, null);
  } finally { env.sqlite.close(); }
});

test('revoked, unknown, malformed, and cookie-carried keys fail with the same generic error', async () => {
  const { env, session, headers, apiKey, id } = await setup();
  try {
    assert.equal((await call(env, `auth/api-keys/${id}`, { method: 'DELETE', headers: session })).status, 200);
    for (const requestHeaders of [headers,
      { Authorization: `Bearer tsk_${'f'.repeat(48)}` },
      { Authorization: 'Bearer tsk_short' },
      { Authorization: `Bearer tsk_${'g'.repeat(48)}` },
      { Authorization: `Bearer ${apiKey} extra` },
      { Cookie: `__Host-tagstash-session=${apiKey}` },
    ]) {
      const response = await call(env, 'bookmarks', { headers: requestHeaders });
      assert.equal(response.status, 403);
      assert.deepEqual(await response.json(), { error: 'Invalid or expired token' });
    }
    assert.equal(env.sqlite.prepare('SELECT last_used_at FROM api_keys').get().last_used_at, null);
  } finally { env.sqlite.close(); }
});

test('keys re-read account status and tier; session token_version changes do not revoke keys', async () => {
  const { env, session, headers } = await setup();
  try {
    env.sqlite.exec('UPDATE users SET token_version = token_version + 1');
    assert.equal((await call(env, 'bookmarks', { headers: session })).status, 403);
    assert.equal((await call(env, 'bookmarks', { headers })).status, 200);
    for (const column of ['suspended_at', 'deletion_started_at']) {
      env.sqlite.exec(`UPDATE users SET ${column} = CURRENT_TIMESTAMP`);
      assert.equal((await call(env, 'bookmarks', { headers })).status, 403, column);
      assert.equal((await call(env, 'bookmarks', { method: 'POST', headers,
        body: { title: 'Blocked', url: 'https://blocked.example/' } })).status, 403, column);
      env.sqlite.exec(`UPDATE users SET ${column} = NULL`);
    }
    env.sqlite.exec('DELETE FROM users WHERE id = 1');
    assert.equal((await call(env, 'bookmarks', { headers })).status, 403);
  } finally { env.sqlite.close(); }
});

test('key usage timestamps are throttled atomically, optional, and best-effort', async () => {
  const { env, headers } = await setup({ queryLatency: true });
  try {
    env.sqlite.exec(`CREATE TABLE usage_writes (n INTEGER NOT NULL);
      INSERT INTO usage_writes VALUES (0);
      CREATE TRIGGER count_usage AFTER UPDATE OF last_used_at ON api_keys
      BEGIN UPDATE usage_writes SET n = n + 1; END;`);
    const burst = () => Promise.all(Array.from({ length: 8 }, () => call(env, 'bookmarks', { headers })));
    assert.ok((await burst()).every((response) => response.status === 200));
    assert.equal(env.sqlite.prepare('SELECT n FROM usage_writes').get().n, 1);
    assert.ok(env.sqlite.prepare('SELECT last_used_at FROM api_keys').get().last_used_at);
    await burst();
    assert.equal(env.sqlite.prepare('SELECT n FROM usage_writes').get().n, 1);
    env.sqlite.exec("DROP TRIGGER count_usage; UPDATE api_keys SET last_used_at = datetime('now', '-2 minutes');");
    assert.equal((await call(env, 'bookmarks', { headers })).status, 200);
    assert.ok(Date.parse(env.sqlite.prepare('SELECT last_used_at FROM api_keys').get().last_used_at + 'Z') > Date.now() - 60_000);
    env.sqlite.exec(`UPDATE api_keys SET last_used_at = NULL;
      CREATE TRIGGER fail_usage BEFORE UPDATE OF last_used_at ON api_keys
      BEGIN SELECT RAISE(FAIL, 'usage metadata unavailable'); END;`);
    assert.equal((await call(env, 'bookmarks', { headers })).status, 200);
    env.sqlite.exec('DROP TRIGGER fail_usage; ALTER TABLE api_keys DROP COLUMN last_used_at;');
    assert.equal((await call(env, 'bookmarks', { headers })).status, 200);
  } finally { env.sqlite.close(); }
});

test('hash-only lookup uses the same SQL and generic failure for unknown and revoked keys', async () => {
  const { env, headers, apiKey } = await setup();
  try {
    const queries = [];
    const prepare = env.DB.prepare.bind(env.DB);
    env.DB.prepare = (sql) => {
      const statement = prepare(sql);
      if (/FROM api_keys WHERE key_hash/.test(sql)) {
        const bind = statement.bind.bind(statement);
        statement.bind = (...args) => { queries.push({ sql, args }); return bind(...args); };
      }
      return statement;
    };
    env.sqlite.exec('UPDATE api_keys SET revoked_at = CURRENT_TIMESTAMP');
    assert.equal((await call(env, 'bookmarks', { headers })).status, 403);
    const unknown = `tsk_${'a'.repeat(48)}`;
    assert.equal((await call(env, 'bookmarks', { headers: { Authorization: `Bearer ${unknown}` } })).status, 403);
    assert.equal(queries.length, 2);
    assert.equal(queries[0].sql, queries[1].sql);
    assert.deepEqual(queries.map((q) => q.args), [apiKey, unknown].map((key) => [createHash('sha256').update(key).digest('hex')]));
  } finally { env.sqlite.close(); }
});

test('bearer keys need no cookie origin proof and cannot bypass it through cookie fallback', async () => {
  const { env, headers, apiKey } = await setup();
  try {
    const login = await call(env, 'auth/login', { method: 'POST',
      headers: { Origin: env.APP_URL, 'X-Tagstash-Client': 'web' },
      body: { email: 'session@example.com', password: env.password } });
    const Cookie = login.headers.get('Set-Cookie').split(';')[0];
    const write = (requestHeaders) => call(env, 'bookmarks', { method: 'POST', headers: requestHeaders,
      body: { title: 'Script', url: `https://script.example/${crypto.randomUUID()}` } });
    assert.equal((await write(headers)).status, 201);
    const crossOrigin = await write({ ...headers, Cookie, Origin: 'https://untrusted.example' });
    assert.equal(crossOrigin.status, 201);
    assert.equal(crossOrigin.headers.get('Access-Control-Allow-Origin'), null);
    assert.equal(crossOrigin.headers.get('Access-Control-Allow-Credentials'), null);
    assert.equal((await write({ Cookie, Origin: 'https://untrusted.example' })).status, 403);
    assert.equal((await write({ ...headers, Cookie, Origin: 'https://untrusted.example', 'X-Tagstash-Client': 'web' })).status, 403);
    assert.equal((await write({ Authorization: 'Bearer tsk_bad', Cookie })).status, 403);
    for (const Authorization of [`Bearer  ${apiKey}`, `Bearer\t${apiKey}`, `Bearer ${apiKey} extra`, 'Bearer']) {
      const web = { Authorization, Cookie, Origin: env.APP_URL, 'X-Tagstash-Client': 'web' };
      assert.equal((await write(web)).status, 403, Authorization);
      assert.equal((await call(env, 'auth/me', { headers: web })).status, 403, Authorization);
    }
  } finally { env.sqlite.close(); }
});

test('concurrent key imports and saves share the free-plan limit and use the current account tier', async () => {
  const { env, headers } = await setup({ queryLatency: true });
  try {
    for (let i = 0; i < 49; i += 1) env.sqlite.prepare('INSERT INTO bookmarks (user_id, title, url) VALUES (1, ?, ?)').run(`Seed ${i}`, `https://seed.example/${i}`);
    const results = await Promise.all([
      call(env, 'bookmarks/import', { method: 'POST', headers,
        body: { bookmarks: [{ title: 'Import', url: 'https://import.example/' }] } }),
      ...Array.from({ length: 6 }, (_, i) => call(env, 'bookmarks', { method: 'POST', headers,
        body: { title: `Save ${i}`, url: `https://save.example/${i}` } })),
    ]);
    assert.ok(results.every((response) => [200, 201, 403].includes(response.status)));
    assert.equal(env.sqlite.prepare('SELECT COUNT(*) AS n FROM bookmarks').get().n, 50);
    env.sqlite.exec("UPDATE users SET membership_tier = 'paid'");
    assert.equal((await call(env, 'bookmarks', { method: 'POST', headers,
      body: { title: 'Paid', url: 'https://paid.example/' } })).status, 201);
  } finally { env.sqlite.close(); }
});

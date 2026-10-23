import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { onRequest } from '../functions/api/[[path]].js';
import { createAuthEnv } from './helpers/auth-env.mjs';

const webHeaders = { Origin: 'https://tagsta.sh', 'X-Tagstash-Client': 'web', 'Content-Type': 'application/json' };
const LEGACY_CIPHERTEXT = 'a1b2c3d4e5f6a1b2c3d4e5f6:deadbeefcafebabe0011223344556677';
const LEGACY_PLAINTEXT = 'tsk_legacylegacylegacylegacylegacylegacylegacyle';

async function setup() {
  const env = await createAuthEnv();
  const login = await onRequest({ env, request: new Request('https://tagsta.sh/api/auth/login', {
    method: 'POST', headers: webHeaders, body: JSON.stringify({ email: 'session@example.com', password: env.password }) }) });
  assert.equal(login.status, 200);
  const cookie = login.headers.get('Set-Cookie').split(';')[0];
  const call = (method, path, body) => onRequest({ env, request: new Request(`https://tagsta.sh/api/auth/${path}`, {
    method, headers: { ...webHeaders, Cookie: cookie }, body: body === undefined ? undefined : JSON.stringify(body) }) });
  return { env, call };
}

test('creating a key returns the plaintext once and stores only its hash', async () => {
  const { env, call } = await setup();
  try {
    const response = await call('POST', 'api-keys', { name: 'CLI' });
    assert.equal(response.status, 201);
    const { apiKey, apiKeyMetadata } = await response.json();
    assert.match(apiKey, /^tsk_[0-9a-f]{48}$/);
    assert.equal(apiKeyMetadata.name, 'CLI');
    assert.equal(apiKeyMetadata.key_prefix, apiKey.slice(0, 8));
    assert.equal(apiKeyMetadata.key_last4, apiKey.slice(-4));
    assert.ok(!('api_key' in apiKeyMetadata) && !('encrypted_key' in apiKeyMetadata));

    const row = env.sqlite.prepare('SELECT * FROM api_keys WHERE id = ?').get(apiKeyMetadata.id);
    assert.equal(row.key_hash, createHash('sha256').update(apiKey).digest('hex'));
    assert.equal(row.encrypted_key, null);
    assert.ok(!Object.values(row).includes(apiKey));

    const listText = await (await call('GET', 'api-keys')).text();
    assert.ok(!listText.includes(apiKey), 'list must never contain the plaintext key');
    assert.ok(!listText.includes(row.key_hash), 'list must not contain the hash');
  } finally { env.sqlite.close(); }
});

test('legacy rows with an encrypted value are listed as metadata only', async () => {
  const { env, call } = await setup();
  try {
    env.sqlite.prepare(`INSERT INTO api_keys (user_id, name, key_hash, encrypted_key, key_prefix, key_last4)
      VALUES (1, 'Legacy', ?, ?, 'tsk_lega', 'gyle')`).run(createHash('sha256').update(LEGACY_PLAINTEXT).digest('hex'), LEGACY_CIPHERTEXT);
    const response = await call('GET', 'api-keys');
    assert.equal(response.status, 200);
    const text = await response.text();
    assert.ok(!text.includes(LEGACY_CIPHERTEXT) && !text.includes(LEGACY_PLAINTEXT));
    const { apiKeys } = JSON.parse(text);
    assert.equal(apiKeys.length, 1);
    assert.deepEqual(Object.keys(apiKeys[0]).sort(),
      ['created_at', 'id', 'key_last4', 'key_prefix', 'last_used_at', 'name', 'revoked_at']);
    assert.equal(apiKeys[0].key_prefix, 'tsk_lega');
  } finally { env.sqlite.close(); }
});

test('the 0015 migration clears legacy encrypted values', async () => {
  const { env } = await setup();
  try {
    env.sqlite.prepare(`INSERT INTO api_keys (user_id, name, key_hash, encrypted_key, key_prefix, key_last4)
      VALUES (1, 'Legacy', 'h', ?, 'tsk_lega', 'gyle')`).run(LEGACY_CIPHERTEXT);
    const { readFileSync } = await import('node:fs');
    env.sqlite.exec(readFileSync(new URL('../d1/migrations/0015_api_keys_hash_only.sql', import.meta.url), 'utf8'));
    const row = env.sqlite.prepare('SELECT encrypted_key, key_hash FROM api_keys').get();
    assert.equal(row.encrypted_key, null);
    assert.equal(row.key_hash, 'h');
  } finally { env.sqlite.close(); }
});

test('revoke and permanent delete still work and are scoped to the owner', async () => {
  const { env, call } = await setup();
  try {
    const { apiKeyMetadata: { id } } = await (await call('POST', 'api-keys', { name: 'temp' })).json();
    env.sqlite.prepare(`INSERT INTO users (id, username, email, password_hash, email_verified) VALUES (2, 'other', 'o@example.com', 'x', 1)`).run();
    env.sqlite.prepare(`INSERT INTO api_keys (id, user_id, name, key_hash, key_prefix, key_last4) VALUES (99, 2, 'foreign', 'fh', 'tsk_xxxx', 'xxxx')`).run();

    assert.equal((await call('DELETE', 'api-keys/99')).status, 404);
    assert.equal((await call('DELETE', 'api-keys/99/permanent')).status, 404);

    assert.equal((await call('DELETE', `api-keys/${id}`)).status, 200);
    assert.equal((await call('DELETE', `api-keys/${id}`)).status, 404);
    assert.ok(env.sqlite.prepare('SELECT revoked_at FROM api_keys WHERE id = ?').get(id).revoked_at);

    assert.equal((await call('DELETE', `api-keys/${id}/permanent`)).status, 200);
    assert.equal(env.sqlite.prepare('SELECT COUNT(*) AS n FROM api_keys WHERE id = ?').get(id).n, 0);
    assert.equal(env.sqlite.prepare('SELECT COUNT(*) AS n FROM api_keys WHERE id = 99').get().n, 1);
  } finally { env.sqlite.close(); }
});

test('active keys are capped per user; revoking one frees a slot', async () => {
  const { env, call } = await setup();
  try {
    const ids = [];
    for (let i = 0; i < 10; i += 1) {
      const response = await call('POST', 'api-keys', { name: `k${i}` });
      assert.equal(response.status, 201);
      ids.push((await response.json()).apiKeyMetadata.id);
    }
    assert.equal((await call('POST', 'api-keys', { name: 'over' })).status, 400);
    assert.equal((await call('DELETE', `api-keys/${ids[0]}`)).status, 200);
    assert.equal((await call('POST', 'api-keys', { name: 'again' })).status, 201);
  } finally { env.sqlite.close(); }
});

test('a personal API key cannot authenticate account or key-management routes', async () => {
  const { env, call } = await setup();
  try {
    const { apiKey } = await (await call('POST', 'api-keys', { name: 'bearer' })).json();
    for (const path of ['auth/me', 'auth/api-keys']) {
      const response = await onRequest({ env, request: new Request(`https://tagsta.sh/api/${path}`, {
        headers: { Authorization: `Bearer ${apiKey}` } }) });
      // Key credentials never grant account or key-management access.
      assert.ok([401, 403].includes(response.status), `${path} -> ${response.status}`);
    }
    const lastUsed = env.sqlite.prepare('SELECT last_used_at FROM api_keys').get().last_used_at;
    assert.equal(lastUsed, null);
  } finally { env.sqlite.close(); }
});

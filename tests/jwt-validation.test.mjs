import test from 'node:test';
import assert from 'node:assert/strict';
import { SignJWT, jwtVerify } from 'jose';
import { onRequest } from '../functions/api/[[path]].js';
import { createAuthEnv } from './helpers/auth-env.mjs';

const webHeaders = { Origin: 'https://tagsta.sh', 'X-Tagstash-Client': 'web' };
const me = (env, headers) => onRequest({ env, request: new Request('https://tagsta.sh/api/auth/me', { headers }) });
const asBearer = (token) => ({ Authorization: `Bearer ${token}` });
const asCookie = (token) => ({ ...webHeaders, Cookie: `__Host-tagstash-session=${token}` });
const now = () => Math.floor(Date.now() / 1000);

// Signs with the real secret, so only the claim checks can reject these.
const sign = (env, claims, { iat = now(), exp = now() + 3600 } = {}) => {
  let jwt = new SignJWT(claims).setProtectedHeader({ alg: 'HS256' });
  if (iat !== null) jwt = jwt.setIssuedAt(iat);
  if (exp !== null) jwt = jwt.setExpirationTime(exp);
  return jwt.sign(new TextEncoder().encode(env.JWT_SECRET));
};

test('a correctly signed token without exp (or iat) is rejected for bearer and cookie use', async () => {
  const env = await createAuthEnv();
  try {
    const noExpBearer = await sign(env, { id: 1, tv: 0 }, { exp: null });
    const noExpWeb = await sign(env, { id: 1, tv: 0, session: 'web' }, { exp: null });
    const noIatBearer = await sign(env, { id: 1, tv: 0 }, { iat: null });
    assert.equal((await me(env, asBearer(noExpBearer))).status, 403);
    assert.equal((await me(env, asCookie(noExpWeb))).status, 403);
    assert.equal((await me(env, asBearer(noIatBearer))).status, 403);
    // The same claims with exp + iat are accepted, so it is the missing claim that fails.
    assert.equal((await me(env, asBearer(await sign(env, { id: 1, tv: 0 })))).status, 200);
  } finally { env.sqlite.close(); }
});

test('tokens with an unexpected claim shape are rejected', async () => {
  const env = await createAuthEnv();
  try {
    for (const [label, claims, times, headers] of [
      ['string id', { id: '1', tv: 0 }, {}, asBearer],
      ['missing id', { tv: 0 }, {}, asBearer],
      ['non-numeric tv', { id: 1, tv: 'x' }, {}, asBearer],
      ['unknown session type', { id: 1, tv: 0, session: 'admin' }, {}, asBearer],
      ['bearer lifetime beyond 60 days', { id: 1, tv: 0 }, { exp: now() + 61 * 86400 }, asBearer],
      ['web lifetime beyond 7 days', { id: 1, tv: 0, session: 'web' }, { exp: now() + 8 * 86400 }, asCookie],
      ['issued in the future', { id: 1, tv: 0 }, { iat: now() + 3600, exp: now() + 7200 }, asBearer],
      ['foreign issuer', { id: 1, tv: 0, iss: 'someone-else' }, {}, asBearer],
      ['foreign audience', { id: 1, tv: 0, aud: 'another-api' }, {}, asBearer],
    ]) {
      assert.equal((await me(env, headers(await sign(env, claims, times)))).status, 403, label);
    }
  } finally { env.sqlite.close(); }
});

test('tokens issued before iss/aud existed keep working, at their full original lifetimes', async () => {
  const env = await createAuthEnv();
  try {
    // Shape signUserToken produced before this change: no iss/aud, 60-day bearer, 7-day web.
    const legacyBearer = await sign(env, { id: 1, username: 'sessiontester', role: 'user', membershipTier: 'free', tv: 0 }, { exp: now() + 60 * 86400 });
    const legacyWeb = await sign(env, { id: 1, username: 'sessiontester', role: 'user', membershipTier: 'free', tv: 0, session: 'web' }, { exp: now() + 7 * 86400 });
    // Pre-0011 tokens carry no tv claim at all.
    const preVersioned = await sign(env, { id: 1, username: 'sessiontester', role: 'user', membershipTier: 'free' }, { exp: now() + 60 * 86400 });
    assert.equal((await me(env, asBearer(legacyBearer))).status, 200);
    assert.equal((await me(env, asCookie(legacyWeb))).status, 200);
    assert.equal((await me(env, asBearer(preVersioned))).status, 200);
  } finally { env.sqlite.close(); }
});

test('newly issued bearer and web tokens carry exp, iat, iss and aud and pass validation', async () => {
  const env = await createAuthEnv();
  try {
    const login = (headers) => onRequest({ env, request: new Request('https://tagsta.sh/api/auth/login', {
      method: 'POST', headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify({ email: 'session@example.com', password: env.password }),
    }) });
    const { token } = await (await login({})).json();
    const cookie = (await login(webHeaders)).headers.get('Set-Cookie').split(';')[0];
    const webToken = cookie.slice(cookie.indexOf('=') + 1);
    for (const [issued, lifetime] of [[token, 60 * 86400], [webToken, 7 * 86400]]) {
      const { payload } = await jwtVerify(issued, new TextEncoder().encode(env.JWT_SECRET));
      assert.equal(payload.iss, 'tagsta.sh');
      assert.equal(payload.aud, 'tagstash-api');
      assert.equal(payload.exp - payload.iat, lifetime);
      assert.equal(payload.id, 1);
    }
    assert.equal((await me(env, asBearer(token))).status, 200);
    assert.equal((await me(env, { Cookie: cookie })).status, 200);
  } finally { env.sqlite.close(); }
});

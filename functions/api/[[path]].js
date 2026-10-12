import bcrypt from 'bcryptjs';
import { SignJWT, jwtVerify } from 'jose';

const MEMBERSHIP_TIERS = {
  FREE: 'free',
  PAID: 'paid',
};

const USER_ROLES = {
  USER: 'user',
  SUPER_ADMIN: 'super_admin',
};

const FREE_BOOKMARK_LIMIT = 50;

const FETCH_HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.5',
};

// CORS is an allowlist, not a wildcard. The web app is same-origin (and Vite
// proxies /api in dev), and the extension normally bypasses CORS via its
// host_permissions — the extension entries only matter when a user has
// revoked the extension's site access. Firefox assigns each install a random
// moz-extension:// UUID, so that scheme can only be allowed as a whole.
const ALLOWED_ORIGINS = new Set([
  'https://tagsta.sh',
  'http://localhost:3000',
  'http://localhost:5173',
  'chrome-extension://ijoaejbpaibpodnohjmlbeanfhjdgoab',
]);

const isAllowedOrigin = (origin, env) => {
  if (!origin) return false;
  if (ALLOWED_ORIGINS.has(origin)) return true;
  if (origin.startsWith('moz-extension://')) return true;
  if (!env.APP_URL) return false;
  try {
    return new URL(env.APP_URL).origin === origin;
  } catch {
    return false;
  }
};

const WEB_SESSION_SECONDS = 7 * 24 * 60 * 60;
const isWebClient = (request) => request.headers.get('X-Tagstash-Client') === 'web';
const isLocalRequest = (request) => {
  const url = new URL(request.url);
  return url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
};
const sessionCookieName = (request) => isLocalRequest(request) ? 'tagstash-session' : '__Host-tagstash-session';
const getSessionCookie = (request) => {
  const name = `${sessionCookieName(request)}=`;
  return (request.headers.get('Cookie') || '').split(';').map((part) => part.trim())
    .find((part) => part.startsWith(name))?.slice(name.length) || null;
};
const sessionCookie = (request, token, maxAge = WEB_SESSION_SECONDS) =>
  `${sessionCookieName(request)}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${isLocalRequest(request) ? '' : '; Secure'}`;

// Only the web origin can use credentialed CORS. Extension origins keep bearer auth.
const isWebOrigin = (origin, request, env) => {
  if (!origin || origin === 'null') return false;
  if (origin === new URL(request.url).origin) return true;
  if (isLocalRequest(request) && ['http://localhost:3000', 'http://localhost:5173'].includes(origin)) return true;
  if (!env.APP_URL) return false;
  try {
    return origin === new URL(env.APP_URL).origin;
  } catch {
    return false;
  }
};
const hasWebRequestProof = (request, env) => {
  if (!isWebClient(request)) return false;
  const origin = request.headers.get('Origin');
  if (origin) return isWebOrigin(origin, request, env);
  const referer = request.headers.get('Referer');
  if (referer) {
    try { return isWebOrigin(new URL(referer).origin, request, env); } catch { return false; }
  }
  return request.headers.get('Sec-Fetch-Site') === 'same-origin';
};

const sessionResponse = (request, data) => {
  if (!isWebClient(request)) return jsonResponse(data);
  const { token, ...body } = data;
  const response = jsonResponse(body);
  response.headers.set('Cache-Control', 'no-store');
  response.headers.set('Set-Cookie', sessionCookie(request, token));
  return response;
};

// /api/profiles/* is the unauthenticated, GET-only public profile API that
// third-party sites fetch directly, so it keeps the wildcard.
const corsHeadersFor = (request, env) => {
  const origin = request.headers.get('Origin');
  const isPublicApi = new URL(request.url).pathname.startsWith('/api/profiles/');
  let allowOrigin = null;
  if (isPublicApi) allowOrigin = '*';
  else if (isAllowedOrigin(origin, env)) allowOrigin = origin;
  return {
    ...(allowOrigin ? { 'Access-Control-Allow-Origin': allowOrigin } : {}),
    ...(!isPublicApi && isWebOrigin(origin, request, env) ? { 'Access-Control-Allow-Credentials': 'true' } : {}),
    'Access-Control-Allow-Methods': 'GET,POST,PUT,PATCH,DELETE,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Tagstash-Client, X-Tagstash-Webhook-Secret',
    Vary: 'Origin',
  };
};

const withCors = (response, request, env) => {
  for (const [name, value] of Object.entries(corsHeadersFor(request, env))) {
    response.headers.set(name, value);
  }
  return response;
};

const encoder = new TextEncoder();

// --- Email sending (Cloudflare Email Sending REST API) ---

const sendEmail = async ({ to, from, subject, text, html, replyTo }, env) => {
  if (!env.CLOUDFLARE_API_TOKEN) throw new Error('Missing CLOUDFLARE_API_TOKEN');
  if (!env.CLOUDFLARE_ACCOUNT_ID) throw new Error('Missing CLOUDFLARE_ACCOUNT_ID');

  const response = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${env.CLOUDFLARE_ACCOUNT_ID}/email/sending/send`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${env.CLOUDFLARE_API_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        to,
        from,
        subject,
        text,
        html,
        ...(replyTo ? { reply_to: replyTo } : {}),
      }),
    }
  );

  const data = await response.json().catch(() => null);
  if (!response.ok || !data?.success) {
    const message = data?.errors?.[0]?.message || `Cloudflare Email Sending error: ${response.status}`;
    throw new Error(message);
  }
};

// --- Email verification helpers ---

// Each email purpose has its own "from" address, overridable via env for self-hosters.
const emailFrom = (purposeVar, fallback, env) => env[purposeVar] || env.EMAIL_FROM || fallback;

const generateVerificationToken = () => {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
};

const sendVerificationEmail = async (email, username, token, env) => {
  const appUrl = (env.APP_URL || 'http://localhost:5173').replace(/\/$/, '');
  const verifyUrl = `${appUrl}/verify-email?token=${token}`;
  const fromAddress = emailFrom('EMAIL_FROM_VERIFICATION', 'welcome@tagsta.sh', env);
  const replyTo = env.EMAIL_REPLY_TO || undefined;
  const textBody = [
    `Hi ${username},`,
    '',
    'Thanks for signing up for Tagstash. Please verify your email address by opening this link:',
    verifyUrl,
    '',
    'This link expires in 24 hours.',
    'If you did not create a Tagstash account, you can ignore this email.',
  ].join('\n');
  const htmlBody = `
<div style="font-family: -apple-system, Segoe UI, Roboto, Helvetica, Arial, sans-serif; line-height: 1.5; color: #111827;">
  <p>Hi ${escapeHtml(username)},</p>
  <p>Thanks for signing up for Tagstash. Please verify your email address by clicking the button below:</p>
  <p>
    <a href="${verifyUrl}" style="display:inline-block;padding:10px 16px;background:#111827;color:#ffffff;text-decoration:none;border-radius:6px;">Verify email address</a>
  </p>
  <p>If the button does not work, copy and paste this link into your browser:</p>
  <p><a href="${verifyUrl}">${verifyUrl}</a></p>
  <p>This link expires in 24 hours.</p>
  <p>If you did not create a Tagstash account, you can safely ignore this email.</p>
</div>`;

  await sendEmail(
    {
      from: fromAddress,
      to: email,
      replyTo,
      subject: 'Verify your Tagstash email address',
      text: textBody,
      html: htmlBody,
    },
    env
  );
};

const sendPasswordResetEmail = async (email, username, token, env) => {
  const appUrl = (env.APP_URL || 'http://localhost:5173').replace(/\/$/, '');
  const resetUrl = `${appUrl}/reset-password?token=${token}`;
  const fromAddress = emailFrom('EMAIL_FROM_PASSWORD_RESET', 'support@tagsta.sh', env);
  const replyTo = env.EMAIL_REPLY_TO || undefined;

  const textBody = [
    `Hi ${username},`,
    '',
    'We received a request to reset your Tagstash password. Click the link below to choose a new one:',
    resetUrl,
    '',
    'This link expires in 1 hour.',
    'If you did not request a password reset, you can safely ignore this email.',
  ].join('\n');

  const htmlBody = `
<div style="font-family: -apple-system, Segoe UI, Roboto, Helvetica, Arial, sans-serif; line-height: 1.5; color: #111827;">
  <p>Hi ${escapeHtml(username)},</p>
  <p>We received a request to reset your Tagstash password. Click the button below to choose a new one:</p>
  <p>
    <a href="${resetUrl}" style="display:inline-block;padding:10px 16px;background:#111827;color:#ffffff;text-decoration:none;border-radius:6px;">Reset password</a>
  </p>
  <p>If the button does not work, copy and paste this link into your browser:</p>
  <p><a href="${resetUrl}">${resetUrl}</a></p>
  <p>This link expires in 1 hour.</p>
  <p>If you did not request a password reset, you can safely ignore this email.</p>
</div>`;

  await sendEmail(
    {
      from: fromAddress,
      to: email,
      replyTo,
      subject: 'Reset your Tagstash password',
      text: textBody,
      html: htmlBody,
    },
    env
  );
};

const escapeHtml = (value) =>
  String(value).replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));

const sendEmailChangeConfirmation = async (newEmail, username, token, env) => {
  const appUrl = (env.APP_URL || 'http://localhost:5173').replace(/\/$/, '');
  const confirmUrl = `${appUrl}/verify-email?token=${token}`;
  const safeName = escapeHtml(username);
  await sendEmail(
    {
      from: emailFrom('EMAIL_FROM_VERIFICATION', 'welcome@tagsta.sh', env),
      to: newEmail,
      replyTo: env.EMAIL_REPLY_TO || undefined,
      subject: 'Confirm your new Tagstash email address',
      text: [
        `Hi ${username},`,
        '',
        'Open this link to confirm this address as the new email for your Tagstash account:',
        confirmUrl,
        '',
        'This link expires in 24 hours. You will be signed out everywhere and must sign in again.',
        'If you did not request this change, ignore this email and nothing will change.',
      ].join('\n'),
      html: `
<div style="font-family: -apple-system, Segoe UI, Roboto, Helvetica, Arial, sans-serif; line-height: 1.5; color: #111827;">
  <p>Hi ${safeName},</p>
  <p>Confirm this address as the new email for your Tagstash account:</p>
  <p><a href="${confirmUrl}" style="display:inline-block;padding:10px 16px;background:#111827;color:#ffffff;text-decoration:none;border-radius:6px;">Confirm new email</a></p>
  <p>If the button does not work, copy and paste this link into your browser:</p>
  <p><a href="${confirmUrl}">${confirmUrl}</a></p>
  <p>This link expires in 24 hours. You will be signed out everywhere and must sign in again.</p>
  <p>If you did not request this change, ignore this email and nothing will change.</p>
</div>`,
    },
    env
  );
};

// Tell the address being replaced. Best effort: never blocks the change itself.
const notifyOldEmailAboutChange = async (oldEmail, username, newEmail, completed, env) => {
  try {
    await sendEmail(
      {
        from: emailFrom('EMAIL_FROM_PASSWORD_RESET', 'support@tagsta.sh', env),
        to: oldEmail,
        replyTo: env.EMAIL_REPLY_TO || undefined,
        subject: completed ? 'Your Tagstash email address was changed' : 'Email change requested on your Tagstash account',
        text: [
          `Hi ${username},`,
          '',
          completed
            ? `The email address on your Tagstash account was changed to ${newEmail}.`
            : `A change of your Tagstash email address to ${newEmail} was requested. Nothing changes until that address is confirmed.`,
          'If this was not you, reset your password immediately and contact support.',
        ].join('\n'),
        html: `
<div style="font-family: -apple-system, Segoe UI, Roboto, Helvetica, Arial, sans-serif; line-height: 1.5; color: #111827;">
  <p>Hi ${escapeHtml(username)},</p>
  <p>${completed
    ? `The email address on your Tagstash account was changed to ${escapeHtml(newEmail)}.`
    : `A change of your Tagstash email address to ${escapeHtml(newEmail)} was requested. Nothing changes until that address is confirmed.`}</p>
  <p>If this was not you, reset your password immediately and contact support.</p>
</div>`,
      },
      env
    );
  } catch (error) {
    console.warn('[auth] Failed to notify previous email address', error?.message || error);
  }
};

const jsonResponse = (payload, status = 200) =>
  new Response(JSON.stringify(payload), {
    status,
    headers: {
      'Content-Type': 'application/json',
    },
  });

const normalizeEmail = (email) =>
  typeof email === 'string' ? email.trim().toLowerCase() : '';

const superAdminEmail = (env) =>
  normalizeEmail(env.SUPER_ADMIN_EMAIL || '');

const isSuperAdminEmail = (email, env) =>
  normalizeEmail(email) === superAdminEmail(env);

const getRoleForEmail = (email, env) =>
  isSuperAdminEmail(email, env) ? USER_ROLES.SUPER_ADMIN : USER_ROLES.USER;

const isPaidTier = (tier) => tier === MEMBERSHIP_TIERS.PAID;

const extractDomain = (url) => {
  try {
    return new URL(url).hostname;
  } catch {
    return 'favicon';
  }
};

const getFaviconUrl = (url) => `https://www.google.com/s2/favicons?sz=64&domain=${extractDomain(url)}`;

// Scraped titles/descriptions come straight out of the HTML source, so they arrive
// entity-encoded (`&amp;`, `&#x27;`). Decode once here so what we store is plain text —
// there's no DOMParser in Workers to do it for us.
const HTML_NAMED_ENTITIES = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  ensp: ' ',
  emsp: ' ',
  thinsp: ' ',
  shy: '',
  hellip: '…',
  mdash: '—',
  ndash: '–',
  lsquo: '‘',
  rsquo: '’',
  sbquo: '‚',
  ldquo: '“',
  rdquo: '”',
  bdquo: '„',
  laquo: '«',
  raquo: '»',
  bull: '•',
  middot: '·',
  dagger: '†',
  prime: '′',
  Prime: '″',
  copy: '©',
  reg: '®',
  trade: '™',
  deg: '°',
  plusmn: '±',
  times: '×',
  divide: '÷',
  frac12: '½',
  euro: '€',
  pound: '£',
  yen: '¥',
  cent: '¢',
  sect: '§',
  para: '¶',
  micro: 'µ',
  larr: '←',
  rarr: '→',
  harr: '↔',
};

const decodeHtmlEntities = (value) => {
  if (!value || typeof value !== 'string' || !value.includes('&')) {
    return value;
  }

  return value.replace(/&(#[Xx][0-9A-Fa-f]+|#\d+|[A-Za-z][A-Za-z0-9]{1,31});/g, (match, entity) => {
    if (entity[0] === '#') {
      const isHex = entity[1] === 'x' || entity[1] === 'X';
      const codePoint = Number.parseInt(isHex ? entity.slice(2) : entity.slice(1), isHex ? 16 : 10);
      if (!Number.isInteger(codePoint) || codePoint <= 0 || codePoint > 0x10ffff) {
        return match;
      }
      try {
        return String.fromCodePoint(codePoint);
      } catch {
        return match;
      }
    }

    const named = Object.prototype.hasOwnProperty.call(HTML_NAMED_ENTITIES, entity)
      ? HTML_NAMED_ENTITIES[entity]
      : HTML_NAMED_ENTITIES[entity.toLowerCase()];
    return named === undefined ? match : named;
  });
};

const cleanScrapedText = (value) => {
  if (typeof value !== 'string') {
    return null;
  }
  const cleaned = decodeHtmlEntities(value).replace(/\s+/g, ' ').trim();
  return cleaned || null;
};

const extractMetaDescription = (html) => {
  if (!html || typeof html !== 'string') {
    return null;
  }

  // The quote character is captured and back-referenced so an apostrophe inside a
  // double-quoted description (or vice versa) doesn't truncate the match.
  const patterns = [
    /<meta[^>]*name=["']description["'][^>]*content=(["'])([\s\S]*?)\1/i,
    /<meta[^>]*content=(["'])([\s\S]*?)\1[^>]*name=["']description["']/i,
    /<meta[^>]*property=["']og:description["'][^>]*content=(["'])([\s\S]*?)\1/i,
    /<meta[^>]*content=(["'])([\s\S]*?)\1[^>]*property=["']og:description["']/i,
  ];

  for (const pattern of patterns) {
    const match = html.match(pattern);
    const cleaned = cleanScrapedText(match?.[2]);
    if (cleaned) {
      return cleaned;
    }
  }

  return null;
};

const extractPageTitle = (html) => {
  if (!html || typeof html !== 'string') {
    return null;
  }

  const match = html.match(/<title[^>]*>([^<]*)<\/title>/i);
  return cleanScrapedText(match?.[1]);
};

const toHex = (bytes) =>
  Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');

const fromHex = (hex) => {
  if (!hex || hex.length % 2 !== 0) {
    return null;
  }
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    bytes[i / 2] = Number.parseInt(hex.slice(i, i + 2), 16);
  }
  return bytes;
};

const getJwtSecret = (env) => {
  if (!env.JWT_SECRET) {
    throw new Error('Missing JWT_SECRET');
  }
  return encoder.encode(env.JWT_SECRET);
};

const getApiKeySecretBytes = async (env) => {
  const secret = env.API_KEY_ENCRYPTION_SECRET || env.JWT_SECRET;
  if (!secret) {
    throw new Error('Missing API_KEY_ENCRYPTION_SECRET or JWT_SECRET');
  }
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(secret));
  return new Uint8Array(digest);
};

const getApiKeyAesKey = async (env) => {
  const rawKey = await getApiKeySecretBytes(env);
  return crypto.subtle.importKey('raw', rawKey, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
};

const hashApiKey = async (value) => {
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(value));
  return toHex(new Uint8Array(digest));
};

// Cost 10 matches registration. Missing accounts must still do password hashing work.
const DUMMY_PASSWORD_HASH = '$2b$10$N9qo8uLOickgx2ZMRZoMyeIjZAgcfl7p92ldGxad68LJZdL17lhWy';

const emailTokenStorageReady = async (db, table) => {
  const result = await db.prepare(`PRAGMA table_info(${table})`).all();
  return (result.results || []).some((column) => column.name === 'token_hash');
};

const storeEmailToken = async (db, table, userId, token, expiresAt) => {
  const tokenHash = await hashApiKey(token);
  await db.prepare(`INSERT INTO ${table} (user_id, token, token_hash, expires_at) VALUES (?, ?, ?, ?)`)
    .bind(userId, `sha256:${tokenHash}`, tokenHash, expiresAt).run();
};

const encryptApiKey = async (value, env) => {
  const key = await getApiKeyAesKey(env);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encrypted = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    key,
    encoder.encode(value)
  );
  return `${toHex(iv)}:${toHex(new Uint8Array(encrypted))}`;
};

const decryptApiKey = async (encryptedValue, env) => {
  if (!encryptedValue) {
    return null;
  }

  const parts = encryptedValue.split(':');
  if (parts.length !== 2) {
    return null;
  }

  const iv = fromHex(parts[0]);
  const data = fromHex(parts[1]);
  if (!iv || !data) {
    return null;
  }

  const key = await getApiKeyAesKey(env);
  const decrypted = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, data);
  return new TextDecoder().decode(decrypted);
};

const generateApiKeyValue = () => {
  const bytes = crypto.getRandomValues(new Uint8Array(24));
  return `tsk_${toHex(bytes)}`;
};

const parseBody = async (request) => {
  try {
    return await request.json();
  } catch {
    return {};
  }
};

const isValidEmail = (value) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);

const verifyTurnstile = async (request, env, captchaToken) => {
  if (!env.TURNSTILE_SECRET_KEY) {
    return { ok: false, status: 503, error: 'Support form is not configured.' };
  }

  if (!captchaToken || typeof captchaToken !== 'string') {
    return { ok: false, status: 400, error: 'CAPTCHA token is required.' };
  }

  const remoteIp = request.headers.get('CF-Connecting-IP') || '';
  const payload = new URLSearchParams({
    secret: env.TURNSTILE_SECRET_KEY,
    response: captchaToken,
  });

  if (remoteIp) {
    payload.set('remoteip', remoteIp);
  }

  try {
    const verifyResponse = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: payload.toString(),
    });
    const verifyData = await verifyResponse.json();

    if (!verifyData?.success) {
      return { ok: false, status: 400, error: 'CAPTCHA verification failed. Please try again.' };
    }

    return { ok: true };
  } catch {
    return { ok: false, status: 502, error: 'Could not verify CAPTCHA. Please try again.' };
  }
};

const getBearerToken = (request) => {
  const authHeader = request.headers.get('Authorization') || '';
  const [scheme, token] = authHeader.split(' ');
  if (scheme?.toLowerCase() !== 'bearer' || !token) {
    return null;
  }
  return token;
};

const requireAuth = async (request, env) => {
  const bearerToken = getBearerToken(request);
  const token = bearerToken || getSessionCookie(request);
  if (!token) {
    return { error: jsonResponse({ error: 'Access token required' }, 401) };
  }

  let payload;
  try {
    ({ payload } = await jwtVerify(token, getJwtSecret(env), { algorithms: ['HS256'] }));
    // A web session is only valid as an HttpOnly cookie; legacy/extension JWTs only as bearer tokens.
    if (bearerToken ? payload.session === 'web' : payload.session !== 'web') throw new Error('Wrong token type');
  } catch {
    return { error: jsonResponse({ error: 'Invalid or expired token' }, 403) };
  }

  // The signature only proves we issued the token, not that it's still valid. Re-read the
  // user so deleted accounts and revoked tokens (token_version bumped on password change or
  // reset) stop working immediately rather than at expiry. SELECT * rather than naming
  // token_version keeps this working before migration 0011 is applied; tokens issued before
  // it carry no `tv` claim and match version 0.
  const dbUser = await env.DB.prepare('SELECT * FROM users WHERE id = ?').bind(payload.id).first();
  if (!dbUser || Number(dbUser.token_version || 0) !== Number(payload.tv || 0)) {
    return { error: jsonResponse({ error: 'Invalid or expired token' }, 403) };
  }

  return {
    user: {
      id: dbUser.id,
      username: dbUser.username,
      role: dbUser.role,
      membershipTier: dbUser.membership_tier,
    },
  };
};

const signUserToken = async (user, env, request) => {
  // Read token_version fresh rather than trusting the caller's row, so a token signed right
  // after bumpTokenVersion carries the new version. SELECT * for the same pre-migration
  // reason as requireAuth.
  const versionRow = await env.DB.prepare('SELECT * FROM users WHERE id = ?').bind(user.id).first();

  return new SignJWT({
    id: user.id,
    username: user.username,
    role: user.role,
    membershipTier: user.membership_tier,
    tv: Number(versionRow?.token_version || 0),
    ...(request && isWebClient(request) ? { session: 'web' } : {}),
  })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime(request && isWebClient(request) ? `${WEB_SESSION_SECONDS}s` : '60d')
    .sign(getJwtSecret(env));
};

// Invalidates every outstanding token for the user. Callers that keep the current session
// alive must sign a fresh token afterwards.
const bumpTokenVersion = async (db, userId) => {
  if (!(await usersTableHasColumn(db, 'token_version'))) {
    return;
  }
  await db.prepare('UPDATE users SET token_version = token_version + 1 WHERE id = ?').bind(userId).run();
};

// Brute-force protection. The per-account lockout is the control that carries weight; the
// Cloudflare rate-limiting rule on /api/auth/login only slows a script down (the free plan
// caps its block at 10 seconds).
const LOGIN_MAX_FAILED_ATTEMPTS = 8;
const LOGIN_LOCKOUT_MS = 15 * 60 * 1000;

// Per-IP / per-email caps, counted from auth_events: [event type(s), max events, window minutes].
// These are SOFT limits: isAuthRateLimited counts, then the handler records, so a burst of
// simultaneous requests can overshoot a cap by up to the burst size. That is acceptable here
// (they exist to slow spraying and email amplification); the hard control for guessing one
// account's password is the atomic per-account lockout in recordFailedLogin, with the
// Cloudflare rate-limiting rule in front of both.
const AUTH_RATE_LIMITS = {
  loginFailuresPerIp: [['login_failed', 'password_confirmation_failed'], 20, 15],
  resetRequestsPerIp: ['password_reset_requested', 10, 60],
  resetRequestsPerEmail: ['password_reset_requested', 5, 60],
  resetRequestsPerEmailBurst: ['password_reset_requested', 1, 1],
  registrationsPerIp: ['register_attempt', 10, 60],
  verificationResendsPerIp: ['verification_resend_requested', 10, 60],
};

const AUTH_EVENT_RETENTION_DAYS = 30;

const getClientIp = (request) => request.headers.get('CF-Connecting-IP') || null;

// Appends to auth_events. Never throws: a logging failure, including auth_events not existing
// yet before migration 0012, must not break the auth flow itself. The email and IP go only to
// that access-controlled, 30-day table (Settings -> Admin); the Worker log line carries the
// event type and internal user id, never the raw email or IP.
const recordAuthEvent = async (db, request, eventType, { email = null, userId = null } = {}) => {
  const ip = getClientIp(request);
  console.warn(`[auth] ${eventType}`, JSON.stringify({ userId }));
  try {
    await db.batch([
      db
        .prepare('INSERT INTO auth_events (event_type, email, user_id, ip) VALUES (?, ?, ?, ?)')
        .bind(eventType, email, userId, ip),
      db.prepare(`DELETE FROM auth_events WHERE created_at < datetime('now', '-${AUTH_EVENT_RETENTION_DAYS} days')`),
    ]);
  } catch (err) {
    console.error('[auth] failed to record auth event:', err?.message ?? err);
  }
};

// True when the caller has hit the given AUTH_RATE_LIMITS entry. `by` is 'ip' or 'email'.
// Fails open if auth_events doesn't exist yet (pre-migration) or the key is unknown (no
// CF-Connecting-IP in local dev) — the account lockout still applies to login regardless.
const isAuthRateLimited = async (db, [eventType, max, windowMinutes], by, value) => {
  if (!value) return false;
  const column = by === 'email' ? 'email' : 'ip';
  const eventTypes = Array.isArray(eventType) ? eventType : [eventType];
  try {
    const row = await db
      .prepare(
        `SELECT COUNT(*) AS n FROM auth_events
         WHERE event_type IN (${eventTypes.map(() => '?').join(', ')}) AND ${column} = ? AND created_at > datetime('now', ?)`
      )
      .bind(...eventTypes, value, `-${windowMinutes} minutes`)
      .first();
    return Number(row?.n || 0) >= max;
  } catch {
    return false;
  }
};

const rateLimitedResponse = (message) => jsonResponse({ error: message }, 429);

// `user` is a SELECT * row, so the lockout columns are simply absent before migration 0012.
const getLockedUntil = (user) => {
  const lockedUntil = Number(user.locked_until || 0);
  return lockedUntil > Date.now() ? lockedUntil : null;
};

// Counts a wrong password and applies the lock in ONE statement, so concurrent failures can't
// overwrite each other's count (the old read-modify-write left eight parallel misses at 1).
// SQLite evaluates every right-hand side against the pre-update row. While a lock is active the
// row is left alone: a miss that was already in flight when the lock landed must neither
// extend it nor, worse, reset it. The counter restarts from zero when a lock is applied, so an
// expired lock doesn't re-lock on the very next miss. Returns true if the account is now locked.
const recordFailedLogin = async (db, user) => {
  if (!('failed_attempts' in user)) return false;
  const now = Date.now();
  const row = await db
    .prepare(
      `UPDATE users SET
         failed_attempts = CASE
           WHEN locked_until > ?1 THEN failed_attempts
           WHEN failed_attempts + 1 >= ?2 THEN 0
           ELSE failed_attempts + 1 END,
         locked_until = CASE
           WHEN locked_until > ?1 THEN locked_until
           WHEN failed_attempts + 1 >= ?2 THEN ?3
           ELSE locked_until END
       WHERE id = ?4
       RETURNING locked_until`
    )
    .bind(now, LOGIN_MAX_FAILED_ATTEMPTS, now + LOGIN_LOCKOUT_MS, user.id)
    .first();
  return Number(row?.locked_until || 0) > now;
};

// Fresh lock state for the moment of a successful password check: the row read at the start of
// the request may predate a lock applied by concurrent guesses.
const getCurrentLockedUntil = async (db, user) => {
  if (!('locked_until' in user)) return null;
  const row = await db.prepare('SELECT locked_until FROM users WHERE id = ?').bind(user.id).first();
  return getLockedUntil(row || {});
};

// Takes a SELECT * row; a no-op when there's nothing to clear or the columns don't exist.
const clearLoginLockout = async (db, user) => {
  if (!user?.failed_attempts && !user?.locked_until) return;
  await db.prepare('UPDATE users SET failed_attempts = 0, locked_until = NULL WHERE id = ?').bind(user.id).run();
};

// Password re-entry on an already-signed-in account (change username/email/password). These
// routes are a guessing oracle for a stolen session, so they share login's budgets: the same
// per-account counter and lock (so rotating between endpoints, or between them and /login,
// gains nothing) and the same per-IP cap. Returns null when the password is correct, or the
// 401/429 Response to send. Call it only after cheap input validation, so malformed requests
// don't spend budget. A correct password clears the counter, as at login.
const confirmCurrentPassword = async (db, request, userId, password, wrongPasswordMessage) => {
  if (await isAuthRateLimited(db, AUTH_RATE_LIMITS.loginFailuresPerIp, 'ip', getClientIp(request))) {
    await recordAuthEvent(db, request, 'login_rate_limited', { userId });
    return rateLimitedResponse('Too many failed password attempts from your network. Please try again later.');
  }

  const user = await db.prepare('SELECT * FROM users WHERE id = ?').bind(userId).first();
  if (!user) return jsonResponse({ error: 'User not found' }, 404);

  const lockedUntil = getLockedUntil(user);
  if (lockedUntil) {
    await recordAuthEvent(db, request, 'login_rejected_locked', { email: user.email, userId });
    return rateLimitedResponse(lockedOutMessage(lockedUntil));
  }

  if (typeof password === 'string' && (await bcrypt.compare(password, user.password_hash))) {
    // Same guard as login: a guess that was in flight while concurrent misses locked the account.
    const lockedNow = await getCurrentLockedUntil(db, user);
    if (lockedNow) return rateLimitedResponse(lockedOutMessage(lockedNow));
    await clearLoginLockout(db, user);
    return null;
  }

  const nowLocked = await recordFailedLogin(db, user);
  await recordAuthEvent(db, request, 'password_confirmation_failed', { email: user.email, userId });
  if (nowLocked) {
    await recordAuthEvent(db, request, 'account_locked', { email: user.email, userId });
    return rateLimitedResponse(lockedOutMessage((await getCurrentLockedUntil(db, user)) || Date.now() + LOGIN_LOCKOUT_MS));
  }
  return jsonResponse({ error: wrongPasswordMessage }, 401);
};

const lockedOutMessage = (lockedUntil) => {
  const minutes = Math.max(1, Math.ceil((lockedUntil - Date.now()) / 60000));
  return `Too many failed login attempts. Please try again in ${minutes} minute${minutes === 1 ? '' : 's'}, or reset your password.`;
};

const ensureUserRoleMatchesConfig = async (db, user, env) => {
  const expectedRole = getRoleForEmail(user.email, env);
  if (user.role !== expectedRole) {
    await db.prepare('UPDATE users SET role = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').bind(expectedRole, user.id).run();
    user.role = expectedRole;
  }
  return user;
};

// Redeems an email-change link. Returns null when the token is not an email-change token.
// Never issues a session: whoever opens the link proved inbox access, not account access.
const confirmEmailChange = async (db, token, env) => {
  if (!(await tableExists(db, 'email_change_tokens'))) return null;

  const tokenHash = await hashApiKey(token);
  const record = await db
    .prepare('SELECT id, user_id, new_email, expires_at, used_at FROM email_change_tokens WHERE token_hash = ?')
    .bind(tokenHash)
    .first();
  if (!record) return null;

  if (record.used_at) {
    return jsonResponse({ error: 'This confirmation link has already been used.' }, 400);
  }
  if (new Date(record.expires_at) < new Date()) {
    return jsonResponse({ error: 'This confirmation link has expired. Please request the change again.' }, 400);
  }

  // Atomic single-use claim: only one concurrent redemption can win.
  const claim = await db
    .prepare('UPDATE email_change_tokens SET used_at = CURRENT_TIMESTAMP WHERE id = ? AND used_at IS NULL')
    .bind(record.id)
    .run();
  if (!claim.meta?.changes) {
    return jsonResponse({ error: 'This confirmation link has already been used.' }, 400);
  }

  const owner = await db.prepare('SELECT id, username, email FROM users WHERE id = ?').bind(record.user_id).first();
  if (!owner) {
    return jsonResponse({ error: 'Invalid or expired verification link.' }, 400);
  }

  const taken = await db
    .prepare('SELECT id FROM users WHERE LOWER(email) = LOWER(?) AND id != ?')
    .bind(record.new_email, owner.id)
    .first();
  if (taken) {
    return jsonResponse({ error: 'That email address is already in use.' }, 400);
  }

  // The role follows the now-verified address; sessions and recovery links tied to the old identity die.
  await db
    .prepare('UPDATE users SET email = ?, role = ?, email_verified = 1, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
    .bind(record.new_email, getRoleForEmail(record.new_email, env), owner.id)
    .run();
  await db.prepare('DELETE FROM email_change_tokens WHERE user_id = ? AND used_at IS NULL').bind(owner.id).run();
  await db.prepare('DELETE FROM password_reset_tokens WHERE user_id = ?').bind(owner.id).run();
  await bumpTokenVersion(db, owner.id);

  await notifyOldEmailAboutChange(owner.email, owner.username, record.new_email, true, env);

  return jsonResponse({
    message: 'Email address updated. Please sign in again with your new email.',
    emailChanged: true,
  });
};

const requireSuperAdmin = async (db, authUser, env) => {
  const adminUser = await db
    .prepare('SELECT id, username, email, membership_tier, role FROM users WHERE id = ?')
    .bind(authUser.id)
    .first();

  if (!adminUser) {
    return { error: jsonResponse({ error: 'User not found' }, 404) };
  }

  await ensureUserRoleMatchesConfig(db, adminUser, env);

  if (adminUser.role !== USER_ROLES.SUPER_ADMIN) {
    return { error: jsonResponse({ error: 'Super admin access required' }, 403) };
  }

  return { adminUser };
};

const usersTableHasColumn = async (db, columnName) => {
  const result = await db.prepare('PRAGMA table_info(users)').all();
  return (result.results || []).some((column) => column.name === columnName);
};

const bookmarksTableHasColumn = async (db, columnName) => {
  const result = await db.prepare('PRAGMA table_info(bookmarks)').all();
  return (result.results || []).some((column) => column.name === columnName);
};

const tableExists = async (db, tableName) => {
  const result = await db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
    .bind(tableName)
    .first();

  return Boolean(result);
};

const getUserPlanStatus = async (db, userId) => {
  const user = await db
    .prepare('SELECT membership_tier FROM users WHERE id = ?')
    .bind(userId)
    .first();

  if (!user) {
    return null;
  }

  const countResult = await db
    .prepare('SELECT COUNT(*) AS count FROM bookmarks WHERE user_id = ?')
    .bind(userId)
    .first();

  const bookmarkCount = Number(countResult?.count || 0);
  const paidTier = isPaidTier(user.membership_tier);

  return {
    membershipTier: user.membership_tier,
    bookmarkCount,
    paidTier,
    remainingSlots: paidTier ? null : Math.max(FREE_BOOKMARK_LIMIT - bookmarkCount, 0),
  };
};

const getTagsByBookmarkId = async (db, userId, { publicOnly = false, hasIsPrivateColumn } = {}) => {
  let whereClause = 'WHERE b.user_id = ?';
  if (publicOnly) {
    const isPrivateColumnExists = hasIsPrivateColumn ?? (await bookmarksTableHasColumn(db, 'is_private'));
    if (isPrivateColumnExists) {
      whereClause += ' AND b.is_private = 0';
    }
  }

  const rows = await db
    .prepare(
      `SELECT bt.bookmark_id, t.id, t.name
       FROM bookmark_tags bt
       INNER JOIN tags t ON t.id = bt.tag_id
       INNER JOIN bookmarks b ON b.id = bt.bookmark_id
       ${whereClause}
       ORDER BY t.name ASC`
    )
    .bind(userId)
    .all();

  const byBookmark = new Map();
  for (const row of rows.results || []) {
    if (!byBookmark.has(row.bookmark_id)) {
      byBookmark.set(row.bookmark_id, []);
    }
    byBookmark.get(row.bookmark_id).push({ id: row.id, name: row.name });
  }

  return byBookmark;
};

const attachTagsToBookmarks = async (db, userId, bookmarks) => {
  const tagsByBookmark = await getTagsByBookmarkId(db, userId);
  return bookmarks.map((bookmark) => ({
    ...bookmark,
    tags: tagsByBookmark.get(bookmark.id) || [],
  }));
};

// columnName is always a hardcoded literal passed by the calling route ('is_favorite' or
// 'is_private'), never user input, so interpolating it into SQL below is safe.
const toggleBookmarkFlag = async (db, userId, bookmarkId, columnName, { onMessage, offMessage, notConfiguredMessage }) => {
  const hasColumn = await bookmarksTableHasColumn(db, columnName);
  if (!hasColumn) {
    return { error: jsonResponse({ error: notConfiguredMessage }, 503) };
  }

  const bookmark = await db
    .prepare(`SELECT id, ${columnName} FROM bookmarks WHERE id = ? AND user_id = ?`)
    .bind(bookmarkId, userId)
    .first();

  if (!bookmark) {
    return { error: jsonResponse({ error: 'Bookmark not found' }, 404) };
  }

  const nextValue = Number(bookmark[columnName] || 0) ? 0 : 1;

  await db
    .prepare(`UPDATE bookmarks SET ${columnName} = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND user_id = ?`)
    .bind(nextValue, bookmarkId, userId)
    .run();

  return {
    response: jsonResponse({
      message: nextValue ? onMessage : offMessage,
      bookmark: { id: bookmarkId, [columnName]: nextValue },
    }),
  };
};

const ensureTag = async (db, tagName) => {
  await db
    .prepare('INSERT INTO tags (name) VALUES (?) ON CONFLICT(name) DO UPDATE SET name = excluded.name')
    .bind(tagName)
    .run();

  const tag = await db.prepare('SELECT id, name FROM tags WHERE name = ?').bind(tagName).first();
  return tag;
};

const setBookmarkTags = async (db, bookmarkId, tags) => {
  await db.prepare('DELETE FROM bookmark_tags WHERE bookmark_id = ?').bind(bookmarkId).run();

  const bookmarkTags = [];
  for (const tagName of tags) {
    if (typeof tagName !== 'string') {
      continue;
    }
    const trimmed = tagName.trim().toLowerCase();
    if (!trimmed) {
      continue;
    }
    if (/\s/.test(trimmed)) {
      throw new Error(`INVALID_TAG:${tagName}`);
    }

    const tag = await ensureTag(db, trimmed);
    await db
      .prepare('INSERT OR IGNORE INTO bookmark_tags (bookmark_id, tag_id) VALUES (?, ?)')
      .bind(bookmarkId, tag.id)
      .run();

    bookmarkTags.push(tag);
  }

  return bookmarkTags;
};

const normalizeBookmarkUrl = (value) => {
  if (typeof value !== 'string') {
    return null;
  }

  let normalized = value.trim();
  if (!normalized) {
    return null;
  }

  if (!/^https?:\/\//i.test(normalized)) {
    // Treat missing or malformed protocol prefixes as secure by default.
    normalized = normalized
      .replace(/^https?:/i, '')
      .replace(/^\/\//, '')
      .trim();

    if (!normalized) {
      return null;
    }

    normalized = `https://${normalized}`;
  }

  // Keep a trailing slash on bare roots, including URLs produced by Base URL.
  try {
    const parsed = new URL(normalized);
    if (parsed.pathname === '/' && !parsed.search && !parsed.hash) {
      return `${parsed.origin}/`;
    }
  } catch {}

  return normalized;
};

// Read compatibility for roots saved before trailing slashes were retained.
const legacyBookmarkUrl = (value) => {
  const normalized = normalizeBookmarkUrl(value);
  try {
    const parsed = new URL(normalized);
    if (parsed.pathname === '/' && !parsed.search && !parsed.hash) return parsed.origin;
  } catch {}
  return normalized;
};

const isValidHttpUrl = (value) => {
  try {
    const parsed = new URL(value);
    return (parsed.protocol === 'http:' || parsed.protocol === 'https:') && Boolean(parsed.hostname);
  } catch {
    return false;
  }
};

const fetchSiteMetadata = async (url) => {
  if (!url || typeof url !== 'string') {
    return { error: 'A valid URL is required', status: 400 };
  }

  const normalizedUrl = normalizeBookmarkUrl(url);
  if (!normalizedUrl || !isValidHttpUrl(normalizedUrl)) {
    return { error: 'Invalid URL format', status: 400 };
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 8000);

  try {
    const response = await fetch(normalizedUrl, {
      headers: FETCH_HEADERS,
      redirect: 'follow',
      signal: controller.signal,
    });

    const html = await response.text();
    return {
      ok: response.ok,
      status: response.status,
      title: extractPageTitle(html),
      description: extractMetaDescription(html),
    };
  } catch (error) {
    if (error?.name === 'AbortError') {
      return { error: 'Timed out while fetching site metadata', status: 504 };
    }
    return { error: 'Server error fetching site metadata', status: 500 };
  } finally {
    clearTimeout(timeoutId);
  }
};

const listBookmarks = async (db, userId) => {
  const bookmarksColumns = await db.prepare('PRAGMA table_info(bookmarks)').all();
  const bookmarksColumnNames = new Set((bookmarksColumns.results || []).map((column) => column.name));
  const hasIsFavoriteColumn = bookmarksColumnNames.has('is_favorite');
  const hasIsPrivateColumn = bookmarksColumnNames.has('is_private');
  const favoriteSelect = hasIsFavoriteColumn ? '*' : '*, 0 AS is_favorite';
  const privateSelect = hasIsPrivateColumn ? favoriteSelect : `${favoriteSelect}, 0 AS is_private`;
  const bookmarksQuery = `SELECT ${privateSelect} FROM bookmarks WHERE user_id = ? ORDER BY created_at DESC`;

  const bookmarksResult = await db
    .prepare(bookmarksQuery)
    .bind(userId)
    .all();

  const bookmarks = (bookmarksResult.results || []).map((bookmark) => ({
    ...bookmark,
    is_favorite: Number(bookmark.is_favorite || 0),
    is_private: Number(bookmark.is_private || 0),
  }));

  for (const bookmark of bookmarks) {
    if (!bookmark.favicon_url) {
      const faviconUrl = getFaviconUrl(bookmark.url);
      bookmark.favicon_url = faviconUrl;
      await db
        .prepare('UPDATE bookmarks SET favicon_url = ? WHERE id = ?')
        .bind(faviconUrl, bookmark.id)
        .run();
    }
  }

  return attachTagsToBookmarks(db, userId, bookmarks);
};

// --- Stripe helpers ---

const stripeRequest = async (method, path, params, env) => {
  const url = `https://api.stripe.com/v1${path}`;
  const auth = btoa(`${env.STRIPE_SECRET_KEY}:`);
  const options = {
    method,
    headers: {
      Authorization: `Basic ${auth}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
  };
  if (params) {
    options.body = new URLSearchParams(params).toString();
  }
  const response = await fetch(url, options);
  const data = await response.json();
  if (!response.ok) {
    throw new Error(data?.error?.message || `Stripe API error: ${response.status}`);
  }
  return data;
};

const isStripeMissingResourceError = (error) => /No such (customer|subscription)/i.test(error?.message || '');

const createStripeCustomer = async (dbUser, env) =>
  stripeRequest(
    'POST',
    '/customers',
    {
      email: dbUser.email,
      name: dbUser.username,
      'metadata[userId]': String(dbUser.id),
    },
    env
  );

const updateStripeCustomer = async (customerId, dbUser, env) =>
  stripeRequest(
    'POST',
    `/customers/${customerId}`,
    {
      email: dbUser.email,
      name: dbUser.username,
      'metadata[userId]': String(dbUser.id),
    },
    env
  );

const saveStripeCustomerId = async (db, userId, customerId) => {
  await db
    .prepare('UPDATE users SET stripe_customer_id = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
    .bind(customerId, userId)
    .run();
};

const clearStripeBillingState = async (db, userId) => {
  await db
    .prepare(
      'UPDATE users SET membership_tier = ?, stripe_customer_id = NULL, stripe_subscription_id = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = ?'
    )
    .bind(MEMBERSHIP_TIERS.FREE, userId)
    .run();
};

const verifyStripeSignature = async (rawBody, sigHeader, secret) => {
  if (!sigHeader || !secret) return false;
  const parts = {};
  for (const part of sigHeader.split(',')) {
    const idx = part.indexOf('=');
    if (idx > 0) parts[part.slice(0, idx)] = part.slice(idx + 1);
  }
  const timestamp = parts.t;
  const signature = parts.v1;
  if (!timestamp || !signature) return false;
  // Reject webhooks older than 5 minutes to prevent replay attacks
  const now = Math.floor(Date.now() / 1000);
  if (Math.abs(now - parseInt(timestamp, 10)) > 300) return false;
  const payload = `${timestamp}.${rawBody}`;
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const mac = await crypto.subtle.sign('HMAC', key, encoder.encode(payload));
  const expected = Array.from(new Uint8Array(mac))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
  return expected === signature;
};

const processStripeEvent = async (db, event) => {
  const { type, data } = event;
  const obj = data?.object;

  if (type === 'checkout.session.completed') {
    const customerId = obj?.customer;
    const subscriptionId = obj?.subscription;
    const userId = Number(obj?.metadata?.userId);
    const email = normalizeEmail(obj?.customer_email || obj?.customer_details?.email);
    let user = null;
    if (Number.isInteger(userId) && userId > 0) {
      user = await db.prepare('SELECT * FROM users WHERE id = ?').bind(userId).first();
    }
    if (!user && email) {
      user = await db
        .prepare('SELECT * FROM users WHERE LOWER(email) = LOWER(?)')
        .bind(email)
        .first();
    }
    if (!user) return { handled: false, reason: 'No matching user' };
    await db
      .prepare(
        'UPDATE users SET membership_tier = ?, stripe_customer_id = ?, stripe_subscription_id = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?'
      )
      .bind(MEMBERSHIP_TIERS.PAID, customerId, subscriptionId, user.id)
      .run();
    return { handled: true, action: 'membership_upgraded', eventType: type };
  }

  if (type === 'customer.subscription.deleted') {
    const customerId = obj?.customer;
    const user = await db
      .prepare('SELECT * FROM users WHERE stripe_customer_id = ?')
      .bind(customerId)
      .first();
    if (!user) return { handled: false, reason: 'No matching user for customer' };
    await db
      .prepare(
        'UPDATE users SET membership_tier = ?, stripe_subscription_id = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = ?'
      )
      .bind(MEMBERSHIP_TIERS.FREE, user.id)
      .run();
    return { handled: true, action: 'membership_downgraded', eventType: type };
  }

  if (type === 'customer.subscription.updated') {
    const customerId = obj?.customer;
    const status = obj?.status;
    const user = await db
      .prepare('SELECT * FROM users WHERE stripe_customer_id = ?')
      .bind(customerId)
      .first();
    if (!user) return { handled: false, reason: 'No matching user for customer' };
    const tier = ['active', 'trialing'].includes(status) ? MEMBERSHIP_TIERS.PAID : MEMBERSHIP_TIERS.FREE;
    if (user.membership_tier !== tier) {
      await db
        .prepare('UPDATE users SET membership_tier = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
        .bind(tier, user.id)
        .run();
    }
    return { handled: true, action: 'subscription_status_synced', status, eventType: type };
  }

  return { handled: false, reason: `Unhandled event type: ${type}` };
};

async function handleAuth(request, env, segments) {
  if (request.method === 'POST' && segments[1] === 'session') {
    // Upgrade a pre-cookie web login. Never return the replacement token to JS.
    if (!isWebClient(request) || !getBearerToken(request)) {
      return jsonResponse({ error: 'Existing bearer session required' }, 400);
    }
    const auth = await requireAuth(request, env);
    if (auth.error) return auth.error;
    const token = await signUserToken(auth.user, env, request);
    return sessionResponse(request, { message: 'Session upgraded', token });
  }
  if (request.method === 'POST' && segments[1] === 'logout') {
    const response = jsonResponse({ message: 'Signed out' });
    response.headers.set('Set-Cookie', sessionCookie(request, '', 0));
    return response;
  }
  const db = env.DB;

  if (request.method === 'POST' && segments[1] === 'register') {
    if (!(await emailTokenStorageReady(db, 'email_verification_tokens'))) {
      return jsonResponse({ error: 'Email authentication is temporarily unavailable. Please try again later.' }, 503);
    }

    const { username, email, password } = await parseBody(request);
    const trimmedUsername = typeof username === 'string' ? username.trim() : '';
    const normalizedEmail = normalizeEmail(email);

    if (!trimmedUsername || !normalizedEmail || !password || typeof password !== 'string') {
      return jsonResponse({ error: 'All fields are required' }, 400);
    }

    if (/\s/.test(trimmedUsername)) {
      return jsonResponse({ error: 'Username cannot contain spaces' }, 400);
    }

    if (trimmedUsername.length < 2) {
      return jsonResponse({ error: 'Username must be at least 2 characters' }, 400);
    }

    if (trimmedUsername.length > 50) {
      return jsonResponse({ error: 'Username must be 50 characters or less' }, 400);
    }

    if (password.length < 6) {
      return jsonResponse({ error: 'Password must be at least 6 characters' }, 400);
    }

    // Every registration sends an email to an arbitrary address, so cap attempts per IP.
    if (await isAuthRateLimited(db, AUTH_RATE_LIMITS.registrationsPerIp, 'ip', getClientIp(request))) {
      await recordAuthEvent(db, request, 'register_rate_limited', { email: normalizedEmail });
      return rateLimitedResponse('Too many sign-up attempts from your network. Please try again later.');
    }
    await recordAuthEvent(db, request, 'register_attempt', { email: normalizedEmail });

    const existing = await db
      .prepare('SELECT id FROM users WHERE LOWER(email) = LOWER(?) OR LOWER(username) = LOWER(?)')
      .bind(normalizedEmail, trimmedUsername)
      .first();

    if (existing) {
      return jsonResponse({ error: 'User already exists with this email or username' }, 400);
    }

    const passwordHash = await bcrypt.hash(password, 10);
    const role = getRoleForEmail(normalizedEmail, env);

    const insert = await db
      .prepare(
        'INSERT INTO users (username, email, password_hash, membership_tier, role, email_verified) VALUES (?, ?, ?, ?, ?, 0)'
      )
      .bind(trimmedUsername, normalizedEmail, passwordHash, MEMBERSHIP_TIERS.FREE, role)
      .run();

    const userId = insert.meta.last_row_id;

    // Generate and store verification token (expires in 24 hours)
    const verificationToken = generateVerificationToken();
    const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
    await storeEmailToken(db, 'email_verification_tokens', userId, verificationToken, expiresAt);

    try {
      await sendVerificationEmail(normalizedEmail, trimmedUsername, verificationToken, env);
    } catch {
      // Roll back user creation if email fails so they can try again
      await db.prepare('DELETE FROM users WHERE id = ?').bind(userId).run();
      return jsonResponse({ error: 'Failed to send verification email. Please try again.' }, 500);
    }

    return jsonResponse(
      {
        message: 'Registration successful. Please check your email to verify your account.',
        pendingVerification: true,
      },
      201
    );
  }

  if (request.method === 'POST' && segments[1] === 'login') {
    const { email, password } = await parseBody(request);
    const normalizedEmail = normalizeEmail(email);

    if (!normalizedEmail || !password || typeof password !== 'string') {
      return jsonResponse({ error: 'Email and password are required' }, 400);
    }

    if (await isAuthRateLimited(db, AUTH_RATE_LIMITS.loginFailuresPerIp, 'ip', getClientIp(request))) {
      await recordAuthEvent(db, request, 'login_rate_limited', { email: normalizedEmail });
      return rateLimitedResponse('Too many failed login attempts from your network. Please try again later.');
    }

    const user = await db
      .prepare('SELECT * FROM users WHERE LOWER(email) = LOWER(?)')
      .bind(normalizedEmail)
      .first();

    if (!user) {
      await bcrypt.compare(password, DUMMY_PASSWORD_HASH);
      await recordAuthEvent(db, request, 'login_failed', { email: normalizedEmail });
      return jsonResponse({ error: 'Invalid email or password' }, 401);
    }

    // Checked before bcrypt so a locked account costs no hashing work.
    const lockedUntil = getLockedUntil(user);
    if (lockedUntil) {
      await recordAuthEvent(db, request, 'login_rejected_locked', { email: normalizedEmail, userId: user.id });
      return rateLimitedResponse(lockedOutMessage(lockedUntil));
    }

    const validPassword = await bcrypt.compare(password, user.password_hash);
    if (!validPassword) {
      const nowLocked = await recordFailedLogin(db, user);
      await recordAuthEvent(db, request, 'login_failed', { email: normalizedEmail, userId: user.id });
      if (nowLocked) {
        await recordAuthEvent(db, request, 'account_locked', { email: normalizedEmail, userId: user.id });
        return rateLimitedResponse(lockedOutMessage((await getCurrentLockedUntil(db, user)) || Date.now() + LOGIN_LOCKOUT_MS));
      }
      return jsonResponse({ error: 'Invalid email or password' }, 401);
    }

    // A correct guess that was already in flight when concurrent misses locked the account
    // must not slip through the lock.
    const lockedNow = await getCurrentLockedUntil(db, user);
    if (lockedNow) {
      await recordAuthEvent(db, request, 'login_rejected_locked', { email: normalizedEmail, userId: user.id });
      return rateLimitedResponse(lockedOutMessage(lockedNow));
    }

    if (!user.email_verified) {
      return jsonResponse({ error: 'Please verify your email address before logging in.' }, 403);
    }

    await ensureUserRoleMatchesConfig(db, user, env);
    await clearLoginLockout(db, user);

    const lastLoginAt = new Date().toISOString();
    const hasLastLoginAtColumn = await usersTableHasColumn(db, 'last_login_at');
    const updateStatement = hasLastLoginAtColumn
      ? 'UPDATE users SET last_login_at = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?'
      : 'UPDATE users SET updated_at = CURRENT_TIMESTAMP WHERE id = ?';

    const updateQuery = db.prepare(updateStatement);
    if (hasLastLoginAtColumn) {
      await updateQuery.bind(lastLoginAt, user.id).run();
    } else {
      await updateQuery.bind(user.id).run();
    }

    const token = await signUserToken(user, env, request);

    return sessionResponse(request, {
      message: 'Login successful',
      token,
      user: {
        id: user.id,
        username: user.username,
        email: user.email,
        membership_tier: user.membership_tier,
        role: user.role,
        last_login_at: lastLoginAt,
        profile_public: Number(user.profile_public || 0),
        theme: user.theme || null,
        link_target: user.link_target || null,
      },
    });
  }

  if (request.method === 'GET' && segments[1] === 'verify-email') {
    if (!(await emailTokenStorageReady(db, 'email_verification_tokens'))) {
      return jsonResponse({ error: 'Email authentication is temporarily unavailable. Please try again later.' }, 503);
    }

    const token = new URL(request.url).searchParams.get('token');
    if (!token) {
      return jsonResponse({ error: 'Verification token is required' }, 400);
    }

    const record = await db
      .prepare(
        `SELECT evt.id, evt.user_id, evt.expires_at, evt.used_at
         FROM email_verification_tokens evt
         WHERE evt.token_hash = ?`
      )
      .bind(await hashApiKey(token))
      .first();

    if (!record) {
      const changeResult = await confirmEmailChange(db, token, env);
      if (changeResult) return changeResult;
      return jsonResponse({ error: 'Invalid or expired verification link.' }, 400);
    }

    if (record.used_at) {
      return jsonResponse({ error: 'This verification link has already been used.' }, 400);
    }

    if (new Date(record.expires_at) < new Date()) {
      return jsonResponse({ error: 'This verification link has expired. Please request a new one.' }, 400);
    }

    // Atomic single-use claim, as for email-change and reset links: the token update only
    // matches while the token is still unused and unexpired, so of any number of simultaneous
    // redemptions exactly one wins (and gets the session below). Both statements run in one
    // D1 batch (a transaction), and the user is only marked verified if this claim won.
    const nowIso = new Date().toISOString();
    const [claim] = await db.batch([
      db
        .prepare('UPDATE email_verification_tokens SET used_at = CURRENT_TIMESTAMP WHERE id = ? AND used_at IS NULL AND expires_at > ?')
        .bind(record.id, nowIso),
      db
        .prepare(
          `UPDATE users SET email_verified = 1, updated_at = CURRENT_TIMESTAMP
           WHERE id = ? AND EXISTS (SELECT 1 FROM email_verification_tokens WHERE id = ? AND used_at IS NOT NULL)`
        )
        .bind(record.user_id, record.id),
    ]);
    if (!claim?.meta?.changes) {
      return jsonResponse({ error: 'This verification link has already been used or has expired.' }, 400);
    }

    const hasProfilePublicColumnForVerify = await usersTableHasColumn(db, 'profile_public');
    const hasThemeColumnForVerify = await usersTableHasColumn(db, 'theme');
    const hasLinkTargetColumnForVerify = await usersTableHasColumn(db, 'link_target');
    const verifiedUserQuery = `SELECT id, username, email, membership_tier, role, ${hasProfilePublicColumnForVerify ? 'profile_public' : '0 AS profile_public'}, ${hasThemeColumnForVerify ? 'theme' : 'NULL AS theme'}, ${hasLinkTargetColumnForVerify ? 'link_target' : 'NULL AS link_target'} FROM users WHERE id = ?`;

    const verifiedUser = await db
      .prepare(verifiedUserQuery)
      .bind(record.user_id)
      .first();

    if (!verifiedUser) {
      return jsonResponse({ error: 'Invalid or expired verification link.' }, 400);
    }
    verifiedUser.profile_public = Number(verifiedUser.profile_public || 0);

    const authToken = await signUserToken(verifiedUser, env, request);

    return sessionResponse(request, {
      message: 'Email verified successfully.',
      token: authToken,
      user: verifiedUser,
    });
  }

  if (request.method === 'POST' && segments[1] === 'resend-verification') {
    if (!(await emailTokenStorageReady(db, 'email_verification_tokens'))) {
      return jsonResponse({ error: 'Email authentication is temporarily unavailable. Please try again later.' }, 503);
    }

    const { email } = await parseBody(request);
    const normalizedEmail = normalizeEmail(email);

    if (!normalizedEmail) {
      return jsonResponse({ error: 'Email is required' }, 400);
    }

    if (await isAuthRateLimited(db, AUTH_RATE_LIMITS.verificationResendsPerIp, 'ip', getClientIp(request))) {
      await recordAuthEvent(db, request, 'verification_resend_rate_limited', { email: normalizedEmail });
      return rateLimitedResponse('Too many requests from your network. Please try again later.');
    }
    await recordAuthEvent(db, request, 'verification_resend_requested', { email: normalizedEmail });

    const unverifiedUser = await db
      .prepare('SELECT id, username, email_verified FROM users WHERE LOWER(email) = LOWER(?)')
      .bind(normalizedEmail)
      .first();

    if (!unverifiedUser || unverifiedUser.email_verified) {
      return jsonResponse({ message: 'If that address is awaiting verification, a new link has been sent.' });
    }

    const recent = await db
      .prepare(
        `SELECT id FROM email_verification_tokens
         WHERE user_id = ? AND used_at IS NULL
           AND created_at > datetime('now', '-60 seconds')
         LIMIT 1`
      )
      .bind(unverifiedUser.id)
      .first();

    if (recent) {
      return jsonResponse({ error: 'Please wait a moment before requesting another link.' }, 429);
    }

    await db
      .prepare('DELETE FROM email_verification_tokens WHERE user_id = ? AND used_at IS NULL')
      .bind(unverifiedUser.id)
      .run();

    const verificationToken = generateVerificationToken();
    const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
    await storeEmailToken(db, 'email_verification_tokens', unverifiedUser.id, verificationToken, expiresAt);

    try {
      await sendVerificationEmail(normalizedEmail, unverifiedUser.username, verificationToken, env);
    } catch (error) {
      // Answer with the generic message anyway: a distinct error would reveal that the
      // address belongs to an account awaiting verification.
      console.error('Resend verification email failed:', error);
    }

    return jsonResponse({ message: 'If that address is awaiting verification, a new link has been sent.' });
  }

  if (request.method === 'GET' && segments[1] === 'me') {
    const auth = await requireAuth(request, env);
    if (auth.error) return auth.error;

    const hasProfilePublicColumn = await usersTableHasColumn(db, 'profile_public');
    const hasThemeColumn = await usersTableHasColumn(db, 'theme');
    const hasLinkTargetColumn = await usersTableHasColumn(db, 'link_target');
    const meQuery = `SELECT id, username, email, membership_tier, role, created_at, ${hasProfilePublicColumn ? 'profile_public' : '0 AS profile_public'}, ${hasThemeColumn ? 'theme' : 'NULL AS theme'}, ${hasLinkTargetColumn ? 'link_target' : 'NULL AS link_target'} FROM users WHERE id = ?`;

    const user = await db
      .prepare(meQuery)
      .bind(auth.user.id)
      .first();

    if (!user) {
      return jsonResponse({ error: 'User not found' }, 404);
    }

    user.profile_public = Number(user.profile_public || 0);

    await ensureUserRoleMatchesConfig(db, user, env);
    return jsonResponse({ user });
  }

  if (request.method === 'PUT' && segments[1] === 'username') {
    const auth = await requireAuth(request, env);
    if (auth.error) return auth.error;

    const { newUsername, password } = await parseBody(request);
    const trimmedUsername = typeof newUsername === 'string' ? newUsername.trim() : '';

    if (!trimmedUsername || !password) {
      return jsonResponse({ error: 'Username and password are required' }, 400);
    }

    if (/\s/.test(trimmedUsername)) {
      return jsonResponse({ error: 'Username cannot contain spaces' }, 400);
    }

    if (trimmedUsername.length < 2) {
      return jsonResponse({ error: 'Username must be at least 2 characters' }, 400);
    }

    if (trimmedUsername.length > 50) {
      return jsonResponse({ error: 'Username must be 50 characters or less' }, 400);
    }

    const usernameCheck = await db
      .prepare('SELECT id FROM users WHERE LOWER(username) = LOWER(?) AND id != ?')
      .bind(trimmedUsername, auth.user.id)
      .first();

    if (usernameCheck) {
      return jsonResponse({ error: 'Username is already in use' }, 400);
    }

    const user = await db
      .prepare('SELECT password_hash, username FROM users WHERE id = ?')
      .bind(auth.user.id)
      .first();

    if (!user) {
      return jsonResponse({ error: 'User not found' }, 404);
    }

    if (user.username === trimmedUsername) {
      return jsonResponse({ error: 'New username must be different from current username' }, 400);
    }

    const passwordFailure = await confirmCurrentPassword(db, request, auth.user.id, password, 'Incorrect password');
    if (passwordFailure) return passwordFailure;

    await db.prepare('UPDATE users SET username = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').bind(trimmedUsername, auth.user.id).run();

    const updatedUser = await db
      .prepare('SELECT id, username, email, membership_tier, role FROM users WHERE id = ?')
      .bind(auth.user.id)
      .first();

    return jsonResponse({ message: 'Username updated successfully', user: updatedUser });
  }

  if (request.method === 'PUT' && segments[1] === 'email') {
    const auth = await requireAuth(request, env);
    if (auth.error) return auth.error;

    const { newEmail, password } = await parseBody(request);
    const normalizedNewEmail = normalizeEmail(newEmail);

    if (!normalizedNewEmail || !password) {
      return jsonResponse({ error: 'Email and password are required' }, 400);
    }

    const emailCheck = await db
      .prepare('SELECT id FROM users WHERE LOWER(email) = LOWER(?) AND id != ?')
      .bind(normalizedNewEmail, auth.user.id)
      .first();

    if (emailCheck) {
      return jsonResponse({ error: 'Email is already in use' }, 400);
    }

    if (!(await tableExists(db, 'email_change_tokens'))) {
      return jsonResponse({ error: 'Email changes are temporarily unavailable. Please try again later.' }, 503);
    }

    const user = await db
      .prepare('SELECT password_hash, username, email FROM users WHERE id = ?')
      .bind(auth.user.id)
      .first();

    if (!user) {
      return jsonResponse({ error: 'User not found' }, 404);
    }

    const passwordFailure = await confirmCurrentPassword(db, request, auth.user.id, password, 'Incorrect password');
    if (passwordFailure) return passwordFailure;

    if (normalizeEmail(user.email) === normalizedNewEmail) {
      return jsonResponse({ error: 'New email must be different from current email' }, 400);
    }

    // The account keeps its current email and role until the NEW inbox proves ownership.
    await db.prepare('DELETE FROM email_change_tokens WHERE user_id = ? AND used_at IS NULL').bind(auth.user.id).run();
    const changeToken = generateVerificationToken();
    const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
    await db
      .prepare('INSERT INTO email_change_tokens (user_id, new_email, token_hash, expires_at) VALUES (?, ?, ?, ?)')
      .bind(auth.user.id, normalizedNewEmail, await hashApiKey(changeToken), expiresAt)
      .run();

    try {
      await sendEmailChangeConfirmation(normalizedNewEmail, user.username, changeToken, env);
    } catch (error) {
      await db.prepare('DELETE FROM email_change_tokens WHERE token_hash = ?').bind(await hashApiKey(changeToken)).run();
      console.warn('[auth] Failed to send email-change confirmation', error?.message || error);
      return jsonResponse({ error: 'Could not send the confirmation email. Please try again later.' }, 503);
    }

    await notifyOldEmailAboutChange(user.email, user.username, normalizedNewEmail, false, env);

    return jsonResponse({
      message: `We sent a confirmation link to ${normalizedNewEmail}. Your email will not change until you open it.`,
      pending: true,
    });
  }

  if (request.method === 'PUT' && segments[1] === 'password') {
    const auth = await requireAuth(request, env);
    if (auth.error) return auth.error;

    const { currentPassword, newPassword, confirmPassword } = await parseBody(request);

    if (!currentPassword || !newPassword || !confirmPassword) {
      return jsonResponse({ error: 'All fields are required' }, 400);
    }

    if (newPassword.length < 6) {
      return jsonResponse({ error: 'New password must be at least 6 characters' }, 400);
    }

    if (newPassword !== confirmPassword) {
      return jsonResponse({ error: 'Passwords do not match' }, 400);
    }

    if (currentPassword === newPassword) {
      return jsonResponse({ error: 'New password must be different from current password' }, 400);
    }

    const user = await db
      .prepare('SELECT password_hash FROM users WHERE id = ?')
      .bind(auth.user.id)
      .first();

    if (!user) {
      return jsonResponse({ error: 'User not found' }, 404);
    }

    const passwordFailure = await confirmCurrentPassword(db, request, auth.user.id, currentPassword, 'Incorrect current password');
    if (passwordFailure) return passwordFailure;

    const passwordHash = await bcrypt.hash(newPassword, 10);
    // One transaction: new password, sessions revoked, and any reset link emailed earlier
    // (possibly to an attacker-readable inbox) can no longer overwrite it.
    const bumpsVersion = await usersTableHasColumn(db, 'token_version');
    await db.batch([
      db
        .prepare(`UPDATE users SET password_hash = ?, updated_at = CURRENT_TIMESTAMP${bumpsVersion ? ', token_version = token_version + 1' : ''} WHERE id = ?`)
        .bind(passwordHash, auth.user.id),
      db
        .prepare('UPDATE password_reset_tokens SET used_at = CURRENT_TIMESTAMP WHERE user_id = ? AND used_at IS NULL')
        .bind(auth.user.id),
    ]);

    // Sign out every other session (including a stolen token), but keep this one alive.
    const token = await signUserToken(auth.user, env, request);

    return sessionResponse(request, { message: 'Password updated successfully', token });
  }

  if (request.method === 'PUT' && segments[1] === 'profile-public') {
    const auth = await requireAuth(request, env);
    if (auth.error) return auth.error;

    const hasProfilePublicColumn = await usersTableHasColumn(db, 'profile_public');
    if (!hasProfilePublicColumn) {
      return jsonResponse({ error: 'Public profiles are not configured yet' }, 503);
    }

    const { profilePublic } = await parseBody(request);
    const nextValue = profilePublic ? 1 : 0;

    await db
      .prepare('UPDATE users SET profile_public = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
      .bind(nextValue, auth.user.id)
      .run();

    return jsonResponse({
      message: nextValue ? 'Public profile enabled' : 'Public profile disabled',
      user: { profile_public: nextValue },
    });
  }

  if (request.method === 'PUT' && segments[1] === 'theme') {
    const auth = await requireAuth(request, env);
    if (auth.error) return auth.error;

    const hasThemeColumn = await usersTableHasColumn(db, 'theme');
    if (!hasThemeColumn) {
      return jsonResponse({ error: 'Theme preferences are not configured yet' }, 503);
    }

    const { theme } = await parseBody(request);
    if (!['slate', 'midnight', 'light'].includes(theme)) {
      return jsonResponse({ error: 'Invalid theme' }, 400);
    }

    await db
      .prepare('UPDATE users SET theme = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
      .bind(theme, auth.user.id)
      .run();

    return jsonResponse({
      message: 'Theme updated',
      user: { theme },
    });
  }

  if (request.method === 'PUT' && segments[1] === 'link-target') {
    const auth = await requireAuth(request, env);
    if (auth.error) return auth.error;

    const hasLinkTargetColumn = await usersTableHasColumn(db, 'link_target');
    if (!hasLinkTargetColumn) {
      return jsonResponse({ error: 'Link opening preferences are not configured yet' }, 503);
    }

    const { linkTarget } = await parseBody(request);
    if (!['new', 'same'].includes(linkTarget)) {
      return jsonResponse({ error: 'Invalid link target' }, 400);
    }

    await db
      .prepare('UPDATE users SET link_target = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
      .bind(linkTarget, auth.user.id)
      .run();

    return jsonResponse({
      message: 'Link opening preference updated',
      user: { link_target: linkTarget },
    });
  }

  if (request.method === 'GET' && segments[1] === 'api-keys') {
    const auth = await requireAuth(request, env);
    if (auth.error) return auth.error;

    const result = await db
      .prepare(
        `SELECT id, name, key_prefix, key_last4, encrypted_key, created_at, last_used_at, revoked_at
         FROM api_keys
         WHERE user_id = ?
         ORDER BY created_at DESC`
      )
      .bind(auth.user.id)
      .all();

    const apiKeys = [];
    for (const row of result.results || []) {
      let apiKey = null;
      try {
        apiKey = await decryptApiKey(row.encrypted_key, env);
      } catch {
        apiKey = null;
      }
      apiKeys.push({
        id: row.id,
        name: row.name,
        key_prefix: row.key_prefix,
        key_last4: row.key_last4,
        created_at: row.created_at,
        last_used_at: row.last_used_at,
        revoked_at: row.revoked_at,
        api_key: apiKey,
      });
    }

    return jsonResponse({ apiKeys });
  }

  if (request.method === 'POST' && segments[1] === 'api-keys') {
    const auth = await requireAuth(request, env);
    if (auth.error) return auth.error;

    const { name } = await parseBody(request);
    const trimmedName = typeof name === 'string' ? name.trim() : '';
    const keyName = trimmedName || 'Default API Key';

    if (keyName.length > 100) {
      return jsonResponse({ error: 'API key name must be 100 characters or less' }, 400);
    }

    const apiKey = generateApiKeyValue();
    const keyHash = await hashApiKey(apiKey);
    const encryptedKey = await encryptApiKey(apiKey, env);
    const keyPrefix = apiKey.slice(0, 8);
    const keyLast4 = apiKey.slice(-4);

    const insert = await db
      .prepare(
        `INSERT INTO api_keys (user_id, name, key_hash, encrypted_key, key_prefix, key_last4)
         VALUES (?, ?, ?, ?, ?, ?)`
      )
      .bind(auth.user.id, keyName, keyHash, encryptedKey, keyPrefix, keyLast4)
      .run();

    const apiKeyMetadata = await db
      .prepare(
        'SELECT id, name, key_prefix, key_last4, created_at, last_used_at, revoked_at FROM api_keys WHERE id = ?'
      )
      .bind(insert.meta.last_row_id)
      .first();

    return jsonResponse(
      {
        message: 'API key created successfully',
        apiKey,
        apiKeyMetadata,
      },
      201
    );
  }

  if (request.method === 'DELETE' && segments[1] === 'api-keys' && segments[3] === 'permanent') {
    const auth = await requireAuth(request, env);
    if (auth.error) return auth.error;

    const id = Number(segments[2]);
    const result = await db
      .prepare('DELETE FROM api_keys WHERE id = ? AND user_id = ?')
      .bind(id, auth.user.id)
      .run();

    if ((result.meta.changes || 0) === 0) {
      return jsonResponse({ error: 'API key not found' }, 404);
    }

    return jsonResponse({ message: 'API key deleted successfully' });
  }

  if (request.method === 'DELETE' && segments[1] === 'api-keys' && segments[2]) {
    const auth = await requireAuth(request, env);
    if (auth.error) return auth.error;

    const id = Number(segments[2]);
    const result = await db
      .prepare(
        `UPDATE api_keys
         SET revoked_at = CURRENT_TIMESTAMP
         WHERE id = ? AND user_id = ? AND revoked_at IS NULL`
      )
      .bind(id, auth.user.id)
      .run();

    if ((result.meta.changes || 0) === 0) {
      return jsonResponse({ error: 'API key not found or already revoked' }, 404);
    }

    return jsonResponse({ message: 'API key revoked successfully' });
  }

  if (request.method === 'GET' && segments[1] === 'admin' && segments[2] === 'users') {
    const auth = await requireAuth(request, env);
    if (auth.error) return auth.error;

    const access = await requireSuperAdmin(db, auth.user, env);
    if (access.error) return access.error;

    const hasLastLoginAtColumn = await usersTableHasColumn(db, 'last_login_at');
    const lastLoginSelect = hasLastLoginAtColumn ? 'u.last_login_at' : 'NULL AS last_login_at';
    const lockedUntilSelect = (await usersTableHasColumn(db, 'locked_until')) ? 'u.locked_until' : 'NULL AS locked_until';

    const result = await db
      .prepare(
        `SELECT u.id, u.username, u.email, u.membership_tier, u.role, u.stripe_customer_id, u.created_at, u.updated_at, ${lastLoginSelect},
                ${lockedUntilSelect},
                COUNT(b.id) AS bookmark_count
         FROM users u
         LEFT JOIN bookmarks b ON b.user_id = u.id
         GROUP BY u.id
         ORDER BY u.created_at DESC`
      )
      .all();

    const users = (result.results || []).map((u) => ({
      ...u,
      bookmark_count: Number(u.bookmark_count || 0),
    }));

    return jsonResponse({ users });
  }

  if (request.method === 'GET' && segments[1] === 'admin' && segments[2] === 'auth-events') {
    const auth = await requireAuth(request, env);
    if (auth.error) return auth.error;

    const access = await requireSuperAdmin(db, auth.user, env);
    if (access.error) return access.error;

    if (!(await tableExists(db, 'auth_events'))) {
      return jsonResponse({ events: [] });
    }

    const result = await db
      .prepare(
        `SELECT id, event_type, email, user_id, ip, created_at
         FROM auth_events
         WHERE event_type NOT IN ('register_attempt', 'verification_resend_requested')
         ORDER BY id DESC
         LIMIT 200`
      )
      .all();

    return jsonResponse({ events: result.results || [] });
  }

  if (
    request.method === 'PATCH' &&
    segments[1] === 'admin' &&
    segments[2] === 'users' &&
    segments[3]
  ) {
    const auth = await requireAuth(request, env);
    if (auth.error) return auth.error;

    const access = await requireSuperAdmin(db, auth.user, env);
    if (access.error) return access.error;

    const targetId = Number(segments[3]);
    const { membershipTier, role } = await parseBody(request);

    const hasMembershipTier = membershipTier !== undefined;
    const hasRole = role !== undefined;

    if (!hasMembershipTier && !hasRole) {
      return jsonResponse({ error: 'No updates provided' }, 400);
    }

    const validTiers = Object.values(MEMBERSHIP_TIERS);
    const validRoles = Object.values(USER_ROLES);

    if (hasMembershipTier && !validTiers.includes(membershipTier)) {
      return jsonResponse({ error: 'Invalid membership tier' }, 400);
    }

    if (hasRole && !validRoles.includes(role)) {
      return jsonResponse({ error: 'Invalid role' }, 400);
    }

    const targetUser = await db
      .prepare('SELECT id, email, membership_tier, role FROM users WHERE id = ?')
      .bind(targetId)
      .first();

    if (!targetUser) {
      return jsonResponse({ error: 'User not found' }, 404);
    }

    const isConfiguredSuperAdmin = isSuperAdminEmail(targetUser.email, env);

    const nextMembershipTier = hasMembershipTier ? membershipTier : targetUser.membership_tier;
    const nextRole = hasRole ? role : targetUser.role;

    if (isConfiguredSuperAdmin && nextRole !== USER_ROLES.SUPER_ADMIN) {
      return jsonResponse({ error: 'Configured super admin account role cannot be changed' }, 400);
    }

    if (!isConfiguredSuperAdmin && nextRole === USER_ROLES.SUPER_ADMIN) {
      return jsonResponse(
        { error: 'Only the configured super admin email can have super admin role' },
        400
      );
    }

    await db
      .prepare('UPDATE users SET membership_tier = ?, role = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
      .bind(nextMembershipTier, nextRole, targetId)
      .run();

    const updatedUser = await db
      .prepare('SELECT id, username, email, membership_tier, role, created_at, updated_at FROM users WHERE id = ?')
      .bind(targetId)
      .first();

    return jsonResponse({ message: 'User access updated successfully', user: updatedUser });
  }

  if (
    request.method === 'DELETE' &&
    segments[1] === 'admin' &&
    segments[2] === 'users' &&
    segments[3]
  ) {
    const auth = await requireAuth(request, env);
    if (auth.error) return auth.error;

    const access = await requireSuperAdmin(db, auth.user, env);
    if (access.error) return access.error;

    const targetId = Number(segments[3]);

    if (!Number.isInteger(targetId) || targetId <= 0) {
      return jsonResponse({ error: 'Invalid user id' }, 400);
    }

    if (targetId === auth.user.id) {
      return jsonResponse({ error: 'You cannot delete your own account from this panel' }, 400);
    }

    const targetUser = await db
      .prepare('SELECT id, email, role FROM users WHERE id = ?')
      .bind(targetId)
      .first();

    if (!targetUser) {
      return jsonResponse({ error: 'User not found' }, 404);
    }

    if (targetUser.role === USER_ROLES.SUPER_ADMIN || isSuperAdminEmail(targetUser.email, env)) {
      return jsonResponse({ error: 'Configured super admin account cannot be deleted' }, 400);
    }

    await db.batch([
      db.prepare('DELETE FROM bookmark_tags WHERE bookmark_id IN (SELECT id FROM bookmarks WHERE user_id = ?)').bind(targetId),
      db.prepare('DELETE FROM bookmarks WHERE user_id = ?').bind(targetId),
      db.prepare('DELETE FROM favorite_tags WHERE user_id = ?').bind(targetId),
      db.prepare('DELETE FROM api_keys WHERE user_id = ?').bind(targetId),
      db.prepare('DELETE FROM email_verification_tokens WHERE user_id = ?').bind(targetId),
      db.prepare('DELETE FROM password_reset_tokens WHERE user_id = ?').bind(targetId),
      db.prepare('DELETE FROM users WHERE id = ?').bind(targetId),
    ]);

    return jsonResponse({ message: 'User account and bookmarks deleted successfully' });
  }

  if (request.method === 'POST' && segments[1] === 'forgot-password') {
    if (!(await emailTokenStorageReady(db, 'password_reset_tokens'))) {
      return jsonResponse({ error: 'Email authentication is temporarily unavailable. Please try again later.' }, 503);
    }

    const { email } = await parseBody(request);
    const normalizedEmail = normalizeEmail(email);

    // Always return success to prevent email enumeration
    if (!normalizedEmail) {
      return jsonResponse({ message: 'If that email address is registered, a reset link has been sent.' });
    }

    // Throttle before the user lookup, counting requests for unregistered addresses too, so
    // a 429 says nothing about whether the email has an account. The request is only logged
    // (and counted) once it gets past the limits.
    const clientIp = getClientIp(request);
    if (
      (await isAuthRateLimited(db, AUTH_RATE_LIMITS.resetRequestsPerIp, 'ip', clientIp)) ||
      (await isAuthRateLimited(db, AUTH_RATE_LIMITS.resetRequestsPerEmail, 'email', normalizedEmail))
    ) {
      await recordAuthEvent(db, request, 'password_reset_rate_limited', { email: normalizedEmail });
      return rateLimitedResponse('Too many reset requests. Please try again later.');
    }
    if (await isAuthRateLimited(db, AUTH_RATE_LIMITS.resetRequestsPerEmailBurst, 'email', normalizedEmail)) {
      return rateLimitedResponse('Please wait a moment before requesting another reset link.');
    }
    await recordAuthEvent(db, request, 'password_reset_requested', { email: normalizedEmail });

    const user = await db
      .prepare('SELECT id, username FROM users WHERE LOWER(email) = LOWER(?)')
      .bind(normalizedEmail)
      .first();

    if (!user) {
      return jsonResponse({ message: 'If that email address is registered, a reset link has been sent.' });
    }

    // Rate-limit: one request per 60 seconds
    const recent = await db
      .prepare(
        `SELECT id FROM password_reset_tokens
         WHERE user_id = ? AND used_at IS NULL
           AND created_at > datetime('now', '-60 seconds')
         LIMIT 1`
      )
      .bind(user.id)
      .first();

    if (recent) {
      return jsonResponse({ error: 'Please wait a moment before requesting another reset link.' }, 429);
    }

    // Invalidate old unused tokens
    await db
      .prepare('DELETE FROM password_reset_tokens WHERE user_id = ? AND used_at IS NULL')
      .bind(user.id)
      .run();

    const resetToken = generateVerificationToken();
    const expiresAt = new Date(Date.now() + 60 * 60 * 1000).toISOString(); // 1 hour

    await storeEmailToken(db, 'password_reset_tokens', user.id, resetToken, expiresAt);

    try {
      await sendPasswordResetEmail(normalizedEmail, user.username, resetToken, env);
    } catch (err) {
      // Don't reveal failure to the caller, but log it for debugging
      console.error('[forgot-password] Failed to send reset email:', err?.message ?? err);
    }

    return jsonResponse({ message: 'If that email address is registered, a reset link has been sent.' });
  }

  if (request.method === 'POST' && segments[1] === 'reset-password') {
    if (!(await emailTokenStorageReady(db, 'password_reset_tokens'))) {
      return jsonResponse({ error: 'Email authentication is temporarily unavailable. Please try again later.' }, 503);
    }

    const { token, password } = await parseBody(request);

    if (!token || !password) {
      return jsonResponse({ error: 'Token and new password are required.' }, 400);
    }

    if (typeof password !== 'string' || password.length < 6) {
      return jsonResponse({ error: 'Password must be at least 6 characters.' }, 400);
    }

    const record = await db
      .prepare(
        `SELECT prt.id, prt.user_id, prt.expires_at, prt.used_at
         FROM password_reset_tokens prt
         WHERE prt.token_hash = ?`
      )
      .bind(await hashApiKey(token))
      .first();

    if (!record) {
      return jsonResponse({ error: 'Invalid or expired reset link.' }, 400);
    }

    if (record.used_at) {
      return jsonResponse({ error: 'This reset link has already been used.' }, 400);
    }

    if (new Date(record.expires_at) < new Date()) {
      return jsonResponse({ error: 'This reset link has expired. Please request a new one.' }, 400);
    }

    const passwordHash = await bcrypt.hash(password, 10);

    // Hash first (slow), then change everything in one D1 batch (a transaction). The password
    // update is conditional on the token still being unused and unexpired, so of any number of
    // simultaneous redemptions exactly one can change the password, and failure leaves no
    // partial state. D1 serializes writes, so a loser sees the winner's used_at.
    const nowIso = new Date().toISOString();
    const tokenStillValid = 'EXISTS (SELECT 1 FROM password_reset_tokens WHERE id = ? AND used_at IS NULL AND expires_at > ?)';
    // Proving control of the inbox is enough to lift a brute-force lockout.
    const clearsLockout = await usersTableHasColumn(db, 'failed_attempts');
    const bumpsVersion = await usersTableHasColumn(db, 'token_version');
    const [passwordUpdate] = await db.batch([
      db
        .prepare(
          `UPDATE users SET password_hash = ?, updated_at = CURRENT_TIMESTAMP${bumpsVersion ? ', token_version = token_version + 1' : ''}${clearsLockout ? ', failed_attempts = 0, locked_until = NULL' : ''}
           WHERE id = ? AND ${tokenStillValid}`
        )
        .bind(passwordHash, record.user_id, record.id, nowIso),
      db
        .prepare('UPDATE password_reset_tokens SET used_at = CURRENT_TIMESTAMP WHERE id = ? AND used_at IS NULL AND expires_at > ?')
        .bind(record.id, nowIso),
      // Any other outstanding link for this account dies with the successful reset.
      db
        .prepare(
          `UPDATE password_reset_tokens SET used_at = CURRENT_TIMESTAMP
           WHERE user_id = ? AND used_at IS NULL
             AND EXISTS (SELECT 1 FROM password_reset_tokens WHERE id = ? AND used_at IS NOT NULL)`
        )
        .bind(record.user_id, record.id),
    ]);

    if (!passwordUpdate?.meta?.changes) {
      return jsonResponse({ error: 'This reset link has already been used or has expired. Please request a new one.' }, 400);
    }

    const updatedUser = await db
      .prepare('SELECT id, username, email, membership_tier, role FROM users WHERE id = ?')
      .bind(record.user_id)
      .first();

    const authToken = await signUserToken(updatedUser, env, request);

    return sessionResponse(request, {
      message: 'Password reset successfully.',
      token: authToken,
      user: updatedUser,
    });
  }

  return jsonResponse({ error: 'Route not found' }, 404);
}

async function handleBookmarks(request, env, segments) {
  const db = env.DB;
  const auth = await requireAuth(request, env);
  if (auth.error) return auth.error;

  if (request.method === 'GET' && segments.length === 1) {
    const bookmarks = await listBookmarks(db, auth.user.id);
    return jsonResponse({ bookmarks });
  }

  if (request.method === 'POST' && segments[1] === 'meta-description') {
    const { url } = await parseBody(request);
    const metadata = await fetchSiteMetadata(url);

    if (metadata.error) {
      return jsonResponse({ error: metadata.error }, metadata.status || 500);
    }

    if (!metadata.description) {
      if (!metadata.ok) {
        return jsonResponse(
          {
            error: `Site blocked the request (HTTP ${metadata.status}) — try the extension instead, which reads directly from the loaded page`,
          },
          502
        );
      }
      return jsonResponse({ error: 'No meta description found on this page' }, 404);
    }

    return jsonResponse({ description: metadata.description });
  }

  if (request.method === 'POST' && segments[1] === 'meta') {
    const { url } = await parseBody(request);
    const metadata = await fetchSiteMetadata(url);

    if (metadata.error) {
      return jsonResponse({ error: metadata.error }, metadata.status || 500);
    }

    if (!metadata.title && !metadata.description) {
      if (!metadata.ok) {
        return jsonResponse(
          {
            error: `Site blocked the request (HTTP ${metadata.status}) — try the extension instead, which reads directly from the loaded page`,
          },
          502
        );
      }
      return jsonResponse({ error: 'No metadata found on this page' }, 404);
    }

    return jsonResponse({ title: metadata.title, description: metadata.description });
  }

  if (request.method === 'GET' && segments[1] === 'by-url') {
    const url = new URL(request.url).searchParams.get('url');
    if (!url) {
      return jsonResponse({ error: 'url query parameter is required' }, 400);
    }

    const bookmark = await db
      .prepare('SELECT * FROM bookmarks WHERE user_id = ? AND url IN (?, ?) ORDER BY id LIMIT 1')
      .bind(auth.user.id, normalizeBookmarkUrl(url), legacyBookmarkUrl(url))
      .first();

    if (!bookmark) {
      return jsonResponse({ error: 'Bookmark not found' }, 404);
    }

    const tagsByBookmark = await getTagsByBookmarkId(db, auth.user.id);
    return jsonResponse({ bookmark: { ...bookmark, tags: tagsByBookmark.get(bookmark.id) || [] } });
  }

  if (request.method === 'POST' && segments[1] === 'import') {
    const { bookmarks } = await parseBody(request);

    if (!Array.isArray(bookmarks) || bookmarks.length === 0) {
      return jsonResponse({ error: 'bookmarks array is required' }, 400);
    }

    if (bookmarks.length > 2000) {
      return jsonResponse({ error: 'Cannot import more than 2000 bookmarks at once' }, 400);
    }

    const planStatus = await getUserPlanStatus(db, auth.user.id);
    if (!planStatus) {
      return jsonResponse({ error: 'User not found' }, 404);
    }

    if (!planStatus.paidTier && planStatus.bookmarkCount >= FREE_BOOKMARK_LIMIT) {
      return jsonResponse(
        {
          error: `Free users can save up to ${FREE_BOOKMARK_LIMIT} bookmarks. Upgrade to paid for unlimited bookmarks.`,
        },
        403
      );
    }

    const results = { imported: 0, skipped: 0, limitReached: false };
    let remainingSlots = planStatus.remainingSlots;

    for (const bm of bookmarks) {
      const { title, url, description, tags } = bm || {};
      const normalizedUrl = normalizeBookmarkUrl(url);

      if (!title || !normalizedUrl || !isValidHttpUrl(normalizedUrl)) {
        results.skipped += 1;
        continue;
      }

      if (!planStatus.paidTier && remainingSlots <= 0) {
        results.skipped += 1;
        results.limitReached = true;
        continue;
      }

      const existing = await db
        .prepare('SELECT id FROM bookmarks WHERE user_id = ? AND url IN (?, ?)')
        .bind(auth.user.id, normalizedUrl, legacyBookmarkUrl(normalizedUrl))
        .first();

      if (existing) {
        results.skipped += 1;
        continue;
      }

      const insert = await db
        .prepare(
          'INSERT INTO bookmarks (user_id, title, url, description, favicon_url) VALUES (?, ?, ?, ?, ?)'
        )
        .bind(auth.user.id, title, normalizedUrl, description || null, getFaviconUrl(normalizedUrl))
        .run();

      const bookmarkId = insert.meta.last_row_id;

      if (Array.isArray(tags) && tags.length > 0) {
        for (const tagName of tags) {
          if (typeof tagName !== 'string') continue;
          const sanitized = tagName.trim().toLowerCase().replace(/\s+/g, '-');
          if (!sanitized) continue;
          const tag = await ensureTag(db, sanitized);
          await db
            .prepare('INSERT OR IGNORE INTO bookmark_tags (bookmark_id, tag_id) VALUES (?, ?)')
            .bind(bookmarkId, tag.id)
            .run();
        }
      }

      results.imported += 1;
      if (!planStatus.paidTier) {
        remainingSlots -= 1;
      }
    }

    return jsonResponse({
      ...results,
      membership_tier: planStatus.membershipTier,
      bookmark_limit: planStatus.paidTier ? null : FREE_BOOKMARK_LIMIT,
    });
  }

  if (request.method === 'GET' && segments[1] === 'tags' && segments[2] === 'all') {
    const hasFavoriteTagsTable = await tableExists(db, 'favorite_tags');
    const favoriteSelect = hasFavoriteTagsTable
      ? 'CASE WHEN ft.tag_id IS NULL THEN 0 ELSE 1 END AS is_favorite'
      : '0 AS is_favorite';
    const favoriteJoin = hasFavoriteTagsTable
      ? 'LEFT JOIN favorite_tags ft ON ft.tag_id = t.id AND ft.user_id = ?'
      : '';
    const tagBindings = hasFavoriteTagsTable ? [auth.user.id, auth.user.id] : [auth.user.id];

    const result = await db
      .prepare(
        `SELECT t.id, t.name, COUNT(bt.bookmark_id) AS count, ${favoriteSelect}
         FROM tags t
         INNER JOIN bookmark_tags bt ON t.id = bt.tag_id
         INNER JOIN bookmarks b ON bt.bookmark_id = b.id
         ${favoriteJoin}
         WHERE b.user_id = ?
         GROUP BY t.id, t.name, ft.tag_id
         ORDER BY is_favorite DESC, count DESC, t.name ASC`
      )
      .bind(...tagBindings)
      .all();

    const tags = (result.results || []).map((t) => ({
      ...t,
      count: Number(t.count || 0),
    }));

    return jsonResponse({ tags });
  }

  if (request.method === 'POST' && segments[1] === 'tags' && segments[2] === 'merge') {
    const { sourceTagId, targetTagId } = await parseBody(request);
    const sourceId = Number(sourceTagId);
    const targetId = Number(targetTagId);

    if (!Number.isInteger(sourceId) || sourceId <= 0 || !Number.isInteger(targetId) || targetId <= 0) {
      return jsonResponse({ error: 'Invalid tag id' }, 400);
    }

    if (sourceId === targetId) {
      return jsonResponse({ error: 'Cannot merge a tag into itself' }, 400);
    }

    const [sourceTag, targetTag] = await Promise.all([
      db.prepare('SELECT id, name FROM tags WHERE id = ?').bind(sourceId).first(),
      db.prepare('SELECT id, name FROM tags WHERE id = ?').bind(targetId).first(),
    ]);

    if (!sourceTag || !targetTag) {
      return jsonResponse({ error: 'Tag not found' }, 404);
    }

    const ownershipQuery = `
      SELECT COUNT(*) AS count
      FROM bookmark_tags bt
      JOIN bookmarks b ON bt.bookmark_id = b.id
      WHERE bt.tag_id = ? AND b.user_id = ?
    `;
    const [sourceUsage, targetUsage] = await Promise.all([
      db.prepare(ownershipQuery).bind(sourceId, auth.user.id).first(),
      db.prepare(ownershipQuery).bind(targetId, auth.user.id).first(),
    ]);

    if (Number(sourceUsage?.count || 0) === 0 || Number(targetUsage?.count || 0) === 0) {
      return jsonResponse({ error: 'You can only merge tags used by your own bookmarks' }, 404);
    }

    const hasFavoriteTagsTable = await tableExists(db, 'favorite_tags');

    const statements = [
      db.prepare(
        `INSERT OR IGNORE INTO bookmark_tags (bookmark_id, tag_id)
         SELECT bt.bookmark_id, ?
         FROM bookmark_tags bt
         JOIN bookmarks b ON bt.bookmark_id = b.id
         WHERE bt.tag_id = ? AND b.user_id = ?`
      ).bind(targetId, sourceId, auth.user.id),
      db.prepare(
        `DELETE FROM bookmark_tags
         WHERE tag_id = ? AND bookmark_id IN (SELECT id FROM bookmarks WHERE user_id = ?)`
      ).bind(sourceId, auth.user.id),
    ];

    if (hasFavoriteTagsTable) {
      statements.push(
        db.prepare('DELETE FROM favorite_tags WHERE user_id = ? AND tag_id = ?').bind(auth.user.id, sourceId)
      );
    }

    statements.push(
      db
        .prepare('DELETE FROM tags WHERE id = ? AND NOT EXISTS (SELECT 1 FROM bookmark_tags WHERE tag_id = ?)')
        .bind(sourceId, sourceId)
    );

    await db.batch(statements);

    return jsonResponse({
      message: `Merged "${sourceTag.name}" into "${targetTag.name}"`,
      tag: { id: targetTag.id, name: targetTag.name },
    });
  }

  if (request.method === 'POST' && segments[1] && segments[2] === 'favorite') {
    const bookmarkId = Number(segments[1]);

    if (!Number.isInteger(bookmarkId) || bookmarkId <= 0) {
      return jsonResponse({ error: 'Invalid bookmark id' }, 400);
    }

    const result = await toggleBookmarkFlag(db, auth.user.id, bookmarkId, 'is_favorite', {
      onMessage: 'Bookmark favorited successfully',
      offMessage: 'Bookmark removed from favorites',
      notConfiguredMessage: 'Bookmark favorites are not configured yet',
    });

    return result.error || result.response;
  }

  if (request.method === 'POST' && segments[1] && segments[2] === 'private') {
    const bookmarkId = Number(segments[1]);

    if (!Number.isInteger(bookmarkId) || bookmarkId <= 0) {
      return jsonResponse({ error: 'Invalid bookmark id' }, 400);
    }

    const result = await toggleBookmarkFlag(db, auth.user.id, bookmarkId, 'is_private', {
      onMessage: 'Bookmark marked private',
      offMessage: 'Bookmark made public',
      notConfiguredMessage: 'Private bookmarks are not configured yet',
    });

    return result.error || result.response;
  }

  if (request.method === 'POST' && segments[1] === 'tags' && segments[2] && segments[3] === 'favorite') {
    const tagId = Number(segments[2]);
    if (!Number.isInteger(tagId) || tagId <= 0) {
      return jsonResponse({ error: 'Invalid tag id' }, 400);
    }

    const hasFavoriteTagsTable = await tableExists(db, 'favorite_tags');
    if (!hasFavoriteTagsTable) {
      return jsonResponse({ error: 'Favorite tags are not configured yet' }, 503);
    }

    // Tags are global rows, so only reveal or favorite one the caller's own bookmarks use.
    // An existing favorite stays removable even if the tag is no longer used.
    const tag = await db
      .prepare(
        `SELECT t.id, t.name FROM tags t
         WHERE t.id = ?
           AND (EXISTS (SELECT 1 FROM bookmark_tags bt JOIN bookmarks b ON bt.bookmark_id = b.id
                        WHERE bt.tag_id = t.id AND b.user_id = ?)
                OR EXISTS (SELECT 1 FROM favorite_tags ft WHERE ft.tag_id = t.id AND ft.user_id = ?))`
      )
      .bind(tagId, auth.user.id, auth.user.id)
      .first();

    if (!tag) {
      return jsonResponse({ error: 'Tag not found' }, 404);
    }

    const existing = await db
      .prepare('SELECT user_id FROM favorite_tags WHERE user_id = ? AND tag_id = ?')
      .bind(auth.user.id, tagId)
      .first();

    let isFavorite = false;
    if (existing) {
      await db
        .prepare('DELETE FROM favorite_tags WHERE user_id = ? AND tag_id = ?')
        .bind(auth.user.id, tagId)
        .run();
    } else {
      await db
        .prepare('INSERT INTO favorite_tags (user_id, tag_id) VALUES (?, ?)')
        .bind(auth.user.id, tagId)
        .run();
      isFavorite = true;
    }

    return jsonResponse({
      message: isFavorite ? 'Tag favorited successfully' : 'Tag removed from favorites',
      tag: {
        id: tag.id,
        name: tag.name,
        is_favorite: isFavorite,
      },
    });
  }

  if (request.method === 'POST' && segments.length === 1) {
    const { title, url, description, tags } = await parseBody(request);
    const normalizedUrl = normalizeBookmarkUrl(url);

    if (!title || !normalizedUrl) {
      return jsonResponse({ error: 'Title and URL are required' }, 400);
    }

    if (!isValidHttpUrl(normalizedUrl)) {
      return jsonResponse({ error: 'Invalid URL format' }, 400);
    }

    const planStatus = await getUserPlanStatus(db, auth.user.id);
    if (!planStatus) {
      return jsonResponse({ error: 'User not found' }, 404);
    }

    if (!planStatus.paidTier && planStatus.bookmarkCount >= FREE_BOOKMARK_LIMIT) {
      return jsonResponse(
        {
          error: `Free users can save up to ${FREE_BOOKMARK_LIMIT} bookmarks. Upgrade to paid for unlimited bookmarks.`,
        },
        403
      );
    }

    const insert = await db
      .prepare(
        'INSERT INTO bookmarks (user_id, title, url, description, favicon_url) VALUES (?, ?, ?, ?, ?)'
      )
      .bind(auth.user.id, title, normalizedUrl, description || null, getFaviconUrl(normalizedUrl))
      .run();

    const bookmark = await db
      .prepare('SELECT * FROM bookmarks WHERE id = ?')
      .bind(insert.meta.last_row_id)
      .first();

    let bookmarkTags = [];
    if (Array.isArray(tags) && tags.length > 0) {
      try {
        bookmarkTags = await setBookmarkTags(db, bookmark.id, tags);
      } catch (error) {
        if (String(error.message || '').startsWith('INVALID_TAG:')) {
          const invalidTag = error.message.replace('INVALID_TAG:', '');
          return jsonResponse({ error: `Tag "${invalidTag}" must be a single word with no spaces` }, 400);
        }
        throw error;
      }
    }

    return jsonResponse(
      {
        message: 'Bookmark created successfully',
        bookmark: { ...bookmark, tags: bookmarkTags },
      },
      201
    );
  }

  if (segments[1]) {
    const bookmarkId = Number(segments[1]);

    if (request.method === 'GET') {
      const bookmark = await db
        .prepare('SELECT * FROM bookmarks WHERE id = ? AND user_id = ?')
        .bind(bookmarkId, auth.user.id)
        .first();

      if (!bookmark) {
        return jsonResponse({ error: 'Bookmark not found' }, 404);
      }

      if (!bookmark.favicon_url) {
        const faviconUrl = getFaviconUrl(bookmark.url);
        bookmark.favicon_url = faviconUrl;
        await db
          .prepare('UPDATE bookmarks SET favicon_url = ? WHERE id = ?')
          .bind(faviconUrl, bookmark.id)
          .run();
      }

      const tagsByBookmark = await getTagsByBookmarkId(db, auth.user.id);
      return jsonResponse({ bookmark: { ...bookmark, tags: tagsByBookmark.get(bookmark.id) || [] } });
    }

    if (request.method === 'PUT') {
      const { title, url, description, tags } = await parseBody(request);
      const normalizedUrl = normalizeBookmarkUrl(url);

      const existing = await db
        .prepare('SELECT * FROM bookmarks WHERE id = ? AND user_id = ?')
        .bind(bookmarkId, auth.user.id)
        .first();

      if (!existing) {
        return jsonResponse({ error: 'Bookmark not found' }, 404);
      }

      if (!title || !normalizedUrl) {
        return jsonResponse({ error: 'Title and URL are required' }, 400);
      }

      if (!isValidHttpUrl(normalizedUrl)) {
        return jsonResponse({ error: 'Invalid URL format' }, 400);
      }

      await db
        .prepare('UPDATE bookmarks SET title = ?, url = ?, description = ?, favicon_url = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND user_id = ?')
        .bind(title, normalizedUrl, description || null, getFaviconUrl(normalizedUrl), bookmarkId, auth.user.id)
        .run();

      const bookmark = await db
        .prepare('SELECT * FROM bookmarks WHERE id = ? AND user_id = ?')
        .bind(bookmarkId, auth.user.id)
        .first();

      let bookmarkTags = [];
      if (tags !== undefined) {
        try {
          bookmarkTags = await setBookmarkTags(db, bookmark.id, Array.isArray(tags) ? tags : []);
        } catch (error) {
          if (String(error.message || '').startsWith('INVALID_TAG:')) {
            const invalidTag = error.message.replace('INVALID_TAG:', '');
            return jsonResponse({ error: `Tag "${invalidTag}" must be a single word with no spaces` }, 400);
          }
          throw error;
        }
      } else {
        const tagsByBookmark = await getTagsByBookmarkId(db, auth.user.id);
        bookmarkTags = tagsByBookmark.get(bookmark.id) || [];
      }

      return jsonResponse({ message: 'Bookmark updated successfully', bookmark: { ...bookmark, tags: bookmarkTags } });
    }

    if (request.method === 'DELETE') {
      const result = await db
        .prepare('DELETE FROM bookmarks WHERE id = ? AND user_id = ?')
        .bind(bookmarkId, auth.user.id)
        .run();

      if ((result.meta.changes || 0) === 0) {
        return jsonResponse({ error: 'Bookmark not found' }, 404);
      }

      return jsonResponse({ message: 'Bookmark deleted successfully' });
    }
  }

  return jsonResponse({ error: 'Route not found' }, 404);
}

async function handleProfiles(request, env, segments) {
  const db = env.DB;

  if (request.method !== 'GET' || !segments[1]) {
    return jsonResponse({ error: 'Route not found' }, 404);
  }

  const [hasProfilePublicColumn, hasIsPrivateColumn] = await Promise.all([
    usersTableHasColumn(db, 'profile_public'),
    bookmarksTableHasColumn(db, 'is_private'),
  ]);

  if (!hasProfilePublicColumn) {
    return jsonResponse({ error: 'Not found' }, 404);
  }

  let username;
  try {
    username = decodeURIComponent(segments[1]);
  } catch {
    return jsonResponse({ error: 'Not found' }, 404);
  }

  const user = await db
    .prepare('SELECT id, username, profile_public, created_at FROM users WHERE LOWER(username) = LOWER(?)')
    .bind(username)
    .first();

  if (!user || !Number(user.profile_public)) {
    return jsonResponse({ error: 'Not found' }, 404);
  }

  const bookmarksQuery = hasIsPrivateColumn
    ? `SELECT id, title, url, description, favicon_url, created_at, updated_at
       FROM bookmarks WHERE user_id = ? AND is_private = 0 ORDER BY created_at DESC`
    : `SELECT id, title, url, description, favicon_url, created_at, updated_at
       FROM bookmarks WHERE user_id = ? ORDER BY created_at DESC`;

  const [bookmarksResult, tagsByBookmark] = await Promise.all([
    db.prepare(bookmarksQuery).bind(user.id).all(),
    getTagsByBookmarkId(db, user.id, { publicOnly: true, hasIsPrivateColumn }),
  ]);

  let bookmarks = (bookmarksResult.results || []).map((bookmark) => ({
    ...bookmark,
    tags: tagsByBookmark.get(bookmark.id) || [],
  }));

  const tagCounts = new Map();
  for (const bookmark of bookmarks) {
    for (const tag of bookmark.tags) {
      tagCounts.set(tag.name, (tagCounts.get(tag.name) || 0) + 1);
    }
  }
  const tags = [...tagCounts.entries()]
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));

  // Consumed by external sites embedding a user's bookmarks (Settings surfaces these URLs) —
  // repeatable ?tag= params AND together. `tags` above always lists the full public tag set,
  // regardless of this filter, so a consumer can discover what else is available.
  const url = new URL(request.url);
  const appliedTags = [...new Set(
    url.searchParams.getAll('tag').map((tag) => tag.trim().toLowerCase()).filter(Boolean)
  )];

  if (appliedTags.length > 0) {
    bookmarks = bookmarks.filter((bookmark) => {
      const bookmarkTagNames = new Set(bookmark.tags.map((tag) => tag.name.toLowerCase()));
      return appliedTags.every((tag) => bookmarkTagNames.has(tag));
    });
  }

  return jsonResponse({
    profile: {
      username: user.username,
      member_since: user.created_at,
    },
    bookmarks,
    tags,
    appliedTags,
  });
}

async function handleBilling(request, env, segments) {
  const db = env.DB;

  if (request.method === 'POST' && segments[1] === 'webhook') {
    if (!env.STRIPE_WEBHOOK_SECRET) {
      return jsonResponse({ error: 'Webhook secret not configured' }, 500);
    }
    const rawBody = await request.text();
    const sigHeader = request.headers.get('stripe-signature');
    const valid = await verifyStripeSignature(rawBody, sigHeader, env.STRIPE_WEBHOOK_SECRET);
    if (!valid) {
      return jsonResponse({ error: 'Invalid webhook signature' }, 400);
    }
    let event;
    try {
      event = JSON.parse(rawBody);
    } catch {
      return jsonResponse({ error: 'Invalid JSON body' }, 400);
    }
    const result = await processStripeEvent(db, event);
    return jsonResponse({ received: true, result });
  }

  if (request.method === 'POST' && segments[1] === 'checkout-session') {
    const auth = await requireAuth(request, env);
    if (auth.error) return auth.error;
    if (!env.STRIPE_SECRET_KEY) {
      return jsonResponse({ error: 'Stripe is not configured' }, 503);
    }
    const { plan } = await parseBody(request);
    const priceMap = {
      monthly: env.STRIPE_MONTHLY_PRICE_ID,
      annual: env.STRIPE_ANNUAL_PRICE_ID,
    };
    const priceId = priceMap[plan];
    if (!priceId) {
      return jsonResponse({ error: 'Invalid or unavailable plan' }, 400);
    }
    const dbUser = await db.prepare('SELECT * FROM users WHERE id = ?').bind(auth.user.id).first();
    if (!dbUser) return jsonResponse({ error: 'User not found' }, 404);
    if (dbUser.membership_tier === MEMBERSHIP_TIERS.PAID) {
      return jsonResponse({ error: 'Already on a paid plan' }, 400);
    }
    let customerId = dbUser.stripe_customer_id;
    if (!customerId) {
      const customer = await createStripeCustomer(dbUser, env);
      customerId = customer.id;
      await saveStripeCustomerId(db, dbUser.id, customerId);
    } else {
      await updateStripeCustomer(customerId, dbUser, env);
    }
    const appUrl = (env.APP_URL || 'https://tagsta.sh').replace(/\/$/, '');
    const checkoutParams = {
      customer: customerId,
      mode: 'subscription',
      'line_items[0][price]': priceId,
      'line_items[0][quantity]': '1',
      success_url: `${appUrl}/?billing=success`,
      cancel_url: `${appUrl}/?billing=cancelled`,
      'metadata[userId]': String(dbUser.id),
    };
    let session;
    try {
      session = await stripeRequest('POST', '/checkout/sessions', checkoutParams, env);
    } catch (error) {
      if (!customerId || !isStripeMissingResourceError(error)) {
        throw error;
      }

      const customer = await createStripeCustomer(dbUser, env);
      customerId = customer.id;
      await saveStripeCustomerId(db, dbUser.id, customerId);
      session = await stripeRequest(
        'POST',
        '/checkout/sessions',
        {
          ...checkoutParams,
          customer: customerId,
        },
        env
      );
    }
    return jsonResponse({ url: session.url });
  }

  if (request.method === 'POST' && segments[1] === 'portal-session') {
    const auth = await requireAuth(request, env);
    if (auth.error) return auth.error;
    if (!env.STRIPE_SECRET_KEY) {
      return jsonResponse({ error: 'Stripe is not configured' }, 503);
    }
    const dbUser = await db.prepare('SELECT * FROM users WHERE id = ?').bind(auth.user.id).first();
    if (!dbUser) return jsonResponse({ error: 'User not found' }, 404);
    if (!dbUser.stripe_customer_id) {
      return jsonResponse({ error: 'No billing account found' }, 404);
    }
    const appUrl = (env.APP_URL || 'https://tagsta.sh').replace(/\/$/, '');
    let session;
    try {
      session = await stripeRequest('POST', '/billing_portal/sessions', {
        customer: dbUser.stripe_customer_id,
        return_url: `${appUrl}/settings`,
      }, env);
    } catch (error) {
      if (!isStripeMissingResourceError(error)) {
        throw error;
      }

      await clearStripeBillingState(db, dbUser.id);
      return jsonResponse({ error: 'No billing account found' }, 404);
    }
    return jsonResponse({ url: session.url });
  }

  if (request.method === 'GET' && segments[1] === 'status') {
    const auth = await requireAuth(request, env);
    if (auth.error) return auth.error;
    if (!env.STRIPE_SECRET_KEY) {
      return jsonResponse({ error: 'Stripe is not configured' }, 503);
    }

    const dbUser = await db.prepare('SELECT * FROM users WHERE id = ?').bind(auth.user.id).first();
    if (!dbUser) return jsonResponse({ error: 'User not found' }, 404);

    if (!dbUser.stripe_subscription_id) {
      return jsonResponse({
        synced: true,
        subscription: null,
        user: {
          id: dbUser.id,
          username: dbUser.username,
          email: dbUser.email,
          membership_tier: dbUser.membership_tier,
          role: dbUser.role,
        },
      });
    }

    let subscription;
    try {
      subscription = await stripeRequest(
        'GET',
        `/subscriptions/${dbUser.stripe_subscription_id}`,
        null,
        env
      );
    } catch (error) {
      if (!isStripeMissingResourceError(error)) {
        throw error;
      }

      await clearStripeBillingState(db, dbUser.id);
      const refreshedUser = await db
        .prepare('SELECT id, username, email, membership_tier, role FROM users WHERE id = ?')
        .bind(dbUser.id)
        .first();

      return jsonResponse({
        synced: true,
        subscription: null,
        user: refreshedUser,
      });
    }

    const status = subscription?.status;
    const nextTier = ['active', 'trialing'].includes(status)
      ? MEMBERSHIP_TIERS.PAID
      : MEMBERSHIP_TIERS.FREE;

    if (dbUser.membership_tier !== nextTier) {
      await db
        .prepare('UPDATE users SET membership_tier = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
        .bind(nextTier, dbUser.id)
        .run();
    }

    const refreshedUser = await db
      .prepare('SELECT id, username, email, membership_tier, role FROM users WHERE id = ?')
      .bind(dbUser.id)
      .first();

    return jsonResponse({
      synced: true,
      subscription: {
        id: subscription?.id,
        status: subscription?.status,
        cancel_at_period_end: !!subscription?.cancel_at_period_end,
        cancel_at: subscription?.cancel_at || null,
        canceled_at: subscription?.canceled_at || null,
        current_period_end: subscription?.current_period_end || null,
      },
      user: refreshedUser,
    });
  }

  if (request.method === 'GET' && segments[1] === 'plans') {
    return jsonResponse({
      plans: [
        { id: 'monthly', available: !!env.STRIPE_MONTHLY_PRICE_ID },
        { id: 'annual', available: !!env.STRIPE_ANNUAL_PRICE_ID },
      ],
    });
  }

  return jsonResponse({ error: 'Route not found' }, 404);
}

async function handleSupport(request, env, segments) {
  if (request.method !== 'POST' || segments.length !== 1) {
    return jsonResponse({ error: 'Route not found' }, 404);
  }

  const { email, message, captchaToken } = await parseBody(request);
  const normalizedEmail = normalizeEmail(email);
  const trimmedMessage = typeof message === 'string' ? message.trim() : '';

  if (!normalizedEmail || !trimmedMessage) {
    return jsonResponse({ error: 'Email and message are required.' }, 400);
  }

  if (!isValidEmail(normalizedEmail)) {
    return jsonResponse({ error: 'Please provide a valid email address.' }, 400);
  }

  if (trimmedMessage.length < 10) {
    return jsonResponse({ error: 'Message must be at least 10 characters.' }, 400);
  }

  if (trimmedMessage.length > 4000) {
    return jsonResponse({ error: 'Message must be 4000 characters or less.' }, 400);
  }

  const captcha = await verifyTurnstile(request, env, captchaToken);
  if (!captcha.ok) {
    return jsonResponse({ error: captcha.error }, captcha.status);
  }

  if (!env.CLOUDFLARE_API_TOKEN || !env.CLOUDFLARE_ACCOUNT_ID) {
    return jsonResponse({ error: 'Support email is not configured.' }, 503);
  }

  const toAddress = env.SUPPORT_EMAIL || 'support@tagsta.sh';
  const fromAddress = emailFrom('EMAIL_FROM_CONTACT', 'contact@tagsta.sh', env);

  const textBody = [
    'New Tagstash support request',
    '',
    `Account email: ${normalizedEmail}`,
    '',
    'Message:',
    trimmedMessage,
  ].join('\n');

  const escapedEmail = normalizedEmail
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
  const escapedMessage = trimmedMessage
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');

  const htmlBody = `
<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta name="color-scheme" content="light only" />
    <meta name="supported-color-schemes" content="light" />
    <title>Tagstash support request</title>
  </head>
  <body style="margin:0;padding:24px;background-color:#f3f4f6;color:#111827;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;line-height:1.5;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:700px;margin:0 auto;border-collapse:collapse;">
      <tr>
        <td style="background-color:#ffffff;border:1px solid #e5e7eb;border-radius:12px;padding:20px;color:#111827;">
          <h2 style="margin:0 0 12px 0;color:#111827;font-size:24px;line-height:1.25;">New Tagstash support request</h2>
          <p style="margin:0 0 12px 0;color:#111827;">
            <strong>Account email:</strong>
            <a href="mailto:${escapedEmail}" style="color:#0f172a;text-decoration:underline;">${escapedEmail}</a>
          </p>
          <p style="margin:0 0 8px 0;color:#111827;"><strong>Message:</strong></p>
          <div style="white-space:pre-wrap;background-color:#f9fafb;border:1px solid #e5e7eb;padding:12px;border-radius:8px;color:#111827;">${escapedMessage}</div>
        </td>
      </tr>
    </table>
  </body>
</html>`;

  try {
    await sendEmail(
      {
        from: fromAddress,
        to: toAddress,
        replyTo: normalizedEmail,
        subject: `Tagstash support request from ${normalizedEmail}`,
        text: textBody,
        html: htmlBody,
      },
      env
    );
  } catch {
    return jsonResponse({ error: 'Failed to send support request. Please try again.' }, 500);
  }

  return jsonResponse({ message: 'Support request sent successfully.' }, 201);
}

export const onRequestOptions = async ({ request, env }) =>
  new Response(null, { status: 204, headers: corsHeadersFor(request, env) });

export async function onRequest(context) {
  const { request, env } = context;
  const unsafe = !['GET', 'HEAD', 'OPTIONS'].includes(request.method);
  const webhook = new URL(request.url).pathname === '/api/billing/webhook';
  // A custom header + verified web origin prevents form and cross-origin login CSRF.
  // Explicit bearer requests never authenticate through cookies. Stripe verifies its signature.
  const needsProof = isWebClient(request) ||
    (unsafe && !webhook && !getBearerToken(request) && !!getSessionCookie(request));
  const response = needsProof && !hasWebRequestProof(request, env)
    ? jsonResponse({ error: 'Invalid web request origin' }, 403)
    : await routeRequest(context);
  response.headers.set('Cache-Control', 'no-store');
  return withCors(response, request, env);
}

async function routeRequest(context) {
  try {
    const { request, env } = context;
    const url = new URL(request.url);
    const segments = url.pathname.split('/').filter(Boolean);

    if (segments[0] !== 'api') {
      return jsonResponse({ error: 'Route not found' }, 404);
    }

    if (request.method === 'GET' && segments[1] === 'health') {
      return jsonResponse({ status: 'ok', message: 'Tagstash API is running' });
    }

    if (!env.DB) {
      return jsonResponse({ error: 'D1 binding DB is not configured' }, 500);
    }

    if (segments[1] === 'auth') {
      return await handleAuth(request, env, segments.slice(1));
    }

    if (segments[1] === 'bookmarks') {
      return await handleBookmarks(request, env, segments.slice(1));
    }

    if (segments[1] === 'profiles') {
      return await handleProfiles(request, env, segments.slice(1));
    }

    if (segments[1] === 'billing') {
      return await handleBilling(request, env, segments.slice(1));
    }

    if (segments[1] === 'support') {
      return await handleSupport(request, env, segments.slice(1));
    }

    return jsonResponse({ error: 'Route not found' }, 404);
  } catch (error) {
    console.error('API handler error:', error);
    return jsonResponse({ error: 'Something went wrong!' }, 500);
  }
}

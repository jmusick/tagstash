import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { onRequestGet as profilePage } from '../functions/u/[username].js';
import { onRequestGet as sitemap } from '../functions/sitemap.xml.js';
import { createAuthEnv } from './helpers/auth-env.mjs';
import { call, loginHeaders } from './helpers/api.mjs';

// Private Markdown notes on bookmarks (issue #60). Owner decisions: a note is OWNER-ONLY, so it must
// never appear on any public surface (the profile API, the /u/:username snapshot, the sitemap),
// even on a public bookmark; owner reads and writes carry it like any library field, including
// through personal API keys; the trash keeps it. Migration 0020 adds the column; code deployed
// before it refuses writes that carry a note and otherwise behaves as before.

const NOTE_LIMIT = (() => {
  const source = readFileSync(new URL('../functions/api/[[path]].js', import.meta.url), 'utf8');
  return Number(/const INPUT_LIMITS = \{[\s\S]*?\n\s*note: (\d+),/.exec(source)[1]);
})();

const SECRET = 'SECRET-NOTE-7f3a';
const OLD = '2025-01-01 00:00:00';

async function setup() {
  const env = await createAuthEnv();
  return { env, headers: await loginHeaders(env) };
}

const one = (env, text, ...args) => env.sqlite.prepare(text).get(...args);
const noteOf = (env, id) => one(env, 'SELECT note FROM bookmarks WHERE id = ?', id)?.note;
const count = (env) => one(env, 'SELECT COUNT(*) AS n FROM bookmarks').n;

const create = async (env, headers, body) => call(env, 'bookmarks', { method: 'POST', headers, body: { title: 'T', url: 'https://example.com/a', ...body } });

class FakeRewriter {
  constructor() { this.handlers = {}; }
  on(selector, handler) { this.handlers[selector] = handler; return this; }
  async transform(response) {
    let appended = '';
    let before = '';
    this.handlers.head?.element({ append: (content) => { appended += content; } });
    this.handlers['#root']?.element({ before: (content) => { before += content; } });
    const html = (await response.text())
      .replace('</head>', `${appended}</head>`)
      .replace('<div id="root">', () => `${before}<div id="root">`);
    return new Response(html, response);
  }
}
const shell = '<!doctype html><html><head><title>x</title></head><body><div id="root"></div></body></html>';

test('create, read, list and update carry the note; omitted keeps it, null or blank clears it', async () => {
  const { env, headers } = await setup();
  try {
    const note = '  - first\n- **second** [link](https://example.org)\n';
    let response = await create(env, headers, { note, tags: ['alpha'] });
    assert.equal(response.status, 201);
    const { bookmark } = await response.json();
    // Stored exactly as sent (leading spaces can be Markdown).
    assert.equal(bookmark.note, note);
    assert.equal(noteOf(env, bookmark.id), note);

    response = await call(env, `bookmarks/${bookmark.id}`, { headers });
    assert.equal((await response.json()).bookmark.note, note);
    response = await call(env, 'bookmarks', { headers });
    assert.equal((await response.json()).bookmarks[0].note, note);

    // Older clients (the extension) never send `note`: the stored one stays.
    response = await call(env, `bookmarks/${bookmark.id}`, { method: 'PUT', headers, body: { title: 'Renamed', url: 'https://example.com/a' } });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).bookmark.note, note);
    assert.equal(noteOf(env, bookmark.id), note);

    response = await call(env, `bookmarks/${bookmark.id}`, { method: 'PUT', headers, body: { title: 'T', url: 'https://example.com/a', note: 'changed' } });
    assert.equal((await response.json()).bookmark.note, 'changed');

    for (const cleared of [null, '', '   \n ']) {
      await call(env, `bookmarks/${bookmark.id}`, { method: 'PUT', headers, body: { title: 'T', url: 'https://example.com/a', note: 'again' } });
      response = await call(env, `bookmarks/${bookmark.id}`, { method: 'PUT', headers, body: { title: 'T', url: 'https://example.com/a', note: cleared } });
      assert.equal(response.status, 200);
      assert.equal(noteOf(env, bookmark.id), null, JSON.stringify(cleared));
    }

    // A bookmark saved without a note lists with note: null.
    await create(env, headers, { url: 'https://example.com/b' });
    const list = (await (await call(env, 'bookmarks', { headers })).json()).bookmarks;
    assert.deepEqual(list.map((b) => b.note), [null, null]);
  } finally { env.sqlite.close(); }
});

test('invalid notes are a 400 before anything is written', async () => {
  const { env, headers } = await setup();
  try {
    const { bookmark } = await (await create(env, headers, { note: 'keep me', tags: ['alpha'] })).json();
    const before = { ...one(env, 'SELECT title, url, note, updated_at FROM bookmarks WHERE id = ?', bookmark.id) };
    for (const note of [42, ['a'], { text: 'a' }, true, 'x'.repeat(NOTE_LIMIT + 1)]) {
      let response = await call(env, `bookmarks/${bookmark.id}`, { method: 'PUT', headers, body: { title: 'Changed', url: 'https://example.com/z', note } });
      assert.equal(response.status, 400, String(note).slice(0, 20));
      assert.match((await response.json()).error, /Note/);
      assert.deepEqual({ ...one(env, 'SELECT title, url, note, updated_at FROM bookmarks WHERE id = ?', bookmark.id) }, before);

      response = await create(env, headers, { url: 'https://example.com/new', note });
      assert.equal(response.status, 400);
      assert.equal(count(env), 1);
    }
    // Exactly at the limit is fine.
    const response = await create(env, headers, { url: 'https://example.com/max', note: 'x'.repeat(NOTE_LIMIT) });
    assert.equal(response.status, 201);
  } finally { env.sqlite.close(); }
});

test('import reads notes, truncates over-long ones and rejects non-string ones per row', async () => {
  const { env, headers } = await setup();
  try {
    const response = await call(env, 'bookmarks/import', {
      method: 'POST', headers,
      body: {
        bookmarks: [
          { title: 'A', url: 'https://a.example/', note: '# Heading\n\ntext', tags: ['x'] },
          { title: 'B', url: 'https://b.example/', note: 'y'.repeat(NOTE_LIMIT + 5) },
          { title: 'C', url: 'https://c.example/', note: 7 },
          { title: 'D', url: 'https://d.example/', note: '   ' },
          { title: 'E', url: 'https://e.example/' },
        ],
      },
    });
    assert.equal(response.status, 200);
    const summary = await response.json();
    assert.equal(summary.imported, 4);
    assert.equal(summary.invalid, 1);
    assert.equal(summary.truncated, 1);
    assert.deepEqual(summary.invalidRows, [{ index: 2, error: 'Note must be a string' }]);
    const notes = Object.fromEntries(env.sqlite.prepare('SELECT title, note FROM bookmarks').all().map((row) => [row.title, row.note]));
    assert.equal(notes.A, '# Heading\n\ntext');
    assert.equal(notes.B.length, NOTE_LIMIT);
    assert.equal(notes.D, null);
    assert.equal(notes.E, null);
  } finally { env.sqlite.close(); }
});

test('the trash keeps the note and a restore brings it back', async () => {
  const { env, headers } = await setup();
  try {
    const { bookmark } = await (await create(env, headers, { note: 'remember this' })).json();
    assert.equal((await call(env, `bookmarks/${bookmark.id}`, { method: 'DELETE', headers })).status, 200);
    const trash = await (await call(env, 'bookmarks/trash', { headers })).json();
    assert.equal(trash.bookmarks[0].note, 'remember this');
    assert.equal((await call(env, `bookmarks/${bookmark.id}/restore`, { method: 'POST', headers })).status, 200);
    const restored = await (await call(env, `bookmarks/${bookmark.id}`, { headers })).json();
    assert.equal(restored.bookmark.note, 'remember this');
  } finally { env.sqlite.close(); }
});

test('personal API keys read and write notes like any library field', async () => {
  const { env, headers: session } = await setup();
  try {
    const created = await call(env, 'auth/api-keys', { method: 'POST', headers: session, body: { name: 'Script' } });
    const { apiKey } = await created.json();
    const headers = { Authorization: `Bearer ${apiKey}` };
    const response = await create(env, headers, { note: 'from a script' });
    assert.equal(response.status, 201);
    const { bookmark } = await response.json();
    const list = await (await call(env, 'bookmarks', { headers })).json();
    assert.equal(list.bookmarks.find((b) => b.id === bookmark.id).note, 'from a script');
    const byUrl = await (await call(env, `bookmarks/by-url?url=${encodeURIComponent('https://example.com/a')}`, { headers })).json();
    assert.equal(byUrl.bookmark.note, 'from a script');
  } finally { env.sqlite.close(); }
});

test('a note never reaches the public profile API, the /u/:username snapshot or the sitemap', async () => {
  const { env, headers } = await setup();
  try {
    // An indexable public profile (verified, old enough, at least five public bookmarks), so the
    // SSR snapshot and the sitemap entry are actually produced.
    env.sqlite.prepare('UPDATE users SET profile_public = 1, created_at = ? WHERE id = 1').run(OLD);
    for (let i = 0; i < 6; i += 1) {
      const response = await create(env, headers, {
        title: `Public ${i}`, url: `https://public.example/${i}`, description: 'public description',
        note: `${SECRET} number ${i} <script>alert(1)</script>`, tags: ['shared'],
      });
      assert.equal(response.status, 201);
    }
    // The owner sees the notes.
    const owner = await (await call(env, 'bookmarks', { headers })).json();
    assert.ok(owner.bookmarks.every((b) => b.note.includes(SECRET)));

    for (const query of ['', '?tag=shared']) {
      const response = await call(env, `profiles/sessiontester${query}`);
      assert.equal(response.status, 200);
      const text = await response.text();
      assert.ok(!text.includes(SECRET), `profile API${query} leaked a note`);
      const body = JSON.parse(text);
      assert.equal(body.bookmarks.length, 6);
      for (const bookmark of body.bookmarks) assert.ok(!('note' in bookmark));
      assert.equal(body.profile.indexable, true);
    }
    // Owners get the same anonymous body (the response is edge-cached and viewer-independent).
    const asOwner = await (await call(env, 'profiles/sessiontester', { headers })).text();
    assert.ok(!asOwner.includes(SECRET));

    globalThis.HTMLRewriter = FakeRewriter;
    const page = await (await profilePage({
      request: new Request('https://tagsta.sh/u/sessiontester'), env, params: { username: 'sessiontester' },
      next: async () => new Response(shell, { headers: { 'Content-Type': 'text/html' } }),
    })).text();
    assert.match(page, /ssr-profile/);
    assert.match(page, /Public 0/);
    assert.ok(!page.includes(SECRET), 'SSR snapshot leaked a note');

    const map = await (await sitemap({ request: new Request('https://tagsta.sh/sitemap.xml'), env })).text();
    assert.match(map, /\/u\/sessiontester/);
    assert.ok(!map.includes(SECRET));
  } finally { delete globalThis.HTMLRewriter; env.sqlite.close(); }
});

test('before migration 0020: writes with a note answer 503 and change nothing, everything else works', async () => {
  const { env, headers } = await setup();
  try {
    env.sqlite.exec('ALTER TABLE bookmarks DROP COLUMN note');

    let response = await create(env, headers, { note: 'too early', tags: ['alpha'] });
    assert.equal(response.status, 503);
    assert.equal(count(env), 0);
    assert.equal(one(env, "SELECT COUNT(*) AS n FROM tags WHERE name = 'alpha'").n, 0);

    // Without a note (omitted, null or blank), saves work as before.
    for (const body of [{}, { note: null }, { note: '' }]) {
      response = await create(env, headers, { url: `https://example.com/${count(env)}`, ...body });
      assert.equal(response.status, 201, JSON.stringify(body));
    }
    const id = one(env, 'SELECT MIN(id) AS id FROM bookmarks').id;

    response = await call(env, `bookmarks/${id}`, { method: 'PUT', headers, body: { title: 'Kept', url: 'https://example.com/0', note: 'too early' } });
    assert.equal(response.status, 503);
    assert.equal(one(env, 'SELECT title FROM bookmarks WHERE id = ?', id).title, 'T');
    for (const body of [{}, { note: null }]) {
      response = await call(env, `bookmarks/${id}`, { method: 'PUT', headers, body: { title: 'Edited', url: 'https://example.com/0', ...body } });
      assert.equal(response.status, 200);
    }

    const list = await (await call(env, 'bookmarks', { headers })).json();
    assert.equal(list.bookmarks.length, 3);
    assert.ok(list.bookmarks.every((b) => b.note === null));

    const before = count(env);
    response = await call(env, 'bookmarks/import', { method: 'POST', headers, body: { bookmarks: [
      { title: 'I1', url: 'https://i1.example/' },
      { title: 'I2', url: 'https://i2.example/', note: 'a note' },
    ] } });
    assert.equal(response.status, 503);
    assert.equal(count(env), before);
    response = await call(env, 'bookmarks/import', { method: 'POST', headers, body: { bookmarks: [
      { title: 'I1', url: 'https://i1.example/' },
      { title: 'I2', url: 'https://i2.example/', note: '  ' },
    ] } });
    assert.equal(response.status, 200);
    assert.equal(count(env), before + 2);
  } finally { env.sqlite.close(); }
});

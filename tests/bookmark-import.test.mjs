import test from 'node:test';
import assert from 'node:assert/strict';
import bcrypt from 'bcryptjs';
import { createAuthEnv } from './helpers/auth-env.mjs';
import { call, loginHeaders } from './helpers/api.mjs';

// Records every query the import makes: standalone ones and statements inside db.batch.
function instrument(env) {
  const log = { standalone: 0, batches: [], maxBinds: 0 };
  const realPrepare = env.DB.prepare.bind(env.DB);
  const realBatch = env.DB.batch.bind(env.DB);
  let inBatch = false;
  env.DB.prepare = (sql) => {
    const statement = realPrepare(sql);
    const realBind = statement.bind.bind(statement);
    statement.bind = (...values) => { log.maxBinds = Math.max(log.maxBinds, values.length); return realBind(...values); };
    for (const method of ['first', 'all', 'run']) {
      const real = statement[method].bind(statement);
      statement[method] = (...args) => { if (!inBatch) log.standalone += 1; return real(...args); };
    }
    return statement;
  };
  env.DB.batch = async (statements) => {
    log.batches.push(statements.length);
    inBatch = true;
    try { return await realBatch(statements); } finally { inBatch = false; }
  };
  return log;
}

async function setup({ paid = true } = {}) {
  const env = await createAuthEnv();
  if (paid) env.sqlite.exec("UPDATE users SET membership_tier = 'paid'");
  env.sqlite.prepare(`INSERT INTO users (id, username, email, password_hash, email_verified) VALUES (2, 'other', 'other@example.com', ?, 1)`)
    .run(await bcrypt.hash('other-password-123', 4));
  return { env, headers: await loginHeaders(env) };
}

const importRows = (env, headers, bookmarks) => call(env, 'bookmarks/import', { method: 'POST', headers, body: { bookmarks } });
const tagsOf = (env, url) => env.sqlite.prepare(
  `SELECT t.name FROM bookmarks b JOIN bookmark_tags bt ON bt.bookmark_id = b.id JOIN tags t ON t.id = bt.tag_id
   WHERE b.user_id = 1 AND b.url = ? ORDER BY t.name`).all(url).map((r) => r.name);

test('2000 bookmarks with shared tags import correctly in a handful of batched queries', async () => {
  const { env, headers } = await setup();
  try {
    // Other users' bookmarks and an existing global tag interleave with the import's ids.
    env.sqlite.prepare("INSERT INTO bookmarks (user_id, url, title) VALUES (2, 'https://site.example/7', 'theirs')").run();
    env.sqlite.prepare("INSERT INTO tags (name) VALUES ('shared-3')").run();
    const bookmarks = Array.from({ length: 2000 }, (_, i) => ({
      title: `Bookmark ${i}`,
      url: `https://site.example/${i}`,
      description: i % 2 ? `note ${i}` : null,
      tags: [`shared-${i % 20}`, `shared-${(i + 7) % 20}`, i % 100 === 0 ? `Unique Tag ${i}` : 'common'],
    }));
    const log = instrument(env);
    const response = await importRows(env, headers, bookmarks);
    assert.equal(response.status, 200);
    const summary = await response.json();
    assert.equal(summary.imported, 2000);
    assert.equal(summary.skipped, 0);
    assert.equal(summary.duplicates, 0);
    assert.equal(summary.membership_tier, 'paid');

    // 8 chunks of 250, each one atomic batch of 3 statements; a few reads around them.
    assert.deepEqual(log.batches.slice(-8), Array(8).fill(3));
    assert.equal(log.batches.length, 9); // plus the rate-limit event write
    assert.ok(log.standalone <= 12, `${log.standalone} standalone queries`);
    assert.ok(log.maxBinds <= 3, `a statement bound ${log.maxBinds} values`);

    const count = (sql) => env.sqlite.prepare(sql).get().n;
    assert.equal(count('SELECT COUNT(*) AS n FROM bookmarks WHERE user_id = 1'), 2000);
    assert.equal(count("SELECT COUNT(*) AS n FROM tags WHERE name LIKE 'shared-%'"), 20);
    assert.equal(count('SELECT COUNT(*) AS n FROM bookmark_tags bt JOIN bookmarks b ON b.id = bt.bookmark_id WHERE b.user_id = 1'), 6000);
    for (const i of [0, 1, 249, 250, 251, 1337, 1999]) {
      const expected = [...new Set([`shared-${i % 20}`, `shared-${(i + 7) % 20}`, i % 100 === 0 ? `unique-tag-${i}` : 'common'])].sort();
      assert.deepEqual(tagsOf(env, `https://site.example/${i}`), expected, `bookmark ${i}`);
    }
    // The other user's bookmark with a matching URL was neither touched nor treated as a duplicate.
    assert.equal(count('SELECT COUNT(*) AS n FROM bookmark_tags bt JOIN bookmarks b ON b.id = bt.bookmark_id WHERE b.user_id = 2'), 0);
    const row = env.sqlite.prepare("SELECT title, description, favicon_url FROM bookmarks WHERE user_id = 1 AND url = 'https://site.example/1'").get();
    assert.deepEqual({ ...row }, { title: 'Bookmark 1', description: 'note 1', favicon_url: 'https://www.google.com/s2/favicons?sz=64&domain=site.example' });
  } finally { env.sqlite.close(); }
});

test('invalid rows are skipped with reasons; soft problems are fixed up; duplicates are skipped', async () => {
  const { env, headers } = await setup();
  try {
    env.sqlite.prepare("INSERT INTO bookmarks (user_id, url, title) VALUES (1, 'https://legacy.example', 'old root')").run();
    env.sqlite.prepare("INSERT INTO bookmarks (user_id, url, title) VALUES (1, 'https://have.example/a', 'already')").run();
    const rows = [
      'not an object',                                              // 0 invalid
      null,                                                         // 1 invalid
      { title: 'No URL' },                                          // 2 invalid
      { title: 42, url: 'https://n.example/' },                     // 3 invalid
      { title: 'Bad scheme', url: 'javascript:alert(1)' },          // 4 invalid
      { title: 'Long URL', url: `https://e.example/${'x'.repeat(9000)}` }, // 5 invalid
      { title: 'Bad note', url: 'https://e.example/n', description: 5 }, // 6 invalid
      { title: 'Bad tags', url: 'https://e.example/t', tags: 'a,b' },     // 7 invalid
      { title: 'Root dup', url: 'legacy.example' },                 // 8 duplicate (legacy form)
      { title: 'Existing', url: 'https://have.example/a' },         // 9 duplicate
      { title: `  ${'T'.repeat(1500)}  `, url: 'https://ok.example/1', description: 'D'.repeat(12000),
        tags: ['Two Words', 'x'.repeat(101), 7, 'two-words', ...Array.from({ length: 60 }, (_, i) => `t${i}`)] }, // 10 kept
      { title: 'Repeat in file', url: 'https://ok.example/1' },     // 11 duplicate within the file
      { title: 'Plain', url: 'https://ok.example/2', tags: null },  // 12 kept
    ];
    const response = await importRows(env, headers, rows);
    assert.equal(response.status, 200);
    const summary = await response.json();
    assert.equal(summary.imported, 2);
    assert.equal(summary.invalid, 8);
    assert.equal(summary.duplicates, 3);
    assert.equal(summary.skipped, 11);
    assert.equal(summary.truncated, 1);
    assert.equal(summary.droppedTags, 2 + 11); // the 101-char and numeric tags, then 11 over the 50 cap
    assert.deepEqual(summary.invalidRows.map((r) => r.index), [0, 1, 2, 3, 4, 5, 6, 7]);
    assert.ok(summary.invalidRows.every((r) => typeof r.error === 'string'));

    const kept = env.sqlite.prepare("SELECT title, description FROM bookmarks WHERE url = 'https://ok.example/1'").get();
    assert.equal(kept.title, 'T'.repeat(1000));
    assert.equal(kept.description.length, 10000);
    const tags = tagsOf(env, 'https://ok.example/1');
    assert.equal(tags.length, 50);
    assert.ok(tags.includes('two-words'));
    assert.deepEqual(tagsOf(env, 'https://ok.example/2'), []);
  } finally { env.sqlite.close(); }
});

test('request-level problems reject the whole import and write nothing', async () => {
  const { env, headers } = await setup();
  try {
    const before = env.sqlite.prepare('SELECT COUNT(*) AS n FROM bookmarks').get().n;
    for (const bookmarks of [undefined, [], 'rows', { 0: {} }]) {
      assert.equal((await importRows(env, headers, bookmarks)).status, 400);
    }
    const tooMany = Array.from({ length: 2001 }, (_, i) => ({ title: 't', url: `https://e.example/${i}` }));
    assert.equal((await importRows(env, headers, tooMany)).status, 400);
    const huge = JSON.stringify({ bookmarks: [{ title: 't', url: 'https://e.example/', description: 'x'.repeat(9 * 1024 * 1024) }] });
    assert.equal((await call(env, 'bookmarks/import', { method: 'POST', headers, body: huge })).status, 413);
    assert.equal(env.sqlite.prepare('SELECT COUNT(*) AS n FROM bookmarks').get().n, before);
  } finally { env.sqlite.close(); }
});

test('free plans import up to their remaining slots', async () => {
  const { env, headers } = await setup({ paid: false });
  try {
    const insert = env.sqlite.prepare('INSERT INTO bookmarks (user_id, url, title) VALUES (1, ?, ?)');
    for (let i = 0; i < 45; i += 1) insert.run(`https://mine.example/${i}`, `mine ${i}`);
    const rows = [
      { title: 'dup', url: 'https://mine.example/0' },
      ...Array.from({ length: 10 }, (_, i) => ({ title: `new ${i}`, url: `https://new.example/${i}`, tags: ['x'] })),
    ];
    const summary = await (await importRows(env, headers, rows)).json();
    assert.equal(summary.imported, 5);
    assert.equal(summary.duplicates, 1);
    assert.equal(summary.skipped, 6);
    assert.equal(summary.limitReached, true);
    assert.equal(summary.bookmark_limit, 50);
    assert.equal(env.sqlite.prepare('SELECT COUNT(*) AS n FROM bookmarks WHERE user_id = 1').get().n, 50);
  } finally { env.sqlite.close(); }
});

test('a failing chunk rolls back alone; earlier chunks stay and a retry finishes the job', async () => {
  const { env, headers } = await setup();
  const realBatch = env.DB.batch.bind(env.DB);
  let importBatches = 0;
  env.DB.batch = async (statements) => {
    if (statements.length === 3 && (importBatches += 1) === 2) {
      // Let the chunk partially execute, then fail: the transaction must undo it.
      return realBatch([...statements.slice(0, 2), env.DB.prepare('INSERT INTO no_such_table VALUES (1)')]);
    }
    return realBatch(statements);
  };
  const realError = console.error;
  console.error = () => {};
  try {
    const rows = Array.from({ length: 600 }, (_, i) => ({ title: `b${i}`, url: `https://chunk.example/${i}`, tags: [`tag-${i}`] }));
    const failed = await importRows(env, headers, rows);
    assert.equal(failed.status, 500);
    const partial = await failed.json();
    assert.equal(partial.imported, 250);
    assert.equal(partial.skipped, 350);
    assert.match(partial.error, /250 bookmarks were saved/);
    const count = () => env.sqlite.prepare('SELECT COUNT(*) AS n FROM bookmarks WHERE user_id = 1').get().n;
    assert.equal(count(), 250);
    // Nothing from the failed chunk leaked: no bookmarks, no tags.
    assert.equal(env.sqlite.prepare("SELECT COUNT(*) AS n FROM tags WHERE name = 'tag-300'").get().n, 0);

    const retried = await (await importRows(env, headers, rows)).json();
    assert.equal(retried.imported, 350);
    assert.equal(retried.duplicates, 250);
    assert.equal(count(), 600);
    assert.deepEqual(tagsOf(env, 'https://chunk.example/599'), ['tag-599']);
  } finally { console.error = realError; env.sqlite.close(); }
});

test('imports are rate limited per account', async () => {
  const { env, headers } = await setup();
  try {
    const insert = env.sqlite.prepare("INSERT INTO auth_events (event_type, user_id) VALUES ('bookmark_import', 1)");
    for (let i = 0; i < 20; i += 1) insert.run();
    const response = await importRows(env, headers, [{ title: 't', url: 'https://e.example/' }]);
    assert.equal(response.status, 429);
    assert.equal(env.sqlite.prepare('SELECT COUNT(*) AS n FROM bookmarks').get().n, 0);
  } finally { env.sqlite.close(); }
});

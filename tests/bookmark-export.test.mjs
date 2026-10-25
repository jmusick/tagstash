import test from 'node:test';
import assert from 'node:assert/strict';
import { serializeBookmarks, unescapeCsvField } from '../src/utils/bookmarkExport.js';
import { parseBookmarksCSV, parseTagstashJSON } from '../src/utils/bookmarkImport.js';

const bookmark = {
  title: '=HYPERLINK("https://example.com")', url: 'https://example.com/?a=1&b="2"',
  description: 'First line\n<script>alert("x")</script>',
  tags: [{ id: 1, name: 'research' }, { id: 2, name: 'work' }],
  created_at: '2026-10-01T12:00:00Z', updated_at: '2026-10-02T12:00:00Z',
  is_private: 1, is_favorite: 1, user_id: 123,
};

test('JSON preserves private bookmarks, tags, dates and flags without user identifiers', () => {
  const file = serializeBookmarks([bookmark], 'json');
  const record = JSON.parse(file.content).bookmarks[0];
  assert.deepEqual(record.tags, ['research', 'work']);
  assert.equal(record.is_private, true);
  assert.equal(record.is_favorite, true);
  assert.equal(record.description, bookmark.description);
  assert.equal(record.created_at, bookmark.created_at);
  assert.equal(record.user_id, undefined);
});

test('CSV escapes commas, quotes and multiline notes and neutralizes spreadsheet formulas', () => {
  const file = serializeBookmarks([bookmark], 'csv');
  // `description` and the private `note` are separate columns (before notes, the description
  // column was called `note`; bookmarkImport.js still reads such files the old way).
  assert.ok(file.content.startsWith('\uFEFFtitle,url,description,tags,created_at,updated_at,is_favorite,is_private,note\r\n'));
  assert.ok(file.content.includes('"\'=HYPERLINK(""https://example.com"")"'));
  assert.ok(file.content.includes('"research, work"'));
  assert.ok(file.content.includes('First line\n<script>alert(""x"")</script>'));
});

test('Netscape HTML escapes content and includes tag metadata without active unsafe links', () => {
  const file = serializeBookmarks([bookmark, { ...bookmark, url: 'javascript:alert(1)' }], 'html');
  assert.ok(file.content.includes('TAGS="research,work"'));
  assert.ok(file.content.includes('ADD_DATE="1790856000"'));
  assert.ok(file.content.includes('&lt;script&gt;'));
  assert.ok(file.content.includes('&amp;b=&quot;2&quot;'));
  assert.ok(!file.content.includes('javascript:'));
  assert.equal((file.content.match(/<DT><A /g) || []).length, 1);
});

test('empty libraries still produce valid exports', () => {
  assert.deepEqual(JSON.parse(serializeBookmarks([], 'json').content).bookmarks, []);
  assert.ok(serializeBookmarks([], 'csv').content.includes('title,url,description,tags'));
  assert.ok(serializeBookmarks([], 'html').content.includes('<DL><p>'));
});

// --- Notes (issue #60): exported in every format and read back by Tagstash's own importers ---

const noted = {
  ...bookmark,
  title: 'Notes',
  description: '- a description that looks like a list',
  note: "- first item\n- second, with \"quotes\" and <b>tags</b>\n\n'=not a formula\n  indented",
};

test('JSON and CSV exports carry the note and read it back exactly', () => {
  const json = JSON.parse(serializeBookmarks([noted, { ...bookmark, note: null }], 'json').content);
  assert.equal(json.bookmarks[0].note, noted.note);
  assert.equal(json.bookmarks[1].note, '');
  assert.deepEqual(parseTagstashJSON(JSON.stringify(json)).map((b) => b.note), [noted.note, undefined]);

  const csv = serializeBookmarks([noted, { ...bookmark, note: null }], 'csv').content;
  // Formula guard on export (also for a note starting with "-"); removed again on import.
  assert.ok(csv.includes(`"'- first item`));
  const [first, second] = parseBookmarksCSV(csv);
  assert.equal(first.note, noted.note);
  assert.equal(first.description, noted.description);
  assert.equal(first.title, 'Notes');
  assert.deepEqual(first.tags, ['research', 'work']);
  assert.equal(second.note, undefined);
  assert.equal(second.title, bookmark.title);
  assert.equal(second.description, bookmark.description);
});

test('the CSV formula guard is reversible, including text that already starts with an apostrophe', () => {
  for (const text of ['=SUM(A1)', "'=SUM(A1)", "''-x", '- list', '\ttab', "'plain", 'plain', '']) {
    const csv = serializeBookmarks([{ title: 'T', url: 'https://e.example/', note: text || null, description: text }], 'csv').content;
    const [row] = parseBookmarksCSV(csv);
    assert.equal(row.description ?? '', text.trim(), JSON.stringify(text));
    assert.equal(row.note ?? '', text.trim() ? text : '', JSON.stringify(text));
  }
  assert.equal(unescapeCsvField("'=1"), '=1');
  assert.equal(unescapeCsvField("'plain"), "'plain");
});

test('older Tagstash CSVs and Raindrop files keep reading `note` as the description', () => {
  const legacy = '﻿title,url,note,tags,created_at\r\n"Old","https://old.example/","the ""description""","a, b","2026-01-01"';
  assert.deepEqual(parseBookmarksCSV(legacy), [{ title: 'Old', url: 'https://old.example/', description: 'the "description"', tags: ['a', 'b'] }]);
  const raindrop = 'id,title,note,excerpt,url,folder,tags\n1,R,,An excerpt,https://r.example/,Reading,x';
  assert.deepEqual(parseBookmarksCSV(raindrop), [{ title: 'R', url: 'https://r.example/', description: 'An excerpt', tags: ['x', 'reading'] }]);
  assert.equal(parseBookmarksCSV('name,link\nx,y'), null);
});

test('Netscape HTML keeps the description in <DD> and the note in an escaped NOTE attribute', () => {
  const html = serializeBookmarks([noted, { ...bookmark, note: '' }], 'html').content;
  const [first, second] = html.split('<DT>').slice(1);
  assert.match(first, /<DD>- a description that looks like a list/);
  assert.ok(first.includes(' NOTE="- first item&#10;- second, with &quot;quotes&quot; and &lt;b&gt;tags&lt;/b&gt;&#10;&#10;&#39;=not a formula&#10;  indented"'));
  // The attribute stays on one line, so the file's structure is unchanged.
  assert.ok(!/NOTE="[^"]*\n/.test(html));
  assert.ok(!second.includes('NOTE='));
});

test('Tagstash JSON import ignores rows it cannot use and files that are not exports', () => {
  assert.equal(parseTagstashJSON('not json'), null);
  assert.equal(parseTagstashJSON('{"items":[]}'), null);
  assert.deepEqual(parseTagstashJSON(JSON.stringify({ bookmarks: [null, { title: '', url: 'x' }, { title: 'A', url: 'https://a.example/', tags: ['Two Words', { name: 'obj' }, 3, 'two-words'], note: 5 }] })), [
    { title: 'A', url: 'https://a.example/', description: null, tags: ['two-words', 'obj'] },
  ]);
});

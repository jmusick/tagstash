import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseBookmarksHTML,
  parsePocketCSV,
  parsePinboardJSON,
  parseInstapaperCSV,
  looksLikeBookmarkHtml,
} from '../src/utils/bookmarkImport.js';

// --- Pocket ---

test('Pocket CSV: `|` separated tags, status ignored, missing title falls back to the URL', () => {
  const csv = [
    'title,url,time_added,tags,status',
    '"Hello, World",https://a.example/post,1700000000,rust|Web Dev|,unread',
    ',https://b.example/,1700000001,,archive',
    'Not web,ftp://c.example/file,1700000002,x,unread',
    '',
  ].join('\r\n');
  assert.deepEqual(parsePocketCSV(csv), [
    { title: 'Hello, World', url: 'https://a.example/post', description: null, tags: ['rust', 'web-dev'] },
    { title: 'https://b.example/', url: 'https://b.example/', description: null, tags: [] },
  ]);
});

test('Pocket CSV rejects other CSV files', () => {
  assert.equal(parsePocketCSV('URL,Title,Selection,Folder,Timestamp\nhttps://x.example,X,,Unread,1'), null);
  assert.equal(parsePocketCSV('name,link\nx,y'), null);
});

// --- Pinboard ---

test('Pinboard JSON: description is the title, extended the description, tags split on spaces', () => {
  const json = JSON.stringify([
    { href: 'https://a.example/', description: 'Title A', extended: 'About A', tags: 'Dev  tools\tcss', time: '2024-01-01T00:00:00Z', shared: 'yes', toread: 'yes' },
    { href: 'https://b.example/', description: '', extended: '', tags: '', time: '2024-01-02T00:00:00Z', shared: 'no', toread: 'no' },
    { href: 'javascript:alert(1)', description: 'bad', tags: 'x' },
    { description: 'no href' },
  ]);
  assert.deepEqual(parsePinboardJSON(json), [
    { title: 'Title A', url: 'https://a.example/', description: 'About A', tags: ['dev', 'tools', 'css'] },
    { title: 'https://b.example/', url: 'https://b.example/', description: null, tags: [] },
  ]);
});

test('Pinboard JSON rejects files that are not post lists', () => {
  assert.equal(parsePinboardJSON('not json'), null);
  assert.equal(parsePinboardJSON('{"bookmarks":[]}'), null);
  assert.equal(parsePinboardJSON('[{"title":"x","url":"https://x.example"}]'), null);
  assert.deepEqual(parsePinboardJSON('[]'), []);
});

// --- Instapaper ---

test('Instapaper CSV: Selection is the description, custom folders and a JSON-array Tags column become tags', () => {
  const csv = [
    'URL,Title,Selection,Folder,Timestamp,Tags',
    'https://a.example/,Article A,"A quote, with comma",Unread,1700000000,"[""Long Reads"",""tech""]"',
    'https://b.example/,Article B,,Recipes,1700000001,[]',
    'https://c.example/,Article C,,Archive,1700000002,"[""x"",""tech""]"',
    'https://d.example/,Article D,,Starred,1700000003,"one, Two"',
    'https://e.example/,Article E,,Unread,1700000004,"[not json"',
  ].join('\n');
  assert.deepEqual(parseInstapaperCSV(csv), [
    { title: 'Article A', url: 'https://a.example/', description: 'A quote, with comma', tags: ['long-reads', 'tech'] },
    { title: 'Article B', url: 'https://b.example/', description: null, tags: ['recipes'] },
    { title: 'Article C', url: 'https://c.example/', description: null, tags: ['x', 'tech'] },
    { title: 'Article D', url: 'https://d.example/', description: null, tags: ['one', 'two'] },
    { title: 'Article E', url: 'https://e.example/', description: null, tags: ['[not-json'] },
  ]);
});

test('Instapaper CSV without a Tags column (older exports); other CSVs are rejected', () => {
  const csv = 'URL,Title,Selection,Folder,Timestamp\nhttps://a.example/,A,,Reading list,1';
  assert.deepEqual(parseInstapaperCSV(csv), [{ title: 'A', url: 'https://a.example/', description: null, tags: ['reading-list'] }]);
  assert.equal(parseInstapaperCSV('title,url,tags\nx,https://x.example,a'), null);
});

// --- Netscape HTML ---

test('Firefox/Chrome-style HTML: folders become tags, root folders are skipped', () => {
  const html = `<!DOCTYPE NETSCAPE-Bookmark-file-1>
<META HTTP-EQUIV="Content-Type" CONTENT="text/html; charset=UTF-8">
<TITLE>Bookmarks</TITLE>
<H1>Bookmarks Menu</H1>
<DL><p>
  <DT><H3 ADD_DATE="1">Bookmarks Toolbar</H3>
  <DL><p>
    <DT><A HREF="https://a.example/" ADD_DATE="1">Site A</A>
    <DT><H3>Dev Stuff!</H3>
    <DL><p>
      <DT><A HREF="https://b.example/">Tom &amp; Jerry</A>
    </DL><p>
  </DL><p>
  <DT><A HREF="https://c.example/">Top level</A>
  <DT><A HREF="javascript:void(0)">Bookmarklet</A>
</DL><p>`;
  assert.deepEqual(parseBookmarksHTML(html), [
    { title: 'Site A', url: 'https://a.example/', description: null, tags: [] },
    { title: 'Tom & Jerry', url: 'https://b.example/', description: null, tags: ['dev-stuff'] },
    { title: 'Top level', url: 'https://c.example/', description: null, tags: [] },
  ]);
});

test('Pinboard-style HTML: TAGS attribute, unclosed <A>/<DT>, <DD> description', () => {
  const html = `<!DOCTYPE NETSCAPE-Bookmark-file-1>
<DL><p>
<DT><A HREF="https://a.example/" TAGS="Dev Tools,css" ADD_DATE="1">Site A
<DD>Line one<br>line two &amp; more
<DT><A HREF="https://b.example/" TAGS="x">Site B</A>
<DT><A HREF="https://c.example/">Site C
</DL><p>`;
  assert.deepEqual(parseBookmarksHTML(html), [
    { title: 'Site A', url: 'https://a.example/', description: 'Line one\nline two & more', tags: ['dev-tools', 'css'] },
    { title: 'Site B', url: 'https://b.example/', description: null, tags: ['x'] },
    { title: 'Site C', url: 'https://c.example/', description: null, tags: [] },
  ]);
});

test('Pocket ril_export.html style list works, and TAGS merge with folder tags without duplicates', () => {
  const pocket = `<!DOCTYPE html><html><head><meta charset="UTF-8"><title>Pocket Export</title></head><body>
<h1>Unread</h1><ul>
<li><a href="https://a.example/" time_added="1700000000" tags="news,tech">Story A</a></li>
<li><a href="https://b.example/" time_added="1700000001" tags="">Story B</a></li>
</ul><h1>Read Archive</h1><ul>
<li><a href="https://c.example/" time_added="1700000002" tags="tech">Story C</a></li>
</ul></body></html>`;
  assert.equal(looksLikeBookmarkHtml(pocket), true);
  assert.deepEqual(parseBookmarksHTML(pocket).map((b) => [b.title, b.url, b.tags]), [
    ['Story A', 'https://a.example/', ['news', 'tech']],
    ['Story B', 'https://b.example/', []],
    ['Story C', 'https://c.example/', ['tech']],
  ]);

  const folderAndTags = '<DL><DT><H3>Tech</H3><DL><DT><A HREF="https://a.example/" TAGS="tech, News">A</A></DL></DL>';
  assert.deepEqual(parseBookmarksHTML(folderAndTags)[0].tags, ['tech', 'news']);
});

test('HTML without the Netscape doctype is accepted when it has <DL> and links; other HTML is not', () => {
  const safari = '<html><body><dl><dt><h3>Reading</h3><dl><dt><a href="https://a.example/">A</a></dl></dl></body></html>';
  assert.equal(looksLikeBookmarkHtml(safari), true);
  assert.deepEqual(parseBookmarksHTML(safari), [{ title: 'A', url: 'https://a.example/', description: null, tags: ['reading'] }]);

  assert.equal(parseBookmarksHTML('<html><body><a href="https://a.example/">just a page</a></body></html>'), null);
  assert.equal(parseBookmarksHTML('plain text'), null);
});

test('Tagstash HTML export attributes: NOTE with newline entities, DD description, scripts ignored', () => {
  const html = `<!DOCTYPE NETSCAPE-Bookmark-file-1>
<script>var x = "<A HREF='https://evil.example/'>evil</A>";</script>
<DL><p>
<DT><A HREF="https://a.example/" TAGS="a" NOTE="first&#10;second">A</A>
<DD>desc
</DL>`;
  assert.deepEqual(parseBookmarksHTML(html), [
    { title: 'A', url: 'https://a.example/', description: 'desc', tags: ['a'], note: 'first\nsecond' },
  ]);
});

test('named HTML entities in titles and descriptions are decoded', () => {
  const html = '<DL><DT><A HREF="https://a.example/" TAGS="caf&eacute;">Caf&eacute; &mdash; &ldquo;Menu&rdquo;&hellip; &copy; 2024 &amp;lt; &unknown; &#x263A; &#9731;</A><DD>It&rsquo;s &ndash; &euro;5 &trade; &bull; &Uuml;ber &yuml;&nbsp;x</DL>';
  const [bookmark] = parseBookmarksHTML(html);
  assert.equal(bookmark.title, 'Café — “Menu”… © 2024 &lt; &unknown; ☺ ☃');
  assert.equal(bookmark.description, 'It’s – €5 ™ • Über ÿ\u00a0x');
  assert.deepEqual(bookmark.tags, ['café']);
});

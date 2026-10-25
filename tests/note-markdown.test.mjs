import test from 'node:test';
import assert from 'node:assert/strict';
import { renderToStaticMarkup } from 'react-dom/server';
import { renderNoteMarkdown, isSafeNoteHref } from '../src/utils/noteMarkdown.js';

// Notes are owner-written Markdown rendered on the owner's own cards (issue #60). The renderer
// emits React elements only, and every element passes an allowlist: no raw HTML, no attributes
// beyond href/start/our classes, only http(s)/mailto links with a fixed rel, no images, no form
// controls, no style attributes (CSP style-src 'self'), no headings in the page outline.

const render = (text, linkProps) => renderToStaticMarkup(renderNoteMarkdown(text, { linkProps }));
const REL = 'rel="noopener noreferrer ugc nofollow"';

test('ordinary Markdown renders as the expected elements', () => {
  assert.equal(render('Some **bold**, _italic_, ~~gone~~ and `code`.'), '<p>Some <strong>bold</strong>, <em>italic</em>, <del>gone</del> and <code>code</code>.</p>');
  assert.equal(render('- a\n- b\n\n3. c\n4. d'), '<ul><li>a</li><li>b</li></ul><ol start="3"><li>c</li><li>d</li></ol>');
  assert.equal(render('> quoted\n\n---'), '<blockquote><p>quoted</p></blockquote><hr/>');
  assert.equal(render('```\nconst a = 1;\n```'), '<pre class="note-code-block"><code>const a = 1;</code></pre>');
  assert.equal(render(''), '');
});

test('raw HTML is shown as text, never parsed into elements or attributes', () => {
  for (const hostile of [
    '<script>alert(1)</script>',
    '<img src=x onerror=alert(1)>',
    '<div style="color:red" onclick="x()">x</div>',
    '<iframe src="https://evil.example"></iframe>',
    '<a href="javascript:alert(1)">x</a>',
    '<style>body{display:none}</style>',
  ]) {
    const html = render(hostile);
    // Only the paragraph wrapper is markup, plus a GFM autolink for a bare https:// URL (as in the
    // iframe case); everything else from the input is escaped text.
    const rest = html.replace(/^<p>|<\/p>$/g, '').replace(new RegExp(`<a href="https://[^"]*" ${REL}>|</a>`, 'g'), '');
    assert.equal(rest.includes('<'), false, html);
    assert.ok(html.includes('&lt;'), html);
  }
});

test('links are only http(s) or mailto, always with the fixed rel, and honor the link-target props', () => {
  const html = render('[ok](https://example.com/x) [mail](mailto:a@example.com) [js](javascript:alert(1)) [JS](JaVaScRiPt:alert(1)) [data](data:text/html,x) [rel](/settings) [hash](#top) <https://auto.example>', { target: '_blank', rel: 'opener' });
  assert.ok(html.includes(`<a target="_blank" href="https://example.com/x" ${REL}>ok</a>`), html);
  assert.ok(html.includes(`href="mailto:a@example.com" ${REL}>mail</a>`));
  assert.ok(html.includes(`href="https://auto.example" ${REL}`));
  assert.equal((html.match(/<a /g) || []).length, 3, html);
  for (const text of ['js', 'JS', 'data', 'rel', 'hash']) assert.ok(html.includes(` ${text}`), text);
  assert.ok(!/javascript|data:|href="\/|href="#/i.test(html));
  // Same-tab preference: no target, rel still set.
  assert.equal(render('[x](https://example.com)', {}), `<p><a href="https://example.com" ${REL}>x</a></p>`);
});

test('images never load; headings, task boxes, tables and footnotes stay inert', () => {
  assert.equal(render('![chart](https://img.example/a.png)'), `<p><a href="https://img.example/a.png" ${REL}>Image: chart</a></p>`);
  assert.equal(render('![pixel](data:image/png;base64,AAAA)'), '<p>[pixel]</p>');
  assert.equal(render('# Big\n## Smaller'), '<p class="note-heading">Big</p><p class="note-heading">Smaller</p>');
  const tasks = render('- [x] done\n- [ ] todo');
  assert.ok(!tasks.includes('<input'), tasks);
  assert.match(tasks, /\[x\]/);
  const table = render('| a | b |\n|:--|--:|\n| 1 | 2 |');
  assert.equal(table, '<table><thead><tr><th>a</th><th>b</th></tr></thead><tbody><tr><td>1</td><td>2</td></tr></tbody></table>');
  const footnote = render('text[^1]\n\n[^1]: the footnote');
  assert.ok(!/\sid=|href=/.test(footnote), footnote);
});

test('isSafeNoteHref accepts only absolute http(s) and non-empty mailto', () => {
  for (const ok of ['https://a.example', 'http://a.example/x?y#z', 'mailto:a@b.example', ' https://a.example ']) assert.equal(isSafeNoteHref(ok), true, ok);
  for (const bad of ['javascript:alert(1)', 'vbscript:x', 'data:text/html,x', '/relative', '#x', 'mailto:', 'ftp://a.example', '', null, 42]) assert.equal(isSafeNoteHref(bad), false, String(bad));
});

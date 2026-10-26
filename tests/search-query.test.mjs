import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { parseSearchQuery, matchesSearchQuery, parseCreatedRange, parseDatePeriod, isEmptySearchQuery } from '../src/utils/searchQuery.js';

// Local wall-clock time -> the ISO string an import would carry, so these tests hold in any zone.
const localIso = (y, m, d, h = 12, min = 0) => new Date(y, m - 1, d, h, min).toISOString();

const bookmarks = [
  {
    id: 1, title: 'Sourdough starter guide', url: 'https://bread.example.com/sourdough',
    description: 'Feeding schedule & tips', note: 'Try the rye flour next time',
    tags: [{ id: 1, name: 'Baking' }, { id: 2, name: 'recipes' }], created_at: localIso(2026, 10, 5),
  },
  {
    id: 2, title: 'React hooks in depth', url: 'https://dev.example.org/react-hooks',
    description: 'useMemo and useEffect explained', note: null,
    tags: [{ id: 3, name: 'react' }, { id: 4, name: 'web design' }], created_at: localIso(2026, 1, 1, 0, 30),
  },
  {
    id: 3, title: 'Weekend hiking trails', url: 'https://outdoors.example.net/trails?type=easy',
    description: 'Easy loops near the lake',
    tags: [], created_at: localIso(2025, 12, 31, 23, 59),
  },
  {
    id: 4, title: 'Bread & butter pickles', url: 'https://pickles.example.com/',
    description: '', note: '  ',
    tags: [{ id: 2, name: 'recipes' }], created_at: localIso(2026, 3, 31, 23, 0),
  },
  { id: 5, title: 'No date here', url: 'https://nodate.example.com/', tags: [{ id: 5, name: 'misc' }] },
];

const search = (text, list = bookmarks) => {
  const query = parseSearchQuery(text);
  return list.filter((bookmark) => matchesSearchQuery(bookmark, query)).map((b) => b.id);
};

test('an empty or blank query matches everything', () => {
  for (const text of ['', '   ', undefined, null, 42]) {
    assert.equal(isEmptySearchQuery(parseSearchQuery(text)), true, String(text));
    assert.deepEqual(search(text), [1, 2, 3, 4, 5]);
  }
});

test('plain words must all match, anywhere, case-insensitively', () => {
  assert.deepEqual(search('bread'), [1, 4]);
  assert.deepEqual(search('BREAD pickles'), [4]);
  assert.deepEqual(search('bread &'), [1, 4]);
  assert.deepEqual(search('rye'), [1], 'searches the note');
  assert.deepEqual(search('recipes'), [1, 4], 'searches tag names');
  assert.deepEqual(search('example.org'), [2], 'searches the link');
  assert.deepEqual(search('usememo useeffect'), [2], 'searches the description');
  assert.deepEqual(search('react   trails'), []);
});

test('titles and descriptions are searched with HTML entities decoded, like the cards', () => {
  // decodeHtmlEntities needs a DOM; stand in a minimal textarea for &amp; only.
  globalThis.document = {
    createElement: () => {
      let value = '';
      return { set innerHTML(html) { value = html.replaceAll('&amp;', '&'); }, get value() { return value; } };
    },
  };
  try {
    const list = [{ id: 1, title: 'Salt &amp; pepper', description: 'Cats &amp; dogs', url: 'https://a.example/?x=1&amp;y=2', tags: [] }];
    assert.deepEqual(search('"salt & pepper"', list), [1]);
    assert.deepEqual(search('title:"salt & pepper"', list), [1]);
    assert.deepEqual(search('"cats & dogs"', list), [1]);
    assert.deepEqual(search('title:amp', list), []);
    assert.deepEqual(search('link:&amp;', list), [1], 'links are not decoded, as before');
  } finally {
    delete globalThis.document;
  }
});

test('a quoted phrase matches as written within one field', () => {
  assert.deepEqual(search('"starter guide"'), [1]);
  assert.deepEqual(search('"guide starter"'), []);
  assert.deepEqual(search('"web design"'), [2], 'a tag name with a space');
  assert.deepEqual(search('"  WEB   design "'), [2], 'whitespace is collapsed');
  // Title end + link start would only match if fields ran together.
  assert.deepEqual(search('"guide https"'), []);
  assert.deepEqual(parseSearchQuery('"exact phrase" word').terms, [
    { type: 'text', negate: false, value: 'exact phrase' },
    { type: 'text', negate: false, value: 'word' },
  ]);
});

test('-word and -"phrase" exclude', () => {
  assert.deepEqual(search('-bread'), [2, 3, 5]);
  assert.deepEqual(search('recipes -pickles'), [1]);
  assert.deepEqual(search('-"starter guide"'), [2, 3, 4, 5]);
  assert.deepEqual(search('-"web design" -misc'), [1, 3, 4]);
});

test('#tag needs that exact tag name, case-insensitive; -#tag excludes it', () => {
  assert.deepEqual(search('#recipes'), [1, 4]);
  assert.deepEqual(search('#RECIPES'), [1, 4]);
  assert.deepEqual(search('#recipe'), [], 'whole names only');
  assert.deepEqual(search('#baking #recipes'), [1]);
  assert.deepEqual(search('-#recipes'), [2, 3, 5]);
  assert.deepEqual(search('#recipes -#baking'), [4]);
  assert.deepEqual(search('#"web design"'), [2]);
  assert.deepEqual(search('#web'), []);
});

test('match:OR combines the positive terms with OR; exclusions still exclude', () => {
  assert.deepEqual(search('react hiking'), []);
  assert.deepEqual(search('react hiking match:OR'), [2, 3]);
  assert.deepEqual(search('match:or react hiking'), [2, 3]);
  assert.deepEqual(search('match:Or #baking #misc'), [1, 5]);
  assert.deepEqual(search('match:OR react hiking -trails'), [2]);
  assert.deepEqual(search('match:OR -#recipes'), [2, 3, 5], 'only exclusions');
  assert.deepEqual(search('match:OR'), [1, 2, 3, 4, 5]);
  assert.equal(parseSearchQuery('a match:OR b match:and').mode, 'and', 'the last one wins');
  assert.equal(parseSearchQuery('a b').mode, 'and');
});

test('title:, link: and note: search only that field and accept quoted values', () => {
  assert.deepEqual(search('title:bread'), [4]);
  assert.deepEqual(search('Title:"bread & butter"'), [4]);
  assert.deepEqual(search('title:"starter guide"'), [1]);
  assert.deepEqual(search('link:bread'), [1]);
  assert.deepEqual(search('link:https://dev.'), [2]);
  assert.deepEqual(search('link:type=easy'), [3]);
  assert.deepEqual(search('note:rye'), [1]);
  assert.deepEqual(search('note:"rye flour"'), [1]);
  assert.deepEqual(search('-title:bread'), [1, 2, 3, 5]);
  assert.deepEqual(search('-note:rye'), [2, 3, 4, 5]);
  assert.deepEqual(search('match:or title:hiking note:rye'), [1, 3]);
});

test('note: matches nothing on public bookmarks, which carry no note', () => {
  const publicList = bookmarks.map(({ note: _note, ...rest }) => rest);
  assert.deepEqual(search('note:rye', publicList), []);
  assert.deepEqual(search('rye', publicList), []);
  assert.deepEqual(search('-note:rye', publicList), [1, 2, 3, 4, 5]);
});

test('unknown keys, including type:, are plain words', () => {
  assert.deepEqual(parseSearchQuery('type:pdf').terms, [{ type: 'text', negate: false, value: 'type:pdf' }]);
  assert.deepEqual(search('type:pdf'), []);
  assert.deepEqual(search('type=easy'), [3]);
  assert.deepEqual(search('https://bread.example.com'), [1], 'URLs are not operators');
  assert.deepEqual(search('-https://bread.example.com'), [2, 3, 4, 5]);
  assert.deepEqual(search('match:maybe'), []);
  assert.deepEqual(parseSearchQuery('match:maybe').mode, 'and');
});

test('created: matches a local year, month or day', () => {
  assert.deepEqual(search('created:2026'), [1, 2, 4]);
  assert.deepEqual(search('created:2025'), [3]);
  assert.deepEqual(search('created:2026-10'), [1]);
  assert.deepEqual(search('created:2026-1'), [2], 'single-digit months');
  assert.deepEqual(search('created:2026-10-05'), [1]);
  assert.deepEqual(search('created:2026-10-5'), [1]);
  assert.deepEqual(search('created:2026-10-06'), []);
  assert.deepEqual(search('created:2026-03-31'), [4], 'late in the local day');
  assert.deepEqual(search('-created:2026'), [3, 5], 'a missing date is never inside a period');
});

test('created: comparisons cover the whole year, month or day', () => {
  assert.deepEqual(search('created:>2026-01-01'), [1, 4]);
  assert.deepEqual(search('created:>=2026-01-01'), [1, 2, 4]);
  assert.deepEqual(search('created:<2026-01-01'), [3]);
  assert.deepEqual(search('created:<=2026-01-01'), [2, 3]);
  assert.deepEqual(search('created:>2025'), [1, 2, 4]);
  assert.deepEqual(search('created:<2026-03'), [2, 3]);
  assert.deepEqual(search('created:<=2026-03'), [2, 3, 4]);
  assert.deepEqual(search('created:>=2026-04'), [1]);
});

test('created: ranges are inclusive at each end\'s granularity', () => {
  assert.deepEqual(search('created:2026-01..2026-03'), [2, 4]);
  assert.deepEqual(search('created:2025-12-31..2026-01-01'), [2, 3]);
  assert.deepEqual(search('created:2025..2026-01'), [2, 3]);
  assert.deepEqual(search('created:2026-02..2026-10-04'), [4]);
  assert.deepEqual(search('created:2026-03..2026'), [1, 4]);
  assert.deepEqual(search('created:2026-03..2026-01'), [2, 4], 'a reversed range is flipped');
  assert.deepEqual(search('created:2026-04..'), [1], 'open end');
  assert.deepEqual(search('created:..2025'), [3], 'open start');
  assert.deepEqual(search('match:or created:2025 #baking'), [1, 3]);
  assert.deepEqual(search('created:2026 -created:2026-01..2026-03'), [1]);
});

test('date periods are real calendar dates', () => {
  const day = parseDatePeriod('2024-02-29');
  assert.equal(day.label, '2024-02-29');
  assert.equal(day.start, new Date(2024, 1, 29).getTime());
  assert.equal(day.end, new Date(2024, 2, 1).getTime());
  assert.equal(parseDatePeriod('2026-12').end, new Date(2027, 0, 1).getTime());
  for (const bad of ['2026-02-29', '2026-13', '2026-00', '2026-04-31', '2026-1-0', '26', '20261', '2026-', '2026-10-05T00', 'abcd', '']) {
    assert.equal(parseDatePeriod(bad), null, bad);
  }
  // Years below 100 are not mapped to the 1900s.
  assert.equal(new Date(parseDatePeriod('0050').start).getFullYear(), 50);
  for (const bad of ['', '..', '>', '>=', '<', '2026...2027', '2026..bad', 'bad..2026', '>2026..2027', '=2026', '2026-10-05..2026-02-30']) {
    assert.equal(parseCreatedRange(bad), null, bad);
  }
});

test('a bad created: value is searched as plain text, never throws', () => {
  assert.deepEqual(parseSearchQuery('created:2026-13').terms, [{ type: 'text', negate: false, value: 'created:2026-13' }]);
  assert.deepEqual(parseSearchQuery('-created:soon').terms, [{ type: 'text', negate: true, value: 'created:soon' }]);
  assert.deepEqual(search('created:yesterday'), []);
  assert.deepEqual(search('-created:yesterday'), [1, 2, 3, 4, 5]);
  assert.deepEqual(search('created:2026-02-30'), []);
});

test('malformed input degrades to plain words instead of hiding everything', () => {
  // An unmatched quote is ignored.
  assert.deepEqual(search('"starter guide'), [1]);
  assert.deepEqual(search('sourdough "'), [1]);
  assert.deepEqual(search('title:"bread &'), [4]);
  assert.deepEqual(search('#"web design'), []);
  // Empty operators are skipped while they are being typed.
  for (const text of ['-', '#', '-#', '""', '-""', '"', 'title:', 'link:', 'note:', 'created:', 'match:', '- # -# ""']) {
    assert.deepEqual(parseSearchQuery(text).terms, [], text);
    assert.deepEqual(search(text), [1, 2, 3, 4, 5], text);
  }
  assert.deepEqual(search('pickles -'), [4]);
  assert.deepEqual(search('pickles # title:'), [4]);
  // Quotes inside a word stay literal.
  assert.deepEqual(parseSearchQuery('5"x7"').terms, [{ type: 'text', negate: false, value: '5"x7"' }]);
  // Strange bookmark shapes do not throw either.
  const odd = [{ id: 9 }, { id: 10, title: null, url: 7, tags: [{}, { name: null }], note: 5, created_at: 'bad' }];
  for (const text of ['x', '#x', 'title:x', 'link:x', 'note:x', 'created:2026', '-x match:or']) {
    assert.doesNotThrow(() => search(text, odd), text);
  }
  assert.deepEqual(search('-x -#x -note:x -created:2026', odd), [9, 10]);
});

// Same local-date interpretation as the month filter: D1's offset-free UTC timestamps
// land in the visitor's local day, so UTC midnight can be the previous local year.
test('created: uses the same local dates as the month filter across time zones', () => {
  const moduleUrl = new URL('../src/utils/searchQuery.js', import.meta.url).href;
  const filtersUrl = new URL('../src/utils/bookmarkFilters.js', import.meta.url).href;
  const code = `import { parseSearchQuery, matchesSearchQuery } from ${JSON.stringify(moduleUrl)};
    import { getCreatedMonth } from ${JSON.stringify(filtersUrl)};
    const list = ['2026-01-01 00:30:00', '2026-01-01T05:00:00Z', '2025-12-31T23:30:00-06:00', '2026-03-08T07:00:00Z']
      .map((created_at, id) => ({ id, created_at }));
    const run = (text) => { const q = parseSearchQuery(text); return list.filter((b) => matchesSearchQuery(b, q)).map((b) => b.id); };
    console.log(JSON.stringify({
      months: list.map((b) => getCreatedMonth(b.created_at)),
      y2025: run('created:2025'), m202512: run('created:2025-12'), d1231: run('created:2025-12-31'),
      jan1: run('created:2026-01-01'), after: run('created:>2025-12-31'), dst: run('created:2026-03-08'),
    }));`;
  for (const [zone, expected] of [
    ['America/New_York', { months: ['2025-12', '2026-01', '2026-01', '2026-03'], y2025: [0], m202512: [0], d1231: [0], jan1: [1, 2], after: [1, 2, 3], dst: [3] }],
    ['Asia/Kolkata', { months: ['2026-01', '2026-01', '2026-01', '2026-03'], y2025: [], m202512: [], d1231: [], jan1: [0, 1, 2], after: [0, 1, 2, 3], dst: [3] }],
  ]) {
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', code], {
      env: { ...process.env, TZ: zone }, encoding: 'utf8',
    });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), expected, zone);
  }
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { hasNoTags, countUntagged, getBookmarkDomain, countDomains } from '../src/utils/bookmarkFilters.js';

test('hasNoTags is true for an empty, missing or null tags value', () => {
  assert.equal(hasNoTags({ id: 1, tags: [] }), true);
  assert.equal(hasNoTags({ id: 2 }), true);
  assert.equal(hasNoTags({ id: 3, tags: null }), true);
  assert.equal(hasNoTags(undefined), true);
});

test('hasNoTags is false once a bookmark has any tag', () => {
  assert.equal(hasNoTags({ id: 1, tags: [{ id: 7, name: 'reading' }] }), false);
});

test('countUntagged counts only bookmarks with zero tags', () => {
  const bookmarks = [
    { id: 1, tags: [{ id: 1, name: 'a' }] },
    { id: 2, tags: [] },
    { id: 3 },
    { id: 4, tags: [{ id: 2, name: 'b' }, { id: 3, name: 'c' }] },
  ];
  assert.equal(countUntagged(bookmarks), 2);
  assert.equal(countUntagged([]), 0);
  assert.equal(countUntagged(undefined), 0);
});

test('domains group subdomains and ignore www, case, ports and paths', () => {
  for (const url of ['https://www.Example.COM/a?q=1', 'http://example.com:8080/b', 'https://example.com/']) {
    assert.equal(getBookmarkDomain(url), 'example.com');
  }
  assert.equal(getBookmarkDomain('https://docs.example.com/a'), 'example.com');
  assert.equal(getBookmarkDomain('https://www.reddit.com/'), 'reddit.com');
  assert.equal(getBookmarkDomain('https://old.reddit.com:8080/r/test'), 'reddit.com');
  assert.equal(getBookmarkDomain('https://deep.docs.example.com/a'), 'example.com');
  assert.equal(getBookmarkDomain('http://127.0.0.1:8080/'), '127.0.0.1');
  assert.equal(getBookmarkDomain('http://[::1]:8080/'), '[::1]');
});

test('multi-part suffixes keep the registrable label when grouping subdomains', () => {
  for (const suffix of ['co.uk', 'org.uk', 'co.jp', 'co.nz', 'co.in', 'com.au', 'com.br', 'com.cn', 'co.za', 'co.kr']) {
    for (const prefix of ['', 'www.', 'old.', 'deep.docs.']) {
      assert.equal(getBookmarkDomain(`https://${prefix}reddit.${suffix}:8443/path`), `reddit.${suffix}`);
    }
  }
  assert.equal(getBookmarkDomain('https://news.example.test/'), 'example.test');
});

test('IDN Unicode and ASCII URLs share one canonical domain', () => {
  assert.equal(getBookmarkDomain('https://www.bücher.de/a'), 'xn--bcher-kva.de');
  assert.equal(getBookmarkDomain('https://xn--bcher-kva.de/b'), 'xn--bcher-kva.de');
  assert.equal(getBookmarkDomain('https://old.bücher.de:8080/c'), 'xn--bcher-kva.de');
  assert.equal(getBookmarkDomain('https://docs.xn--bcher-kva.de/d'), 'xn--bcher-kva.de');
});

test('invalid or non-web URLs have no domain and are omitted from counts', () => {
  for (const url of [null, undefined, 123, '', 'bad url', 'example.com', 'https://', 'https://example.com:bad', 'mailto:a@example.com', 'javascript:alert(1)', 'file:///tmp/bookmark']) {
    assert.equal(getBookmarkDomain(url), null, String(url));
  }
  assert.deepEqual([...countDomains([
    { url: 'https://www.example.com/a' }, { url: 'http://example.com:8080/b' },
    { url: 'https://docs.example.com/' }, { url: 'bad url' }, {},
    { url: 'https://old.reddit.co.uk/' }, { url: 'https://www.reddit.co.uk:8443/' },
    { url: 'https://docs.bücher.de/' }, { url: 'http://xn--bcher-kva.de:8080/' },
  ])], [['example.com', 3], ['reddit.co.uk', 2], ['xn--bcher-kva.de', 2]]);
});

// Separate processes pin real local time zones without changing the test runner's
// zone (or relying on Windows picking up process.env.TZ changes after startup).
function monthsInZone(timeZone, values) {
  const moduleUrl = new URL('../src/utils/bookmarkFilters.js', import.meta.url).href;
  const displayModuleUrl = new URL('../src/utils/bookmarkDisplay.js', import.meta.url).href;
  const code = `import { getCreatedMonth, countCreatedMonths } from ${JSON.stringify(moduleUrl)};
    import { formatSavedDate } from ${JSON.stringify(displayModuleUrl)};
    const values = ${JSON.stringify(values)};
    console.log(JSON.stringify({
      keys: values.map(getCreatedMonth),
      displayedDates: values.map(formatSavedDate),
      buckets: countCreatedMonths(values.map(created_at => ({ created_at })))
    }));`;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', code], {
    env: { ...process.env, TZ: timeZone, LANG: 'en_US.UTF-8' }, encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

test('local month boundaries handle UTC year rollover, D1 UTC and explicit offsets', () => {
  const { keys, buckets } = monthsInZone('America/New_York', [
    '2026-01-01T00:30:00Z', '2026-01-01 00:30:00', '2026-01-01T00:30:00',
    '2026-01-01T05:00:00Z', '2025-12-31T23:30:00-06:00',
    '2026-03-01T04:59:59.999Z', '2026-03-01T05:00:00Z',
    null, '', 'invalid', 0,
  ]);
  assert.deepEqual(keys, ['2025-12', '2025-12', '2025-12', '2026-01', '2026-01', '2026-02', '2026-03', null, null, null, null]);
  assert.deepEqual(buckets.map(({ value, count }) => [value, count]), [
    ['2026-03', 1], ['2026-02', 1], ['2026-01', 2], ['2025-12', 3],
  ]);
  assert.ok(buckets.every(({ label }) => /202[56]/.test(label)));
});

test('positive and fractional time zones bucket into the next local month', () => {
  assert.deepEqual(monthsInZone('Asia/Kolkata', [
    '2026-01-31T18:29:59Z', '2026-01-31T18:30:00Z',
  ]).keys, ['2026-01', '2026-02']);
  assert.deepEqual(monthsInZone('Pacific/Kiritimati', [
    '2025-12-31T10:00:00Z', '2026-01-31T10:00:00Z',
  ]).keys, ['2026-01', '2026-02']);
});

test('card dates agree with local month buckets for D1 UTC and imported timestamps', () => {
  const { keys, displayedDates } = monthsInZone('America/New_York', [
    '2026-01-01 00:30:00', '2026-01-01T00:30:00Z', '2025-12-31T23:30:00-06:00', null, 'bad',
  ]);
  assert.deepEqual(keys, ['2025-12', '2025-12', '2026-01', null, null]);
  assert.deepEqual(displayedDates, ['Dec 31, 2025', 'Dec 31, 2025', 'Jan 1, 2026', '', '']);
});

test('month buckets sort newest first, skip missing dates and handle DST', () => {
  const { keys, buckets } = monthsInZone('America/New_York', [
    '2026-11-01T05:30:00Z', '2026-03-08T06:59:59Z',
    '2026-03-08T07:00:00Z', '2026-11-01T06:30:00Z',
  ]);
  assert.deepEqual(keys, ['2026-11', '2026-03', '2026-03', '2026-11']);
  assert.deepEqual(buckets.map(({ value, count }) => [value, count]), [['2026-11', 2], ['2026-03', 2]]);
  assert.deepEqual(monthsInZone('UTC', []).buckets, []);
  assert.deepEqual(monthsInZone('UTC', [null, 'bad']).buckets, []);
});

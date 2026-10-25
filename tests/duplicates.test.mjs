import test from 'node:test';
import assert from 'node:assert/strict';
import { canUseDuplicateFinder, normalizeDuplicateUrl, findDuplicateGroups, chooseDuplicateKeeper, duplicateTrashIds } from '../src/utils/duplicates.js';

test('duplicate finder is available to every signed-in owner, free and paid', () => {
  assert.equal(canUseDuplicateFinder(null), false);
  assert.equal(canUseDuplicateFinder({ membership_tier: 'free' }), true);
  assert.equal(canUseDuplicateFinder({ membership_tier: 'paid' }), true);
});

test('review matches scheme, host case, www, default ports, fragments and trailing slash', () => {
  for (const [a, b] of [
    ['http://WWW.Example.COM:80/page/#intro', 'https://example.com:443/page'],
    ['https://example.com', 'http://www.example.com/'],
    ['https://example.com/page/?id=42#one', 'http://example.com/page?id=42#two'],
    ['https://example.com:8443/page/', 'http://example.com:8443/page'],
  ]) assert.equal(normalizeDuplicateUrl(a), normalizeDuplicateUrl(b), `${a} should match ${b}`);
});

test('review strips only the documented tracking parameters, wherever they occur', () => {
  const expected = normalizeDuplicateUrl('https://example.com/page?id=42&lang=en');
  assert.equal(normalizeDuplicateUrl('https://www.example.com/page/?utm_source=email&id=42&fbclid=abc&lang=en&gclid=xyz&dclid=x&msclkid=y&utm_campaign=z'), expected);
  assert.equal(normalizeDuplicateUrl('https://example.com/page?id=42&UTM_MEDIUM=social&lang=en&%66bclid=z'), expected);
  assert.equal(normalizeDuplicateUrl('http://example.com/?utm_source=x'), normalizeDuplicateUrl('https://example.com'));
});

test('near misses keep different pages, subdomains, ports and meaningful queries distinct', () => {
  for (const [a, b] of [
    ['/page', '/other'], ['/Page', '/page'], ['/page//', '/page/'],
    ['/page?id=1', '/page?id=2'], ['/page?id=1', '/page'],
    ['/page?id=1&lang=en', '/page?lang=en&id=1'],
    ['/page?id=1&id=2', '/page?id=2&id=1'],
    ['/page?ref=newsletter', '/page'], ['/page?utmish=x', '/page'],
    ['/page?text=a+b', '/page?text=a%20b'],
    ['/page?ID=1', '/page?id=1'], ['/page?x', '/page?x='],
    ['/a%2Fb', '/a/b'], ['/page?q=%zz', '/page?q=zz'],
  ]) assert.notEqual(normalizeDuplicateUrl(`https://example.com${a}`), normalizeDuplicateUrl(`https://example.com${b}`), `${a} must differ from ${b}`);
  assert.notEqual(normalizeDuplicateUrl('http://example.com:443/page'), normalizeDuplicateUrl('https://example.com:443/page'));
  assert.notEqual(normalizeDuplicateUrl('https://example.com:80/page'), normalizeDuplicateUrl('http://example.com:80/page'));
  assert.notEqual(normalizeDuplicateUrl('https://docs.example.com/page'), normalizeDuplicateUrl('https://example.com/page'));
});

test('invalid, credential-bearing and non-web URLs never form a group', () => {
  for (const value of [null, undefined, 42, '', 'example.com/page', 'not a url', 'ftp://example.com/page', 'javascript:alert(1)', 'https://user:password@example.com/page']) {
    assert.equal(normalizeDuplicateUrl(value), null);
  }
});

test('groups use the full supplied live list including private bookmarks, excluding trash', () => {
  const bookmarks = [
    { id: 1, url: 'https://example.com/a', tags: [{ name: 'a' }] },
    { id: 2, url: 'http://www.example.com/a/?utm_source=x', is_private: 1 },
    { id: 3, url: 'https://example.com/a#old', deleted_at: '2026-10-24 10:00:00' },
    { id: 4, url: 'https://example.com/b' },
    { id: 5, url: 'https://example.com/b', deleted_at: '2026-10-24 10:00:00' },
    { id: 6, url: 'bad url' }, { id: 7, url: 'bad url' },
    { id: 8, url: 'https://example.com/a', deleted_at: '' },
  ];
  const before = structuredClone(bookmarks);
  const groups = findDuplicateGroups(bookmarks);
  assert.deepEqual(groups.map((group) => group.bookmarks.map((bookmark) => bookmark.id)), [[1, 2]]);
  assert.deepEqual(bookmarks, before, 'grouping must not change the library, titles or tags');
  assert.deepEqual(findDuplicateGroups([]), []);
});

test('keeper shortcuts compare UTC/offset dates, tie by id, and prefer known dates', () => {
  const bookmarks = [
    { id: 1, created_at: '2026-10-25 12:00:00' },
    { id: 2, created_at: '2026-10-25T09:00:00-04:00' },
    { id: 3, created_at: '2026-10-25T13:00:00Z' },
    { id: 4, created_at: 'invalid' },
  ];
  assert.equal(chooseDuplicateKeeper(bookmarks, 'newest'), 3);
  assert.equal(chooseDuplicateKeeper(bookmarks, 'oldest'), 1);
  assert.equal(chooseDuplicateKeeper([{ id: 2 }, { id: 1 }], 'oldest'), 1);
  assert.equal(chooseDuplicateKeeper([], 'newest'), null);
});

test('trash plans require a live keeper and cap both delete and Undo at 500 ids', () => {
  const group = { bookmarks: Array.from({ length: 1002 }, (_, index) => ({ id: index + 1 })) };
  assert.deepEqual(duplicateTrashIds(group, null), []);
  assert.deepEqual(duplicateTrashIds(group, 1003), []);
  assert.deepEqual(duplicateTrashIds(undefined, 1), []);
  const ids = duplicateTrashIds(group, 250);
  assert.equal(ids.length, 500);
  assert.equal(ids.includes(250), false);
  assert.equal(new Set(ids).size, 500);
  assert.deepEqual(duplicateTrashIds({ bookmarks: [{ id: 1 }, { id: 2 }] }, 2), [1]);
});

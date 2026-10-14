import test from 'node:test';
import assert from 'node:assert/strict';
import { hasNoTags, countUntagged } from '../src/utils/bookmarkFilters.js';

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

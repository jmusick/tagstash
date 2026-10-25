// User-facing input limits. The server enforces these (INPUT_LIMITS in
// functions/api/[[path]].js); this copy only drives maxLength and early form errors.
// Change both together — tests/input-limits.test.mjs checks they match.
export const INPUT_LIMITS = {
  title: 1000,
  url: 8192,
  description: 10000,
  // The private Markdown note on a bookmark (owner-only).
  note: 10000,
  tagName: 100,
  tagsPerBookmark: 50,
  username: 50,
  email: 254,
  // New passwords: minimum in characters (code points), maximum in UTF-8 bytes (bcrypt's limit).
  // See src/utils/passwordPolicy.js; login fields carry neither.
  passwordMinChars: 8,
  passwordMaxBytes: 72,
  apiKeyName: 100,
  // Most bookmarks one bulk action may change (the library caps its selection here).
  bulkBookmarkIds: 500,
};

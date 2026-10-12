// User-facing input limits. The server enforces these (INPUT_LIMITS in
// functions/api/[[path]].js); this copy only drives maxLength and early form errors.
// Change both together — tests/input-limits.test.mjs checks they match.
export const INPUT_LIMITS = {
  title: 1000,
  url: 8192,
  description: 10000,
  tagName: 100,
  tagsPerBookmark: 50,
  username: 50,
  email: 254,
  password: 256,
  apiKeyName: 100,
};

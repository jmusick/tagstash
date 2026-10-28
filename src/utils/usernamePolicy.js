import { INPUT_LIMITS } from './inputLimits.js';

// The new-username policy, shared by the API (functions/api/[[path]].js imports it for register
// and username change) and the sign-up / Settings forms, so the two can't disagree. Use it for NEW
// usernames only: existing names that predate it are grandfathered and keep working everywhere,
// but a rename must meet it.
//
// - USERNAME_MIN_CHARS to INPUT_LIMITS.username characters.
// - ASCII letters, digits, '.', '_' and '-' only, so every name routes as one /u/:username path
//   segment and can't hide zero-width characters or Unicode look-alikes.
// - Starts and ends with a letter or digit, with no two punctuation characters in a row.
// - Not a reserved name (compared case-insensitively).
export const USERNAME_MIN_CHARS = 2;

const USERNAME_SHAPE = /^[A-Za-z0-9](?:[._-]?[A-Za-z0-9])*$/;

// Staff-sounding names, plus top-level app routes, so a profile can't pose as the site itself.
export const RESERVED_USERNAMES = new Set([
  'about', 'account', 'admin', 'administrator', 'api', 'app', 'assets', 'billing', 'blog', 'changelog',
  'contact', 'developers', 'docs', 'duplicates', 'features', 'help', 'login', 'logout', 'mail', 'me',
  'moderator', 'null', 'official', 'pricing', 'privacy', 'register', 'reset-password', 'root', 'security',
  'settings', 'signin', 'signup', 'sitemap', 'staff', 'static', 'status', 'support', 'system', 'tags',
  'tagstash', 'team', 'terms', 'trash', 'u', 'undefined', 'user', 'users', 'verify-email', 'www',
]);

// Form hint.
export const USERNAME_HINT = 'Letters, numbers, and . _ - between them. No spaces.';

// Returns an error message, or null when the username may be taken under the policy.
export const newUsernameError = (username) => {
  if (typeof username !== 'string' || !username) return 'Username is required';
  if (/\s/.test(username)) return 'Username cannot contain spaces';
  if (username.length < USERNAME_MIN_CHARS) {
    return `Username must be at least ${USERNAME_MIN_CHARS} characters`;
  }
  if (username.length > INPUT_LIMITS.username) {
    return `Username must be ${INPUT_LIMITS.username} characters or less`;
  }
  if (!/^[A-Za-z0-9._-]+$/.test(username)) {
    return 'Username can only use letters, numbers, and . _ -';
  }
  if (!USERNAME_SHAPE.test(username)) {
    return 'Username must start and end with a letter or number, with no two of . _ - in a row';
  }
  if (RESERVED_USERNAMES.has(username.toLowerCase())) return 'That username is reserved';
  return null;
};

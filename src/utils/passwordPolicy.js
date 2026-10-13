import { INPUT_LIMITS } from './inputLimits.js';

// The new-password length policy, shared by the API (functions/api/[[path]].js imports it for
// register, password change and reset) and the sign-up / change / reset forms, so the two can't
// disagree. The server additionally refuses passwords found in known breaches (isPwnedPassword).
// Use it for NEW passwords only, never at login: existing passwords are grandfathered.
//
// - Minimum: passwordMinChars characters, counted as code points, so an emoji counts once.
// - Maximum: passwordMaxBytes UTF-8 bytes. bcrypt hashes only the first 72 bytes, so a longer
//   password would be silently truncated and any password sharing that prefix would sign in.
const { passwordMinChars, passwordMaxBytes } = INPUT_LIMITS;

const encoder = new TextEncoder();

export const utf8ByteLength = (value) => encoder.encode(value).length;

// Form hint. The byte limit is explained only in the too-long error, where it matters.
export const NEW_PASSWORD_HINT =
  `At least ${passwordMinChars} characters. Passwords found in known data breaches can't be used.`;

// Returns an error message, or null when the password meets the length policy.
export const newPasswordError = (password, label = 'Password') => {
  if (typeof password !== 'string' || !password) return `${label} is required`;
  if ([...password].length < passwordMinChars) {
    return `${label} must be at least ${passwordMinChars} characters`;
  }
  if (utf8ByteLength(password) > passwordMaxBytes) {
    return `${label} is too long: the limit is ${passwordMaxBytes} bytes, which is ${passwordMaxBytes} plain letters, digits or symbols (accented letters and emoji take 2-4 bytes each)`;
  }
  return null;
};

// Account reset (issue #154): the word an owner types to confirm wiping their library while
// keeping the account. Shared by the Settings form and the API (functions/api/[[path]].js
// imports it, as it does accountDeletion.js), so the server enforces what the form asks. It is
// deliberately not the account-deletion word, so one can't be typed for the other.
export const ACCOUNT_RESET_CONFIRMATION = 'RESET';

export const isAccountResetConfirmation = (value) =>
  typeof value === 'string' && value.trim() === ACCOUNT_RESET_CONFIRMATION;

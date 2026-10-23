// Self-service account deletion: the word an owner types to confirm. Shared by the Settings
// form and the API (functions/api/[[path]].js imports it, as it does passwordPolicy.js), so the
// server enforces the same acknowledgement the form asks for.
export const ACCOUNT_DELETION_CONFIRMATION = 'DELETE';

export const isAccountDeletionConfirmation = (value) =>
  typeof value === 'string' && value.trim() === ACCOUNT_DELETION_CONFIRMATION;

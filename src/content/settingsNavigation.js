export const SETTINGS_GROUPS = [
  { id: 'library', label: 'Library', sections: [
    { id: 'preferences', label: 'Preferences' },
    { id: 'import', label: 'Import / Export' },
  ] },
  { id: 'account', label: 'Account', sections: [
    { id: 'username', label: 'Username' },
    { id: 'email', label: 'Email' },
    { id: 'password', label: 'Password' },
    { id: 'signOut', label: 'Sessions' },
  ] },
  { id: 'sharing', label: 'Sharing & API', sections: [
    { id: 'publicProfile', label: 'Public Profile' },
    { id: 'apiKeys', label: 'API Keys' },
    { id: 'extensions', label: 'Extensions' },
  ] },
  { id: 'billing', label: 'Billing', sections: [{ id: 'billing', label: 'Billing' }] },
  { id: 'admin', label: 'Administration', sections: [{ id: 'admin', label: 'Admin' }] },
  { id: 'danger', label: 'Danger zone', sections: [
    { id: 'resetLibrary', label: 'Reset Library' },
    { id: 'deleteAccount', label: 'Delete Account' },
  ] },
]

export function settingsSection(value, isSuperAdmin) {
  const normalize = (text) => text.toLowerCase().replace(/[^a-z]/g, '')
  const requested = normalize(value || '')
  return SETTINGS_GROUPS.flatMap((group) => group.sections).find((section) =>
    (section.id !== 'admin' || isSuperAdmin) &&
    [section.id, section.label].some((name) => normalize(name) === requested)
  ) || SETTINGS_GROUPS[0].sections[0]
}

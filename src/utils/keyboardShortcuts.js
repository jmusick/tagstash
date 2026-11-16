export const SHORTCUTS_STORAGE_KEY = 'tagstash-keyboard-shortcuts'

export const LIBRARY_SHORTCUTS = [
  { key: '/', action: 'search', label: 'Focus bookmark search' },
  { key: 'n', action: 'add', label: 'Open Add bookmark' },
  { key: '?', action: 'help', label: 'Show keyboard shortcuts' },
]

export function readShortcutsEnabled() {
  try {
    return window.localStorage.getItem(SHORTCUTS_STORAGE_KEY) !== 'disabled'
  } catch {
    return true
  }
}

export function saveShortcutsEnabled(enabled) {
  try {
    window.localStorage.setItem(SHORTCUTS_STORAGE_KEY, enabled ? 'enabled' : 'disabled')
  } catch {
    // The preference still applies for this visit when storage is unavailable.
  }
}

export function libraryShortcutAction(event) {
  if (event.defaultPrevented || event.repeat || event.isComposing || event.keyCode === 229 ||
      event.ctrlKey || event.metaKey || event.altKey) return null
  // Leave typing, native controls and custom widgets to their own keyboard handlers.
  if (event.target?.isContentEditable || event.target?.closest?.(
    'input, textarea, select, button, a, summary, [contenteditable]:not([contenteditable="false"]), [role="textbox"], [role="combobox"], [role="searchbox"], [role="dialog"], [aria-modal="true"]'
  )) return null
  // '?' needs Shift on many keyboards; Shift must not turn N into the add action.
  if (event.shiftKey && event.key !== '?') return null
  return LIBRARY_SHORTCUTS.find(({ key }) => key === event.key)?.action || null
}

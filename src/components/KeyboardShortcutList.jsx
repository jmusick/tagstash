import { LIBRARY_SHORTCUTS } from '../utils/keyboardShortcuts'

export default function KeyboardShortcutList() {
  return (
    <ul className="keyboard-shortcut-list">
      {LIBRARY_SHORTCUTS.map(({ key, label }) => <li key={key}><kbd>{key}</kbd> — {label}</li>)}
    </ul>
  )
}

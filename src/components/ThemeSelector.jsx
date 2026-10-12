import { useRef, useState } from 'react'
import { THEME_ORDER, THEME_LABELS, THEME_ICONS } from '../utils/theme'

function ThemeSelector({ theme, onSelectTheme, className = '', size = 16 }) {
  const [expanded, setExpanded] = useState(false)
  const containerRef = useRef(null)

  const collapse = () => setExpanded(false)
  const expand = () => setExpanded(true)

  const handleBlur = (e) => {
    if (!containerRef.current?.contains(e.relatedTarget)) {
      collapse()
    }
  }

  return (
    <div
      ref={containerRef}
      className={`theme-selector ${expanded ? 'theme-selector--expanded' : ''} ${className}`}
      onMouseEnter={expand}
      onMouseLeave={collapse}
      onFocus={expand}
      onBlur={handleBlur}
    >
      {THEME_ORDER.map((t) => {
        const Icon = THEME_ICONS[t]
        const isActive = t === theme
        return (
          <button
            key={t}
            type="button"
            onClick={(e) => {
              e.stopPropagation()
              // Collapsed, the active button only reveals the options (a pointer
              // affordance; re-selecting the current theme is a no-op anyway).
              // Any other button is always real: the "hidden" ones are still in
              // the accessibility tree, and a screen reader's activate can click
              // them without the focus/hover events that expand the control.
              if (!expanded && isActive) {
                expand()
                return
              }
              onSelectTheme(t)
              collapse()
            }}
            className={`theme-selector-btn ${isActive ? 'theme-selector-btn--active' : ''} ${!expanded && !isActive ? 'theme-selector-btn--hidden' : ''}`}
            aria-label={isActive ? `Current theme: ${THEME_LABELS[t]}` : `Switch to ${THEME_LABELS[t]} theme`}
            aria-pressed={isActive}
          >
            <Icon size={size} />
            <span className="theme-selector-label">{THEME_LABELS[t]}</span>
          </button>
        )
      })}
    </div>
  )
}

export default ThemeSelector

import Logo from './Logo'
import { useState, useRef, useId, Children } from 'react'
import { Menu, X } from 'lucide-react'
import ThemeSelector from './ThemeSelector'

function AppHeader({ logoSrc, tagline, onLogoClick, theme, onSelectTheme, children }) {
  const [menuOpen, setMenuOpen] = useState(false)
  const hasMenuItems = Children.count(children) > 0
  const menuId = useId()
  const menuToggleRef = useRef(null)

  // Escape closes the open mobile menu and hands focus back to its toggle.
  const handleKeyDown = (e) => {
    if (e.key === 'Escape' && menuOpen) {
      setMenuOpen(false)
      menuToggleRef.current?.focus()
    }
  }

  return (
    <header className="app-header" onKeyDown={handleKeyDown}>
      <div className="app-header-brand">
        {onLogoClick ? (
          <button type="button" className="app-header-logo-btn" onClick={onLogoClick} title="Back to bookmarks">
            <Logo src={logoSrc} className="app-header-logo" />
          </button>
        ) : (
          <a href="/" className="app-header-logo-btn" title="Back to Tagstash">
            <Logo src={logoSrc} className="app-header-logo" />
          </a>
        )}
        {tagline && <p className="app-header-tagline">{tagline}</p>}
      </div>

      {hasMenuItems && (
        <button
          ref={menuToggleRef}
          type="button"
          className="app-header-menu-toggle"
          onClick={() => setMenuOpen((prev) => !prev)}
          aria-label={menuOpen ? 'Close menu' : 'Open menu'}
          aria-expanded={menuOpen}
          aria-controls={menuId}
        >
          {menuOpen ? <X size={20} /> : <Menu size={20} />}
        </button>
      )}

      <div
        id={menuId}
        className={`user-info ${menuOpen ? 'user-info-open' : ''}`}
        onClick={() => setMenuOpen(false)}
      >
        <ThemeSelector theme={theme} onSelectTheme={onSelectTheme} />
        {children}
      </div>
    </header>
  )
}

export default AppHeader

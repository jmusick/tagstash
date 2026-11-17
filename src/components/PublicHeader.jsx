import Logo from './Logo'
import ThemeSelector from './ThemeSelector'
import { publicNavigationLinks } from '../content/publicNavigation'

export default function PublicHeader({ logoSrc = '/logo-dark.png', theme = 'slate', onSelectTheme = () => {}, signedIn = false, currentPath }) {
  return (
    <header className="public-header">
      <a href="/" className="app-header-logo-btn" title="Back to Tagstash">
        <Logo src={logoSrc} className="app-header-logo" />
      </a>
      <nav className="public-header-nav" aria-label="Main">
        {publicNavigationLinks(signedIn).map((link, index, links) => (
          <a key={link.href} href={link.href} className={signedIn !== null && index === links.length - 1 ? 'public-header-action' : undefined} aria-current={link.href === currentPath ? 'page' : undefined}>
            {link.label}
          </a>
        ))}
      </nav>
      <ThemeSelector theme={theme} onSelectTheme={onSelectTheme} />
    </header>
  )
}

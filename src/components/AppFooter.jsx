function AppFooter({ children, version }) {
  return (
    <footer className="app-footer">
      <span className="footer-copyright">
        &copy; {new Date().getFullYear()}{' '}
        <a href="https://stonedragonmedia.com/" target="_blank" rel="noopener noreferrer">
          Stone Dragon Media LLC
        </a>
      </span>
      {children}
      <a className="footer-privacy-link" href="/developers">Developers</a>
      <button type="button" className="footer-privacy-link" data-cookie-preferences>
        Cookie Choices
      </button>
      {version && <span className="version">v{version}</span>}
    </footer>
  )
}

export default AppFooter

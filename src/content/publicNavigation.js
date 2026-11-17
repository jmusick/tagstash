// Shared by React public pages and the Worker-rendered snapshots.
export const PUBLIC_NAV_LINKS = [
  { href: '/features', label: 'Features' },
  { href: '/pricing', label: 'Pricing' },
  { href: '/developers', label: 'Developers' },
]

export const LOGIN_LINK = { href: '/?signup=0#account', label: 'Log in' }
export const SIGNUP_LINK = { href: '/?signup=1#account', label: 'Start free' }
export const LIBRARY_LINK = { href: '/', label: 'Your bookmarks' }

// signedIn is null while the session check is still pending: offer neither the library nor
// login/signup, so a signed-in visitor never sees signed-out actions flash first.
export function publicNavigationLinks(signedIn = false) {
  if (signedIn === null) return PUBLIC_NAV_LINKS
  return [...PUBLIC_NAV_LINKS, ...(signedIn ? [LIBRARY_LINK] : [LOGIN_LINK, SIGNUP_LINK])]
}

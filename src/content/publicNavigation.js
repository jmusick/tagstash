// Shared by React public pages and the Worker-rendered snapshots.
export const PUBLIC_NAV_LINKS = [
  { href: '/features', label: 'Features' },
  { href: '/pricing', label: 'Pricing' },
  { href: '/developers', label: 'Developers' },
]

export const LOGIN_LINK = { href: '/?signup=0#account', label: 'Log in' }
export const SIGNUP_LINK = { href: '/?signup=1#account', label: 'Start free' }
export const LIBRARY_LINK = { href: '/', label: 'Your bookmarks' }

export function publicNavigationLinks(signedIn = false) {
  return [...PUBLIC_NAV_LINKS, ...(signedIn ? [LIBRARY_LINK] : [LOGIN_LINK, SIGNUP_LINK])]
}

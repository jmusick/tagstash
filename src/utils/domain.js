// Common multi-part public suffixes (e.g. "co.uk") where the registrable
// domain needs the label before the suffix too (reddit.co.uk, not co.uk).
// Not exhaustive, but covers the domains bookmark collections are likely to hit.
const MULTI_PART_TLDS = new Set([
  'co.uk', 'org.uk', 'gov.uk', 'ac.uk', 'net.uk', 'sch.uk',
  'co.jp', 'ne.jp', 'or.jp', 'ac.jp',
  'co.nz', 'net.nz', 'org.nz',
  'co.in', 'net.in', 'org.in',
  'com.au', 'net.au', 'org.au', 'edu.au', 'gov.au',
  'com.br', 'com.mx', 'com.cn', 'com.tw', 'com.sg', 'com.hk',
  'co.za', 'co.kr',
])

// Returns the registrable domain (e.g. "reddit.com") for a URL, treating
// subdomains as equivalent (www.reddit.com, old.reddit.com -> reddit.com).
// Returns null if the URL can't be parsed.
export function getRegistrableDomain(url) {
  try {
    const { hostname } = new URL(url)
    const labels = hostname.toLowerCase().split('.').filter(Boolean)
    if (labels.length <= 2) return labels.join('.')

    const lastTwo = labels.slice(-2).join('.')
    if (MULTI_PART_TLDS.has(lastTwo)) {
      return labels.slice(-3).join('.')
    }
    return lastTwo
  } catch {
    return null
  }
}

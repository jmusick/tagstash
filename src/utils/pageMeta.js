// Head metadata for the static public pages. Shared by the React pages
// (useDocumentMeta) and scripts/prerender-features.mjs, so the raw HTML crawlers
// fetch and the client-side head always agree.
export const PRIVACY_META = {
  title: 'Privacy Policy - Tagstash',
  description: 'How Tagstash collects, uses, and protects your account and bookmark data.',
  path: '/privacy',
}

export const SUPPORT_META = {
  title: 'Support - Tagstash',
  description: 'Get help with your Tagstash account or send the team a message.',
  path: '/support',
}

export const DEVELOPERS_META = {
  title: 'Developers - Tagstash REST API',
  description: 'Use personal API keys to read and edit your Tagstash library. Browse routes, curl examples, limits, errors and the public profile API.',
  path: '/developers',
}

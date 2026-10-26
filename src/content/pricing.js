// Pricing copy for /pricing and the schema.org offers on / and /pricing. Keep it in
// step with FREE_BOOKMARK_LIMIT and the Stripe prices; it must neither promise nor
// deny refunds until the refund policy (#115) is decided.
export const PRICING_UPDATED = '2026-10-26'

export const PRICING_OFFERS = [
  { '@type': 'Offer', name: 'Free', price: '0', priceCurrency: 'USD', description: 'Up to 50 bookmarks, no time limit.' },
  { '@type': 'Offer', name: 'Pro Monthly', price: '3', priceCurrency: 'USD', description: 'Unlimited bookmarks, billed monthly, cancel anytime.' },
  { '@type': 'Offer', name: 'Pro Annual', price: '36', priceCurrency: 'USD', description: 'Unlimited bookmarks, same $3/month rate billed once a year.' },
]

export const PRICING_INCLUDED = [
  'Up to 50 tags per bookmark, tag merging and favorite tags',
  'Search with operators, filters and sorting',
  'Private Markdown notes on bookmarks',
  'Chrome and Firefox extensions',
  'An optional public profile with its JSON API',
  'Import from browsers, Raindrop.io, Pocket, Pinboard and Instapaper',
  'Export to HTML, CSV or JSON',
  'Trash that keeps deleted bookmarks for 30 days',
  'Duplicate finder',
  'Personal API keys for the REST API',
]

export const PRICING_FAQS = [
  {
    question: 'What happens when I reach 50 bookmarks on the free plan?',
    answer: 'You can still open, edit, tag and delete every bookmark you have. New saves are refused, and an import adds only as many bookmarks as still fit, until you upgrade or delete some. Bookmarks in the Trash don’t count toward the 50; restoring one does.',
  },
  {
    question: 'How do I upgrade to Pro?',
    answer: 'Sign in, open Settings, and choose monthly or annual billing. Checkout and payments are handled by Stripe, and Pro starts once Stripe confirms the payment.',
  },
  {
    question: 'Can I cancel Pro?',
    answer: 'Yes. Open Settings and cancel in the Stripe billing portal. Pro stays active until the end of the period you’ve already paid for, and Settings shows the date it ends. Deleting your account cancels Pro immediately instead.',
  },
  {
    question: 'What happens to my bookmarks if I stop paying?',
    answer: 'Nothing is deleted. Your account returns to the free plan with every bookmark intact. If you have more than 50, you can keep using them, but you can’t add new ones until you’re back under the limit or upgrade again.',
  },
]

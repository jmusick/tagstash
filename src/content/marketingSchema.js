import { HOME_FAQS } from './homeMarketing.js'
import { FEATURES_FAQS, FEATURES_UPDATED } from './featuresFaqs.js'
import { FEATURES_META } from '../utils/featuresMeta.js'
import { PRICING_META } from '../utils/pageMeta.js'
import { PRICING_FAQS, PRICING_OFFERS, PRICING_UPDATED } from './pricing.js'

const faqEntity = (faqs) => ({
  '@type': 'FAQPage',
  mainEntity: faqs.map(faq => ({
    '@type': 'Question', name: faq.question,
    acceptedAnswer: { '@type': 'Answer', text: faq.answer },
  })),
})

export function getHomeStructuredData(origin) {
  return {
    '@context': 'https://schema.org',
    '@graph': [
      {
        '@type': 'SoftwareApplication', '@id': `${origin}/#software`,
        name: 'Tagstash', url: `${origin}/`,
        description: 'A tag-based bookmark manager for saving links, organizing bookmarks, and sharing a public profile. Free for your first 50 bookmarks.',
        applicationCategory: 'Bookmark Manager', operatingSystem: 'Web, Chrome, Firefox',
        offers: PRICING_OFFERS,
      },
      faqEntity(HOME_FAQS),
      {
        '@type': 'Organization', name: 'Stone Dragon Media LLC', url: 'https://stonedragonmedia.com/',
        brand: { '@type': 'Brand', name: 'Tagstash', url: `${origin}/`, logo: `${origin}/icon-512.png` },
      },
    ],
  }
}

export function getFeaturesStructuredData(origin) {
  const url = `${origin}${FEATURES_META.path}`
  return {
    '@context': 'https://schema.org',
    '@graph': [
      {
        '@type': 'WebPage', '@id': `${url}#webpage`, url,
        isPartOf: { '@id': `${origin}/#website` },
        name: FEATURES_META.title, description: FEATURES_META.description,
        dateModified: FEATURES_UPDATED,
        about: { '@type': 'SoftwareApplication', name: 'Tagstash', url: `${origin}/` },
        publisher: { '@type': 'Organization', name: 'Stone Dragon Media LLC', url: 'https://stonedragonmedia.com/' },
        breadcrumb: { '@id': `${url}#breadcrumbs` },
      },
      {
        '@type': 'BreadcrumbList', '@id': `${url}#breadcrumbs`,
        itemListElement: [
          { '@type': 'ListItem', position: 1, name: 'Home', item: `${origin}/` },
          { '@type': 'ListItem', position: 2, name: 'Features', item: url },
        ],
      },
      faqEntity(FEATURES_FAQS),
    ],
  }
}

export function getPricingStructuredData(origin) {
  const url = `${origin}${PRICING_META.path}`
  return {
    '@context': 'https://schema.org',
    '@graph': [
      {
        '@type': 'WebPage', '@id': `${url}#webpage`, url,
        isPartOf: { '@id': `${origin}/#website` },
        name: PRICING_META.title, description: PRICING_META.description,
        dateModified: PRICING_UPDATED,
        about: { '@id': `${origin}/#software` },
        publisher: { '@type': 'Organization', name: 'Stone Dragon Media LLC', url: 'https://stonedragonmedia.com/' },
        breadcrumb: { '@id': `${url}#breadcrumbs` },
      },
      {
        '@type': 'SoftwareApplication', '@id': `${origin}/#software`,
        name: 'Tagstash', url: `${origin}/`,
        applicationCategory: 'Bookmark Manager', operatingSystem: 'Web, Chrome, Firefox',
        offers: PRICING_OFFERS,
      },
      {
        '@type': 'BreadcrumbList', '@id': `${url}#breadcrumbs`,
        itemListElement: [
          { '@type': 'ListItem', position: 1, name: 'Home', item: `${origin}/` },
          { '@type': 'ListItem', position: 2, name: 'Pricing', item: url },
        ],
      },
      faqEntity(PRICING_FAQS),
    ],
  }
}

export const serializeStructuredData = data => JSON.stringify(data).replaceAll('<', '\\u003c')

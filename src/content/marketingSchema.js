import { HOME_FAQS } from './homeMarketing.js'
import { FEATURES_FAQS, FEATURES_UPDATED } from './featuresFaqs.js'
import { FEATURES_META } from '../utils/featuresMeta.js'
import { PRICING_META } from '../utils/pageMeta.js'
import { PRICING_FAQS, PRICING_OFFERS, PRICING_UPDATED } from './pricing.js'
import { EXTENSION_INSTALL_STEPS, EXTENSION_META, EXTENSION_UPDATED } from './browserExtension.js'
import { IMPORT_GUIDES, IMPORT_GUIDES_UPDATED, IMPORT_HUB_META, findImportGuide, importGuideMeta, tagstashImportSteps } from './importGuides.js'

// One definition of the app entity, so every page that declares it agrees.
const softwareEntity = (origin) => ({
  '@type': 'SoftwareApplication', '@id': `${origin}/#software`,
  name: 'Tagstash', url: `${origin}/`,
  description: 'A tag-based bookmark manager for saving links, organizing bookmarks, and sharing a public profile. Free for your first 50 bookmarks.',
  applicationCategory: 'Bookmark Manager', operatingSystem: 'Web, Chrome, Firefox',
  offers: PRICING_OFFERS,
})

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
      softwareEntity(origin),
      faqEntity(HOME_FAQS),
      {
        '@type': 'Organization', name: 'Stone Dragon Media LLC', url: 'https://stonedragonmedia.com/',
        brand: { '@type': 'Brand', name: 'Tagstash', url: `${origin}/`, logo: `${origin}/icon-512.png` },
      },
    ],
  }
}

// WebPage + the shared app entity + breadcrumbs: the start of every marketing page's graph.
// breadcrumbs is a list of [name, path]; the last entry is the page itself.
const webPageGraph = (origin, meta, dateModified, breadcrumbs) => {
  const url = `${origin}${meta.path}`
  return [
    {
      '@type': 'WebPage', '@id': `${url}#webpage`, url,
      isPartOf: { '@id': `${origin}/#website` },
      name: meta.title, description: meta.description,
      dateModified,
      about: { '@id': `${origin}/#software` },
      publisher: { '@type': 'Organization', name: 'Stone Dragon Media LLC', url: 'https://stonedragonmedia.com/' },
      breadcrumb: { '@id': `${url}#breadcrumbs` },
    },
    softwareEntity(origin),
    {
      '@type': 'BreadcrumbList', '@id': `${url}#breadcrumbs`,
      itemListElement: breadcrumbs.map(([name, path], index) => ({ '@type': 'ListItem', position: index + 1, name, item: `${origin}${path}` })),
    },
  ]
}

export function getFeaturesStructuredData(origin) {
  return {
    '@context': 'https://schema.org',
    '@graph': [
      ...webPageGraph(origin, FEATURES_META, FEATURES_UPDATED, [['Home', '/'], ['Features', FEATURES_META.path]]),
      faqEntity(FEATURES_FAQS),
    ],
  }
}

export function getPricingStructuredData(origin) {
  return {
    '@context': 'https://schema.org',
    '@graph': [
      ...webPageGraph(origin, PRICING_META, PRICING_UPDATED, [['Home', '/'], ['Pricing', PRICING_META.path]]),
      faqEntity(PRICING_FAQS),
    ],
  }
}

export function getImportHubStructuredData(origin) {
  return {
    '@context': 'https://schema.org',
    '@graph': [
      ...webPageGraph(origin, IMPORT_HUB_META, IMPORT_GUIDES_UPDATED, [['Home', '/'], ['Import guides', IMPORT_HUB_META.path]]),
      {
        '@type': 'ItemList', name: 'Import guides',
        itemListElement: IMPORT_GUIDES.map((guide, index) => ({
          '@type': 'ListItem', position: index + 1, name: guide.name, url: `${origin}${importGuideMeta(guide).path}`,
        })),
      },
    ],
  }
}

export function getImportGuideStructuredData(origin, slug) {
  const guide = findImportGuide(slug)
  if (!guide) throw new Error(`Unknown import guide: ${slug}`)
  const meta = importGuideMeta(guide)
  // The same steps the page shows, in the same order.
  const steps = [...guide.steps, ...tagstashImportSteps(guide)]
  return {
    '@context': 'https://schema.org',
    '@graph': [
      ...webPageGraph(origin, meta, IMPORT_GUIDES_UPDATED, [['Home', '/'], ['Import guides', IMPORT_HUB_META.path], [guide.name, meta.path]]),
      {
        '@type': 'HowTo', name: meta.title, description: meta.description,
        step: steps.map((text, index) => ({ '@type': 'HowToStep', position: index + 1, text })),
      },
    ],
  }
}

export function getExtensionStructuredData(origin) {
  return {
    '@context': 'https://schema.org',
    '@graph': [
      ...webPageGraph(origin, EXTENSION_META, EXTENSION_UPDATED, [['Home', '/'], ['Browser extension', EXTENSION_META.path]]),
      {
        '@type': 'HowTo', name: 'Install the Tagstash browser extension', description: 'Add the Tagstash extension to Chrome or Firefox, sign in, and save your first page.',
        step: EXTENSION_INSTALL_STEPS.map((text, index) => ({ '@type': 'HowToStep', position: index + 1, text })),
      },
    ],
  }
}

export const serializeStructuredData = data => JSON.stringify(data).replaceAll('<', '\\u003c')

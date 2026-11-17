// Browser extension landing page (/extension). Shared by the React page, the build-time
// prerender, the page schema and the sitemap. The extension's source lives outside this
// repo, so keep every claim to what the site already says elsewhere (Features, Settings →
// Extensions, the homepage FAQ, llms.txt). Only link store listings that are live (#116).
export const EXTENSION_UPDATED = '2026-11-16'

export const EXTENSION_META = {
  title: 'Tagstash Browser Extension for Chrome and Firefox',
  description: 'Save the tab you are on to Tagstash without leaving the page. Add tags and notes as you save. Free for Chrome and Firefox.',
  path: '/extension',
}

export const EXTENSION_STORES = [
  {
    id: 'chrome',
    name: 'Chrome',
    icon: '/chrome.svg',
    action: 'Add to Chrome',
    store: 'Chrome Web Store',
    url: 'https://chromewebstore.google.com/detail/tagstash/ijoaejbpaibpodnohjmlbeanfhjdgoab',
    summary: 'Save the current tab without leaving the page.',
  },
  {
    id: 'firefox',
    name: 'Firefox',
    icon: '/firefox.svg',
    action: 'Add to Firefox',
    store: 'Firefox Add-ons',
    url: 'https://addons.mozilla.org/en-US/firefox/addon/tagstash/',
    summary: 'Save the current tab, or browse your full tag library and save pages from a sidebar that stays open.',
  },
]

export const EXTENSION_FEATURES = [
  { title: 'Save without leaving the page', description: 'Send the tab you are reading straight to your library. There is no new tab to open and nothing to copy.' },
  { title: 'Tag it while it is fresh', description: 'Add tags and a note as you save, while you still remember why the page mattered.' },
  { title: 'A sidebar in Firefox', description: 'Keep your tag library open in the Firefox sidebar as you browse, and save pages from it.' },
  { title: 'Your own link setting', description: 'Choose whether bookmark links open in the same tab or a new one. The extension keeps its own setting, separate from the web app.' },
]

// One list of steps, shown on the page and used for the HowTo schema.
export const EXTENSION_INSTALL_STEPS = [
  'Open the Tagstash listing on the Chrome Web Store or Firefox Add-ons.',
  'Choose Add to Chrome or Add to Firefox, then confirm the browser’s prompt.',
  'Open the Tagstash extension from the toolbar and sign in with your Tagstash account. In Chrome, pin it from the Extensions (puzzle piece) menu to keep it in view.',
  'On any page you want to keep, open the extension, add tags or a note, and save.',
]

export const EXTENSION_FACTS = [
  'The extensions are free and work on both the Free and Pro plans.',
  'Pages you save from the extension go into the same library as the web app, and count toward the free plan’s 50 bookmarks.',
  'Settings → Sign out of all devices also signs out the extension.',
]

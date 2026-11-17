// Import guides (/import and /import/:source). One record per source, shared by the React
// pages, the build-time prerender, the page schema and the sitemap. Every claim about what
// comes across must match src/utils/bookmarkImport.js and POST /bookmarks/import;
// tests/import-guides.test.mjs checks each importer option label against Import.jsx.
export const IMPORT_GUIDES_UPDATED = '2026-11-16'

// Facts every guide shares, from the import route (INPUT_LIMITS.importBookmarks, duplicate
// handling, the free-plan limit) and the insert, which never sets the private or favorite flags.
export const IMPORT_FACTS = [
  'One file can hold up to 2,000 bookmarks. Split a bigger export and import it in parts.',
  'Links you already have in Tagstash are skipped, so importing the same file twice is safe.',
  'The free plan imports until you reach 50 bookmarks and skips the rest. Pro has no limit.',
  'Imported bookmarks are not marked private or favorite. If your profile is public, they appear on it until you mark them private.',
]

const BROWSER_FOLDERS = 'Each folder a bookmark sits in becomes a tag, so a link in Recipes › Desserts gets the tags recipes and desserts.'

export const IMPORT_GUIDES = [
  {
    slug: 'chrome',
    name: 'Google Chrome',
    summary: 'Export your Chrome bookmarks as an HTML file and import them with your folders as tags.',
    option: 'Google Chrome Bookmarks (HTML)',
    file: 'an HTML file',
    steps: [
      'In Chrome, open the menu (⋮) and choose Bookmarks and lists → Bookmark manager. The shortcut is Ctrl+Shift+O, or Cmd+Option+B on a Mac.',
      'In the Bookmark manager, open the menu (⋮) at the top right and choose Export bookmarks.',
      'Save the HTML file Chrome offers.',
    ],
    carries: [
      'Title and URL of every bookmark.',
      `${BROWSER_FOLDERS} Chrome's own Bookmarks bar and Other bookmarks folders are left out.`,
    ],
    leaves: ['Chrome bookmarks have no descriptions or tags, so there are none to bring.'],
  },
  {
    slug: 'firefox',
    name: 'Firefox',
    summary: 'Export your Firefox bookmarks as an HTML file and import them with their tags and folders.',
    option: 'Firefox Bookmarks (HTML)',
    file: 'an HTML file',
    steps: [
      'In Firefox, open the menu (☰) and choose Bookmarks → Manage bookmarks. The shortcut is Ctrl+Shift+O, or Cmd+Shift+O on a Mac.',
      'In the Library window, choose Import and Backup → Export Bookmarks to HTML.',
      'Save the HTML file.',
    ],
    carries: [
      'Title and URL of every bookmark.',
      'Tags you added in Firefox.',
      `${BROWSER_FOLDERS} Firefox's Bookmarks Menu, Bookmarks Toolbar, Other Bookmarks and Mobile Bookmarks folders are left out.`,
    ],
    leaves: ['Keywords and the Firefox backup format (.json) aren\'t read. Use the HTML export.'],
  },
  {
    slug: 'safari',
    name: 'Safari',
    summary: 'Export your Safari bookmarks from a Mac as an HTML file and import them with your folders as tags.',
    option: 'Safari Bookmarks (HTML)',
    file: 'an HTML file',
    steps: [
      'Use Safari on a Mac. Safari on iPhone and iPad can\'t export bookmarks, but bookmarks synced with iCloud appear on the Mac.',
      'Choose File → Export → Bookmarks.',
      'Save the HTML file Safari offers.',
    ],
    carries: [
      'Title and URL of every bookmark in the file.',
      `${BROWSER_FOLDERS} Safari's Favorites and Reading List folders aren't made into tags.`,
    ],
    leaves: ['Reading List previews aren\'t imported.'],
  },
  {
    slug: 'edge',
    name: 'Microsoft Edge',
    summary: 'Export your Edge favorites as an HTML file and import them into Tagstash with your folders as tags.',
    option: 'Google Chrome Bookmarks (HTML)',
    optionNote: 'Edge saves the same HTML format as Chrome, so choose the Chrome option.',
    file: 'an HTML file',
    steps: [
      'In Edge, open the favorites page: press Ctrl+Shift+O, or go to edge://favorites.',
      'Choose More options (…) and then Export favorites.',
      'Save the HTML file.',
    ],
    carries: [
      'Title and URL of every favorite.',
      `${BROWSER_FOLDERS} Edge's Favorites bar and Other favorites folders are left out.`,
    ],
    leaves: ['Collections in Edge aren\'t part of the favorites export.'],
  },
  {
    slug: 'raindrop',
    name: 'Raindrop.io',
    summary: 'Export your Raindrop.io bookmarks as a CSV file and import them with their tags, collections and excerpts.',
    option: 'Raindrop.io (CSV)',
    file: 'a CSV file',
    steps: [
      'Sign in to Raindrop.io on the web and open Settings → Backups.',
      'Click Create new, then wait for the email that says your backup is ready.',
      'Download the CSV file from the same Backups page. For a single collection, open it, click Export and choose CSV instead.',
    ],
    carries: [
      'Title and URL of every bookmark.',
      'Raindrop tags.',
      'The collection a bookmark is in becomes a tag. Unsorted is left out.',
      'The note, or the excerpt when there is no note, becomes the description.',
    ],
    leaves: ['Highlights, covers, favorites and creation dates aren\'t imported.'],
  },
  {
    slug: 'pocket',
    name: 'Pocket',
    summary: 'Pocket has shut down. If you saved a Pocket export, import its CSV or HTML file with your tags.',
    option: 'Pocket (CSV or HTML)',
    file: 'a CSV file or ril_export.html',
    intro: 'Pocket shut down in 2025 and no longer offers exports. This guide is for an export you already downloaded.',
    steps: [
      'Find your Pocket export. Newer exports are a CSV file with the columns title, url, time_added, tags and status. Older ones are a file called ril_export.html.',
      'If the export came as a zip file, unzip it first.',
    ],
    carries: [
      'Title and URL of every item. An item without a title uses its URL.',
      'Pocket tags.',
    ],
    leaves: ['Read and archived status, favorites and highlights aren\'t imported, and no tags are made from them.'],
  },
  {
    slug: 'pinboard',
    name: 'Pinboard',
    summary: 'Export your Pinboard bookmarks as JSON and import them with their tags and descriptions.',
    option: 'Pinboard.in (JSON)',
    file: 'a JSON file',
    steps: [
      'Sign in to Pinboard and open Settings → Backup.',
      'Download the JSON export.',
    ],
    carries: [
      'Title, URL and description of every bookmark.',
      'Pinboard tags.',
    ],
    leaves: ['Private and to-read flags aren\'t imported. Mark bookmarks private again in Tagstash if your profile is public.'],
  },
  {
    slug: 'instapaper',
    name: 'Instapaper',
    summary: 'Export your Instapaper articles as a CSV file and import them with your folders and tags.',
    option: 'Instapaper (CSV)',
    file: 'a CSV file',
    steps: [
      'Sign in to Instapaper on the web and open Settings.',
      'Under Export, choose Download .csv file.',
    ],
    carries: [
      'Title and URL of every article.',
      'Instapaper tags, and your own folders as tags. Unread, Archive and Starred are left out.',
      'Any text you selected when saving an article becomes its description.',
    ],
    leaves: ['Highlights, article text and read progress aren\'t imported.'],
  },
]

export const IMPORT_GUIDE_SLUGS = IMPORT_GUIDES.map(guide => guide.slug)

export const findImportGuide = slug => IMPORT_GUIDES.find(guide => guide.slug === slug) || null

// The Tagstash half of every guide. The page and the HowTo schema both use this list.
export const tagstashImportSteps = guide => [
  'Sign in to Tagstash and open Settings → Import / Export.',
  `Under Import from, choose ${guide.option}.${guide.optionNote ? ` ${guide.optionNote}` : ''}`,
  `Drop ${guide.file} on the upload area, or click it to browse.`,
  'Check the preview, then choose Import.',
]

export const IMPORT_HUB_META = {
  title: 'Import Bookmarks into Tagstash: Step-by-Step Guides',
  description: 'Move your bookmarks to Tagstash from Chrome, Firefox, Safari, Edge, Raindrop.io, Pocket, Pinboard or Instapaper. Folders and tags come along as tags.',
  path: '/import',
}

export const importGuideMeta = guide => ({
  title: `Import ${guide.name} Bookmarks into Tagstash`,
  description: guide.summary,
  path: `/import/${guide.slug}`,
})

// Every indexable path, for the Pages middleware and the sitemap.
export const IMPORT_GUIDE_PATHS = [IMPORT_HUB_META.path, ...IMPORT_GUIDES.map(guide => importGuideMeta(guide).path)]

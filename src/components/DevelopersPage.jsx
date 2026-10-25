import AppHeader from './AppHeader'
import AppFooter from './AppFooter'
import { version } from '../../package.json'
import { useDocumentMeta } from '../utils/useDocumentMeta'
import { DEVELOPERS_META } from '../utils/pageMeta'
import { API_DOC_ROUTES, API_DOC_LIMITS, API_DOC_POLICY, API_DOC_BUDGETS, API_DOC_ERRORS, API_DOC_BOOKMARK_EXAMPLE } from '../content/developersApi'
import './DevelopersPage.css'

const groups = [...new Set(API_DOC_ROUTES.map(route => route.group))]
const anchor = text => text.toLowerCase().replaceAll(' ', '-')
const limitLabels = {
  title: 'Title (after trimming)', url: 'URL (after normalization)', description: 'Description', note: 'Note',
  tagName: 'Each tag name', tagsPerBookmark: 'Tags per bookmark', apiKeyName: 'API key name in Settings',
  importBookmarks: 'Rows per import', bulkBookmarkIds: 'Ids per bulk request (before de-duplication)',
}

function CodeBlock({ children, label }) {
  return <pre tabIndex={0} aria-label={label}><code>{children}</code></pre>
}

// Shared by the public route and the build-time prerender. No router or auth is
// needed to render the reference, including when JavaScript is unavailable.
export function DevelopersView({ logoSrc = '/logo-dark.png', theme = 'slate', onSelectTheme = () => {} }) {
  return (
    <div className="developers-page">
      <AppHeader logoSrc={logoSrc} theme={theme} onSelectTheme={onSelectTheme}>
        <a href="/">Home</a>
        <a href="/features">Features</a>
        <a href="/settings">Settings</a>
      </AppHeader>
      <main id="main" tabIndex={-1} className="developers-main">
        <header className="developers-intro">
          <h1>Tagstash REST API</h1>
          <p>Read and edit your bookmark library from a script, or share public bookmarks on your own site.</p>
          <p>Base URL: <code>https://tagsta.sh/api</code>. Requests and responses use JSON.</p>
        </header>
        <div className="developers-layout">
          <nav className="developers-contents" aria-label="API documentation contents">
            <a href="#authentication">Get started</a>
            <a href="#bookmark-shape">Bookmark fields</a>
            {groups.map(group => <a key={group} href={`#${anchor(group)}`}>{group}</a>)}
            <a href="#limits">Limits and budgets</a>
            <a href="#errors">Errors</a>
            <a href="#public-profiles">Public profile API</a>
          </nav>
          <div className="developers-reference">
            <section id="authentication">
              <h2>Get started with a personal key</h2>
              <ol>
                <li>Sign in and open <a href="/settings">Settings</a> → API Keys.</li>
                <li>Optionally name the key, then select Generate API Key. You can have up to {API_DOC_POLICY.activeKeys} active keys.</li>
                <li>Copy the full key immediately. It is shown once; Tagstash stores only a SHA-256 hash and a short display hint. If you lose it, revoke it and generate another.</li>
              </ol>
              <p>Send <code>Authorization: Bearer &lt;key&gt;</code> on each library request. Keys start with <code>tsk_</code> followed by 48 lowercase hexadecimal characters. Keep the key in your server or script environment; a key embedded in a public website gives visitors access to your library.</p>
              <p>These examples use a POSIX shell. Set the environment variable to your own key, then read your library:</p>
              <CodeBlock label="Shell: configure your key and list bookmarks">{`export TAGSTASH_API_KEY='PASTE_YOUR_KEY_HERE'
curl --fail-with-body 'https://tagsta.sh/api/bookmarks' \\
  -H "Authorization: Bearer $TAGSTASH_API_KEY"`}</CodeBlock>
              <p>For nonempty JSON bodies, send <code>Content-Type: application/json</code>. A body must be a JSON object, not an array. Empty bodies are treated as an empty object by routes that parse JSON.</p>
              <CodeBlock label="Shell: save a bookmark">{`curl --fail-with-body 'https://tagsta.sh/api/bookmarks' \\
  -H "Authorization: Bearer $TAGSTASH_API_KEY" \\
  -H 'Content-Type: application/json' \\
  --data '{"title":"Example reference","url":"https://example.com/","description":"A useful reference","tags":["reference"]}'`}</CodeBlock>
              <p>Keys reach only the bookmark and tag routes listed below. They cannot manage your account, password, email, billing, keys, account deletion, library reset, admin actions or support. Create and revoke keys in Settings.</p>
              <p>Revoked or unknown keys, and keys for suspended, deleting or missing accounts, are refused. Changing your password in Settings, confirming an email change or signing out of all devices keeps keys active. A password reset through the forgot-password email revokes all active keys.</p>
              <p>Library endpoints use an origin allowlist for browser CORS. Use a server or command-line client for your integration. A personal key does not enable arbitrary cross-origin browser access; the keyless public profile API below does.</p>
            </section>

            <section id="bookmark-shape">
              <h2>Bookmark fields and writes</h2>
              <p><code>Bookmark</code> in this reference means the following JSON object. This is an illustrative response; ids and dates come from your account.</p>
              <CodeBlock label="JSON: bookmark response fields">{JSON.stringify(API_DOC_BOOKMARK_EXAMPLE, null, 2)}</CodeBlock>
              <p>Ids are numbers. Bookmark flags are integers (0 or 1). Description, note and favicon may be null. Database timestamps are UTC, usually <code>YYYY-MM-DD HH:MM:SS</code>; <code>deleted_at</code> is null for live bookmarks. Trash responses also include <code>expires_at</code>.</p>
              <p>Create and update accept <code>title</code>, <code>url</code>, <code>description</code>, <code>note</code> and <code>tags</code>. Title is trimmed. URLs must be HTTP(S); a missing scheme is prefixed with HTTPS, and bare roots keep a trailing slash. Title and URL are required for both POST and PUT. Omitting description on PUT clears it; omitting note or tags keeps the existing value.</p>
              <p><code>note</code> is a private Markdown note, up to {API_DOC_LIMITS.note.toLocaleString('en-US')} characters. Only you can read it: it is never included in your public profile, its API or the sitemap, even for public bookmarks. It is stored as sent (not trimmed) and returned as raw Markdown; rendering it safely is up to your client. Null or a blank string clears it.</p>
              <p>Tags are trimmed, lowercased, de-duplicated single words. Blank names are dropped. Null or an empty array clears tags. Invalid types, spaces inside a tag or limits exceeded reject a normal create/update with 400 before any write. Use the dedicated toggle endpoints for favorites and privacy; these flags are not create/update body fields.</p>
              <p>Success shapes below use type notation, such as <code>string</code>, <code>Bookmark[]</code> and <code>?</code> for an optional field. Actual responses are JSON objects.</p>
            </section>

            {groups.map(group => (
              <section id={anchor(group)} key={group}>
                <h2>{group}</h2>
                {API_DOC_ROUTES.filter(route => route.group === group).map(route => (
                  <article className="developers-endpoint" key={`${route.method} ${route.path}`}>
                    <h3>{route.title}</h3>
                    <p className="developers-route"><code>{route.method} {route.path}</code></p>
                    <dl>
                      <dt>Request</dt><dd>{route.request}</dd>
                      <dt>{route.status} response</dt><dd><code className="developers-shape">{route.response}</code></dd>
                      <dt>Behavior and errors</dt><dd>{route.errors} The shared errors below also apply.</dd>
                    </dl>
                  </article>
                ))}
                {group === 'Bookmarks' && <>
                  <p>To update or trash a bookmark, replace 123 with an id from your library:</p>
                  <CodeBlock label="Shell: update and trash a bookmark">{`curl --fail-with-body -X PUT 'https://tagsta.sh/api/bookmarks/123' \\
  -H "Authorization: Bearer $TAGSTASH_API_KEY" \\
  -H 'Content-Type: application/json' \\
  --data '{"title":"Updated reference","url":"https://example.com/","tags":["reading"]}'

curl --fail-with-body -X DELETE 'https://tagsta.sh/api/bookmarks/123' \\
  -H "Authorization: Bearer $TAGSTASH_API_KEY"`}</CodeBlock>
                </>}
                {group === 'Trash' && <>
                  <h3>Delete and restore behavior</h3>
                  <p>Delete moves bookmarks to the trash for {API_DOC_POLICY.retentionDays} days, with their tags. They disappear from live reads, tag counts and public profiles and stop counting toward the free plan. At the retention boundary they are treated as gone, even if physical cleanup has not run yet. Delete forever, purge and empty cannot be undone.</p>
                  <p>A new save or import of a URL in your trash replaces the trashed copy permanently. Restore preserves the saved fields and tags, subject to any tag edits made while the bookmark was trashed. A bulk restore that would exceed the free limit restores nothing.</p>
                  <p>On a self-hosted database before the trash migration, delete is permanent and returns <code>trashed: false</code>; the list returns <code>available: false</code>, and restore/purge/empty return 503. Check the response before offering undo.</p>
                  <CodeBlock label="Shell: restore a bookmark from trash">{`curl --fail-with-body -X POST 'https://tagsta.sh/api/bookmarks/123/restore' \\
  -H "Authorization: Bearer $TAGSTASH_API_KEY"`}</CodeBlock>
                </>}
                {group === 'Metadata and import' && <>
                  <h3>Import behavior</h3>
                  <p>Import skips invalid rows and URLs already in your live library or repeated in the request. Rows need nonblank string titles and valid HTTP(S) URLs. Invalid objects, field types and overlong URLs are skipped. Overlong titles, descriptions and notes are truncated; a non-string note makes the row invalid. Import lowercases tags and replaces whitespace with hyphens; non-string, overlong and surplus tags are dropped, while blank and duplicate tags are ignored.</p>
                  <p><code>truncated</code> counts rows changed by truncation; <code>droppedTags</code> counts discarded tag entries. <code>invalidRows</code> includes zero-based indexes and reasons for the first 20 invalid rows. <code>skipped</code> includes invalid, duplicate and over-limit rows. Accepted rows commit in chunks of up to 250. A failed chunk returns 500 with counts so far; retrying the same file skips already-imported URLs. Paid accounts receive <code>bookmark_limit: null</code>.</p>
                  <p>Use the library GET for export; there is no export endpoint. HTML/CSV parsing and output formats are handled by the web app, not these JSON routes.</p>
                  <CodeBlock label="Shell: import a JSON file">{`# bookmarks.json must contain {"bookmarks":[{"title":"Example","url":"https://example.com/","tags":["reading"]}]}
curl --fail-with-body 'https://tagsta.sh/api/bookmarks/import' \\
  -H "Authorization: Bearer $TAGSTASH_API_KEY" \\
  -H 'Content-Type: application/json' \\
  --data-binary @bookmarks.json`}</CodeBlock>
                </>}
              </section>
            ))}

            <section id="limits">
              <h2>Limits and per-account budgets</h2>
              <p>The free plan allows {API_DOC_POLICY.freeBookmarks} live bookmarks; paid accounts have no bookmark-count limit. Create returns 403 once full. Import returns 403 if already full, otherwise admits what fits and reports <code>limitReached: true</code> for the remainder. Restore returns 403 with <code>limitReached: true</code>, <code>restored: 0</code> and <code>remainingSlots</code> if it would exceed the limit. Trashed bookmarks do not use slots. Concurrent saves, imports and restores share the same limit.</p>
              <table>
                <caption>Input limits from the library API</caption>
                <thead><tr><th scope="col">Field</th><th scope="col">Maximum</th></tr></thead>
                <tbody>{Object.entries(API_DOC_LIMITS).map(([name, limit]) => <tr key={name}><th scope="row">{limitLabels[name]}</th><td>{limit}</td></tr>)}</tbody>
              </table>
              <p>String limits count JavaScript UTF-16 units. Tag count limits apply after normalizing and de-duplicating. Ordinary parsed JSON bodies are capped at {API_DOC_POLICY.jsonBytes.toLocaleString('en-US')} bytes (256 KiB); imports at {API_DOC_POLICY.importBytes.toLocaleString('en-US')} bytes (8 MiB).</p>
              <ul>
                <li>Page metadata: {API_DOC_BUDGETS.metadataFetchesBurst[1]} lookups per {API_DOC_BUDGETS.metadataFetchesBurst[2]} minutes and {API_DOC_BUDGETS.metadataFetchesDaily[1]} per 24 hours, shared by <code>/meta</code> and <code>/meta-description</code>.</li>
                <li>Imports: {API_DOC_BUDGETS.importsPerHour[1]} requests per hour.</li>
              </ul>
              <p>Budgets belong to the account, across keys and sessions, and count attempts after the budget check, including downstream failures. They use rolling windows and return 429 when exhausted. These are soft limits: simultaneous requests may overshoot, and a counter-storage failure allows requests through. There is no general requests-per-minute budget defined for the other library routes.</p>
              <p>Metadata fetches refuse private/local addresses and URL credentials, check every redirect (up to five), accept only HTML/XHTML and read at most 512 KiB, stopping at the end of the head, with an eight-second deadline. Scraped text is entity-decoded and clamped to bookmark field limits.</p>
            </section>

            <section id="errors">
              <h2>Errors and retrying</h2>
              <p>API errors are JSON with an <code>error</code> string. Some responses add fields, such as restore-limit details or import counts. Read the status and fields instead of matching message text.</p>
              <CodeBlock label="JSON: invalid key error">{'{ "error": "Invalid or expired token" }'}</CodeBlock>
              <dl className="developers-errors">{API_DOC_ERRORS.map(([status, description]) => <div key={status}><dt>{status}</dt><dd>{description}</dd></div>)}</dl>
              <p>Library responses use <code>Cache-Control: no-store</code>. There is no library idempotency-key mechanism: after an uncertain result, check the library before retrying a create. Favorite and privacy routes are toggles, so blindly retrying reverses a successful request. Bulk actions skip inaccessible ids rather than revealing other users’ data.</p>
            </section>

            <section id="public-profiles">
              <h2>Public profile API</h2>
              <p><code>GET /api/profiles/:username</code> is a stable, keyless endpoint for embedding public bookmarks on another website. Send no Authorization header or cookies. The owner must enable their public profile in Settings. Missing, private and suspended profiles all return the same 404 JSON error.</p>
              <p>Repeat <code>?tag=</code> to filter by tags; every tag must match (AND). Values are trimmed, lowercased and de-duplicated in first-seen order. The returned <code>tags</code> list always describes the entire public collection, even when bookmarks are filtered. Bookmarks are newest created_at first, with no pagination. Notes are never included.</p>
              <CodeBlock label="Shell: read public bookmarks matching two tags">{`# Replace USERNAME and the tag names with a public profile's values.
curl --fail-with-body --get 'https://tagsta.sh/api/profiles/USERNAME' \\
  --data-urlencode 'tag=reference' \\
  --data-urlencode 'tag=reading'`}</CodeBlock>
              <CodeBlock label="Public profile success shape">{`{
  profile: { username: string, member_since: string, indexable: boolean },
  bookmarks: [{
    id: number, title: string, url: string, description: string | null,
    favicon_url: string | null, created_at: string, updated_at: string,
    tags: [{ id: number, name: string }]
  }],
  tags: [{ name: string, count: number }],
  appliedTags: string[]
}`}</CodeBlock>
              <p>Only public, non-private, non-trashed bookmarks are included. This response omits owner ids, favorite/privacy flags and account contact details. <code>indexable</code> reports whether the public profile meets the search-indexing bar; it does not control whether you can fetch it.</p>
              <p>Browser CORS is <code>Access-Control-Allow-Origin: *</code>. Successful GET responses may be held in the Cloudflare edge cache for {API_DOC_POLICY.profileCacheSeconds} seconds, with <code>Cache-Control: public, max-age=0, s-maxage=60</code>. A recent edit, deletion, privacy change or suspension can remain visible for up to a minute; takedown is not instant. Errors are not cached.</p>
              <p>Up to 10 normalized tag filters of at most 100 characters each are cacheable; larger filters are served uncached. Cache keys include the username and normalized tags; extra query parameters, cookies and Authorization do not create fresh cache entries. Where the Cache API is available, <code>X-Tagstash-Cache: HIT</code> or <code>MISS</code> helps diagnose caching. A cache failure falls back to an uncached response.</p>
              <p>Success is 200; hidden or missing profiles return 404. Shared server errors also apply. No account key is needed for this endpoint.</p>
            </section>
          </div>
        </div>
      </main>
      <AppFooter version={version}>
        <a className="footer-privacy-link" href="/">Home</a>
        <a className="footer-privacy-link" href="/privacy">Privacy Policy</a>
        <a className="footer-privacy-link" href="/support">Support</a>
      </AppFooter>
    </div>
  )
}

export default function DevelopersPage(props) {
  useDocumentMeta(DEVELOPERS_META)
  return <DevelopersView {...props} />
}

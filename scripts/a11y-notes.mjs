// Bookmark notes (issues #60, #75), kept separate from the main audit like a11y-duplicates.mjs.
// The owner's live list is fetched for real and one bookmark gets a note added in the response,
// and every create/update is refused by an interception, so the seven-bookmark seed is never changed.
const NOTED_TITLE = 'Command line tools'
const NOTE = [
  '### Favourites',
  '',
  'Try **ripgrep** and _fd_ first. Run `rg --files` to list files.',
  '',
  '1. Install with a package manager',
  '2. Read the [ripgrep guide](https://example.org/rg-guide)',
  '',
  '- [ ] Compare with grep',
  '',
  '> Fast enough to search a whole monorepo.',
].join('\n')

export async function noteStates(page, scan, go) {
  let withNote = true
  let writeError = { status: 400, error: 'Note must be 10000 characters or less' }
  const listHandler = async (route) => {
    if (route.request().method() !== 'GET') {
      // Never create anything: the add form's save is always refused.
      return route.fulfill({ status: writeError.status, contentType: 'application/json', body: JSON.stringify({ error: writeError.error }) })
    }
    const response = await route.fetch()
    const body = await response.json()
    if (withNote) {
      body.bookmarks = body.bookmarks.map((bookmark) => (bookmark.title === NOTED_TITLE ? { ...bookmark, note: NOTE } : bookmark))
    }
    return route.fulfill({ response, json: body })
  }
  const itemHandler = async (route) => {
    if (route.request().method() !== 'PUT') return route.fallback()
    return route.fulfill({ status: writeError.status, contentType: 'application/json', body: JSON.stringify({ error: writeError.error }) })
  }
  await page.route('**/api/bookmarks', listHandler)
  await page.route('**/api/bookmarks/*', itemHandler)
  await go(page, '/')
  const cards = page.locator('.bookmark-card')
  await cards.nth(6).waitFor()
  const expectCards = async (count) => {
    await page.waitForFunction((n) => document.querySelectorAll('.bookmark-card').length === n, count)
  }

  // Collapsed by default, with a named toggle on only the bookmark that has a note.
  const noted = cards.filter({ hasText: NOTED_TITLE })
  const toggle = noted.getByRole('button', { name: 'Show note', exact: true })
  if ((await page.getByRole('button', { name: 'Show note', exact: true }).count()) !== 1) throw new Error('Only the bookmark with a note should offer Show note')
  if ((await toggle.getAttribute('aria-expanded')) !== 'false') throw new Error('A note should start collapsed')
  await scan('/ (bookmark with a note, collapsed)')

  await toggle.click()
  const body = noted.locator('.bookmark-note-body')
  await body.getByRole('link', { name: 'ripgrep guide' }).waitFor()
  const hideToggle = noted.getByRole('button', { name: 'Hide note', exact: true })
  if ((await hideToggle.getAttribute('aria-expanded')) !== 'true') throw new Error('Show note should expand the note')
  if (await body.locator('h1, h2, h3, h4, h5, h6, img, input, [style]').count()) throw new Error('Note Markdown must not add headings, images, inputs or inline styles')
  if ((await body.getByRole('link').getAttribute('rel')) !== 'noopener noreferrer ugc nofollow') throw new Error('Note links need rel="noopener noreferrer ugc nofollow"')
  await scan('/ (bookmark note expanded)')
  await hideToggle.click()

  // "Has note" filter: active (only the noted bookmark), then a search with no matches.
  const noteToggle = page.getByRole('button', { name: /^Has note/ })
  await noteToggle.click()
  await expectCards(1)
  if ((await noteToggle.getAttribute('aria-pressed')) !== 'true') throw new Error('Has note toggle is not pressed')
  await scan('/ (Has note filter active)')
  await page.getByRole('textbox', { name: 'Search bookmarks' }).fill('zzz-no-such-bookmark')
  await page.locator('.empty-state').waitFor()
  await scan('/ (Has note filter, no matches)')
  await page.getByRole('button', { name: 'Clear all filters' }).click()
  await expectCards(7)
  if ((await noteToggle.getAttribute('aria-pressed')) !== 'false') throw new Error('Clear all filters should release Has note')

  // The edit form carries the note; a refused save shows the server's error.
  await noted.getByRole('button', { name: 'Edit bookmark' }).click()
  const editNote = page.getByLabel('Note (private)', { exact: true })
  await editNote.waitFor()
  if ((await editNote.inputValue()) !== NOTE) throw new Error('The edit form should be prefilled with the note')
  await scan('/ (edit mode with a note)')
  writeError = { status: 503, error: "Notes can't be saved right now. Please try again later." }
  await page.locator('.bookmark-edit-actions').getByRole('button', { name: 'Save', exact: true }).click()
  await page.locator('.error-message').filter({ hasText: "Notes can't be saved right now." }).waitFor()
  await scan('/ (edit mode, note refused)')
  await page.getByRole('button', { name: 'Dismiss error', exact: true }).click()
  await page.locator('.bookmark-edit-actions').getByRole('button', { name: 'Cancel' }).first().click()

  // The add form with a note typed in, then a validation error from the server.
  await page.getByRole('button', { name: 'Add bookmark' }).click()
  const addNote = page.getByLabel('Note (optional, private)', { exact: true })
  await addNote.waitFor()
  await page.locator('#url').fill('https://example.net/note-audit')
  await page.locator('#title').fill('Note audit bookmark')
  await addNote.fill('A **private** note with a [link](https://example.net/more).')
  await scan('/ (add bookmark form with a note)')
  writeError = { status: 400, error: 'Note must be 10000 characters or less' }
  await page.getByRole('button', { name: 'Save bookmark', exact: true }).click()
  await page.locator('.error-message').filter({ hasText: 'Note must be 10000 characters or less' }).waitFor()
  await scan('/ (add bookmark form, note validation error)')
  await page.getByRole('button', { name: 'Dismiss error', exact: true }).click()
  await page.getByRole('button', { name: 'Cancel', exact: true }).first().click()

  // With no notes at all, the filter explains how to add one.
  withNote = false
  await go(page, '/')
  await cards.nth(6).waitFor()
  await noteToggle.click()
  await page.getByText('None of your bookmarks has a note yet.', { exact: false }).waitFor()
  await scan('/ (Has note filter, no notes yet)')

  await page.unroute('**/api/bookmarks', listHandler)
  await page.unroute('**/api/bookmarks/*', itemHandler)
  await go(page, '/')
  await cards.nth(6).waitFor()
}

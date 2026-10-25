// Kept separate from the main audit to limit shared-file changes. Fixtures replace the owner's
// live list only while visiting this view; the seven-bookmark seed and its count checks stay intact.
export async function duplicateStates(page, scan, go) {
  const original = [
    { id: 8101, title: 'Original guide', url: 'https://example.com/guide', created_at: '2026-08-01 10:00:00', tags: [{ id: 1, name: 'reading' }] },
    { id: 8102, title: 'Guide from a newsletter', url: 'http://www.example.com/guide/?utm_source=newsletter#intro', created_at: '2026-09-01 10:00:00', tags: [{ id: 2, name: 'guides' }], is_private: 1 },
  ]
  let items = []
  let refuse = true
  let pending = null
  let release = null
  let lastIds = []
  let bulkCalls = 0
  let listStatus = 200
  let listHold = null
  const listHandler = async (route) => {
    if (listHold) await listHold
    return route.fulfill({ status: listStatus, contentType: 'application/json', body: JSON.stringify(listStatus === 200 ? { bookmarks: items } : { error: 'Blocked by the duplicate accessibility audit' }) })
  }
  const bulkHandler = async (route) => {
    bulkCalls += 1
    // Every bulk call is intercepted, even unexpected operations. Never touch the seed.
    const path = new URL(route.request().url()).pathname
    const { ids } = route.request().postDataJSON() || {}
    if (route.request().method() !== 'POST' || !Array.isArray(ids) || ids.length < 1 || ids.length > 500 || ids.some((id) => !original.some((bookmark) => bookmark.id === id))) {
      await route.fulfill({ status: 400, contentType: 'application/json', body: JSON.stringify({ error: 'Invalid audit selection' }) })
      throw new Error('Duplicate cleanup sent an unexpected bulk selection')
    }
    lastIds = ids
    if (pending) await pending
    if (refuse || !['/api/bookmarks/bulk/delete', '/api/bookmarks/bulk/restore'].includes(path)) {
      return route.fulfill({ status: 403, contentType: 'application/json', body: JSON.stringify({ error: 'Blocked by the duplicate accessibility audit' }) })
    }
    const restoring = path.endsWith('/restore')
    items = restoring ? original : original.filter((bookmark) => !ids.includes(bookmark.id))
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ deleted: restoring ? 0 : ids.length, restored: restoring ? ids.length : 0, skipped: 0, trashed: true }) })
  }
  await page.route('**/api/bookmarks', listHandler)
  await page.route('**/api/bookmarks/bulk/**', bulkHandler)
  await go(page, '/duplicates')
  await page.getByText('No duplicates found in your live bookmarks.', { exact: true }).waitFor()
  await scan('/duplicates (empty)')

  items = original
  await page.getByRole('button', { name: 'Refresh duplicates', exact: true }).click()
  await page.getByRole('radio').first().waitFor()
  await scan('/duplicates (groups, no choice)')
  await page.getByText('How matching works', { exact: true }).click()
  await scan('/duplicates (matching rules)')
  await page.getByRole('radio', { name: 'Keep Original guide', exact: true }).check()
  await scan('/duplicates (selection)')
  await page.getByRole('button', { name: 'Keep newest', exact: true }).click()
  if (!await page.getByRole('radio', { name: 'Keep Guide from a newsletter', exact: true }).isChecked()) throw new Error('Keep newest chose the wrong bookmark')
  await page.getByRole('button', { name: 'Keep oldest', exact: true }).click()
  if (!await page.getByRole('radio', { name: 'Keep Original guide', exact: true }).isChecked()) throw new Error('Keep oldest chose the wrong bookmark')
  const move = page.getByRole('button', { name: 'Move 1 bookmark to trash', exact: true })
  await move.click()
  const confirmation = page.getByRole('group', { name: /^Move 1 bookmark to the trash\?/ })
  if ((await page.evaluate(() => document.activeElement?.textContent)) !== 'Cancel') throw new Error('Duplicate confirmation should focus Cancel')
  await scan('/duplicates (confirmation)')
  await confirmation.getByRole('button', { name: 'Cancel', exact: true }).click()
  await move.click()
  await confirmation.getByRole('button', { name: 'Move 1 bookmark to trash', exact: true }).click()
  await page.getByRole('alert').filter({ hasText: 'Blocked by the duplicate accessibility audit' }).waitFor()
  await scan('/duplicates (request refused)')
  if (lastIds.join(',') !== '8102') throw new Error('Cleanup must exclude the chosen keeper')

  refuse = false
  pending = new Promise((resolve) => { release = resolve })
  await confirmation.getByRole('button', { name: 'Move 1 bookmark to trash', exact: true }).click()
  await page.getByRole('button', { name: 'Moving…', exact: true }).waitFor()
  await scan('/duplicates (pending)')
  release()
  pending = null
  await page.getByRole('status').filter({ hasText: 'Moved 1 bookmark to the trash.' }).waitFor()
  await page.getByRole('button', { name: 'Undo', exact: true }).waitFor()
  if (!await page.evaluate(() => document.activeElement?.classList.contains('trash-notice'))) throw new Error('Duplicate cleanup should focus the result notice')
  await scan('/duplicates (result with Undo)')
  refuse = true
  await page.getByRole('button', { name: 'Undo', exact: true }).click()
  await page.getByRole('alert').filter({ hasText: 'Blocked by the duplicate accessibility audit' }).waitFor()
  await scan('/duplicates (Undo refused)')
  refuse = false
  await page.getByRole('button', { name: 'Undo', exact: true }).click()
  await page.getByRole('status').filter({ hasText: 'Restored 1 bookmark.' }).waitFor()
  if (lastIds.join(',') !== '8102') throw new Error('Undo must restore exactly the cleanup selection')
  await page.getByRole('radio').first().waitFor()
  await scan('/duplicates (restored)')
  listStatus = 500
  await page.getByRole('button', { name: 'Refresh duplicates', exact: true }).click()
  await page.getByRole('alert').filter({ hasText: 'Could not load your bookmarks.' }).waitFor()
  await scan('/duplicates (load error)')
  listStatus = 200
  listHold = new Promise((resolve) => { release = resolve })
  await page.getByRole('button', { name: 'Refresh duplicates', exact: true }).click()
  await page.getByText('Loading duplicates…', { exact: true }).waitFor()
  await scan('/duplicates (loading)')
  release()
  listHold = null
  await page.getByRole('radio').first().waitFor()
  // A refreshed group must not silently change an open confirmation's target ids.
  await page.getByRole('button', { name: 'Keep oldest', exact: true }).click()
  await move.click()
  items = [original[0], { ...original[1], id: 8103 }]
  await page.getByRole('button', { name: 'Refresh duplicates', exact: true }).click()
  await page.getByRole('radio', { name: 'Keep Guide from a newsletter', exact: true }).waitFor()
  const callsBefore = bulkCalls
  await confirmation.getByRole('button', { name: 'Move 1 bookmark to trash', exact: true }).click()
  await page.getByRole('alert').filter({ hasText: 'This group changed.' }).waitFor()
  if (bulkCalls !== callsBefore || await page.locator('input[type="radio"]:checked').count()) throw new Error('A changed group must require a new review without sending a bulk request')
  await scan('/duplicates (group changed during confirmation)')
  await page.unroute('**/api/bookmarks', listHandler)
  await page.unroute('**/api/bookmarks/bulk/**', bulkHandler)
}

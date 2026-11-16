// Retained with the paused accessibility suite. All inference is mocked.
export async function tagRecommendationStates(page, scan, go) {
  let reply
  const handler = route => new Promise(resolve => {
    reply = async (status, json) => { await route.fulfill({ status, json }); resolve() }
  })
  await page.route('**/api/bookmarks/suggest-tags', handler)
  // The audit seed is free; present a Pro account only in the intercepted me response.
  const me = async route => {
    const response = await route.fetch()
    const data = await response.json()
    data.user.membership_tier = 'paid'
    await route.fulfill({ response, json: data })
  }
  await page.route('**/api/auth/me', me)
  try {
    await go('/')
    await page.reload()
    await page.getByRole('button', { name: 'Add bookmark', exact: true }).click()
    await page.locator('#url').fill('https://example.test/guide')
    await page.locator('#title').fill('Guide')
    const control = page.locator('#add-bookmark-form .tag-recommendations')
    const suggest = control.getByRole('button', { name: 'Suggest tags', exact: true })
    await suggest.click()
    await control.getByText('Finding tag suggestions…', { exact: true }).waitFor()
    await scan('/ (AI suggestions pending)')
    await reply(200, { suggestions: ['reading', 'guides'] })
    await control.getByRole('button', { name: 'Add suggested tag reading', exact: true }).waitFor()
    await scan('/ (AI suggestions ready)')
    await page.locator('#title').fill('Changed guide')
    await suggest.click()
    await control.getByText('Finding tag suggestions…', { exact: true }).waitFor()
    await reply(429, { error: 'Rate limited' })
    await control.getByText(/Too many suggestions requested/).waitFor()
    await scan('/ (AI suggestions rate limited)')
    await suggest.click()
    await control.getByText('Finding tag suggestions…', { exact: true }).waitFor()
    await reply(503, { error: 'Unavailable' })
    await control.getByText(/AI tag suggestions are unavailable/).waitFor()
    await scan('/ (AI suggestions unavailable)')
    await page.getByRole('button', { name: 'Cancel', exact: true }).first().click()
  } finally {
    await page.unroute('**/api/bookmarks/suggest-tags', handler)
    await page.unroute('**/api/auth/me', me)
    await page.reload()
  }
}

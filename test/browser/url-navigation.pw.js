if (process.env.NODE_TEST_CONTEXT) { /* run via: npm run test:browser */ } else {
const { test, expect } = require('@playwright/test');

test.afterEach(async ({ request }) => {
  const res = await request.get('/api/list');
  const stories = await res.json();
  await Promise.all(stories.map(s => request.delete(`/api/story/${s.id}`)));
});

async function createStory(page, name = 'URL Test') {
  page.once('dialog', d => d.accept(name));
  await page.click('#btn-new');
  await expect(page.locator('#binder')).toBeVisible();
  await expect(page.locator('#editor')).not.toHaveAttribute('disabled');
}

test('opening a tile updates URL', async ({ page }) => {
  await page.goto('/');
  await createStory(page);

  const url = new URL(page.url());
  expect(url.pathname).toMatch(/^\/[^/]+\/tile\/.+/);
});

test('opening a highlight updates URL', async ({ page }) => {
  await page.goto('/');
  await createStory(page);

  await page.click('#btn-add-highlight');
  await expect(page.locator('#binder-highlights-list .tile-item')).toHaveCount(1);
  await page.locator('#binder-highlights-list .tile-item').first().click();

  const url = new URL(page.url());
  expect(url.pathname).toMatch(/^\/[^/]+\/highlight\/.+/);
});

test('back button updates URL to /', async ({ page }) => {
  await page.goto('/');
  await createStory(page);

  await page.click('#btn-back');
  await expect(page.locator('#story-list')).toBeVisible();

  expect(new URL(page.url()).pathname).toBe('/');
});

test('browser back navigates between tiles', async ({ page }) => {
  await page.goto('/');
  await createStory(page);

  // Add a second tile
  await page.click('#btn-add-tile');
  await expect(page.locator('#binder-tiles-list .tile-item')).toHaveCount(2);

  await page.locator('#binder-tiles-list .tile-item').nth(0).click();
  const url0 = page.url();

  await page.locator('#binder-tiles-list .tile-item').nth(1).click();
  const url1 = page.url();

  expect(url0).not.toBe(url1);

  await page.goBack();
  await expect(page.locator('#editor')).not.toHaveAttribute('disabled');
  expect(page.url()).toBe(url0);
});

test('browser forward re-opens tile after back', async ({ page }) => {
  await page.goto('/');
  await createStory(page);
  const urlTile1 = page.url();

  // Add a second tile — it auto-opens, giving a second URL
  await page.click('#btn-add-tile');
  await expect(page.locator('#binder-tiles-list .tile-item')).toHaveCount(2);
  const urlTile2 = page.url();
  expect(urlTile1).not.toBe(urlTile2);

  await page.goBack();
  await expect(page.locator('#editor')).not.toHaveAttribute('disabled');
  expect(page.url()).not.toBe(urlTile2);

  await page.goForward();
  await expect(page.locator('#editor')).not.toHaveAttribute('disabled');
  expect(page.url()).toBe(urlTile2);
});

test('deep link to tile opens correct tile', async ({ page }) => {
  await page.goto('/');
  await createStory(page);
  const tileUrl = page.url();
  expect(tileUrl).toMatch(/\/[^/]+\/tile\/.+/);

  // Navigate away then visit the deep link directly
  await page.goto('/');
  await page.goto(tileUrl, { waitUntil: 'networkidle' });

  // URL stays at the tile URL (replaceState keeps it there)
  await expect(page).toHaveURL(tileUrl);
  // Editor becomes enabled once the tile is loaded
  await expect(page.locator('#editor')).not.toHaveAttribute('disabled');
});

test('deep link to highlight opens correct highlight', async ({ page }) => {
  await page.goto('/');
  await createStory(page);

  await page.click('#btn-add-highlight');
  await expect(page.locator('#binder-highlights-list .tile-item')).toHaveCount(1);
  await page.locator('#binder-highlights-list .tile-item').first().click();
  const hlUrl = page.url();
  expect(hlUrl).toMatch(/\/[^/]+\/highlight\/.+/);

  await page.goto('/');
  await page.goto(hlUrl, { waitUntil: 'networkidle' });

  await expect(page).toHaveURL(hlUrl);
  await expect(page.locator('#editor')).not.toHaveAttribute('disabled');
});

test('deep link to story root opens first tile', async ({ page }) => {
  await page.goto('/');
  await createStory(page, 'Story Root Test');

  // Extract story name from tile URL path
  const tileUrl = new URL(page.url());
  const storyName = decodeURIComponent(tileUrl.pathname.split('/')[1]);

  await page.goto('/');
  await page.goto(`/${encodeURIComponent(storyName)}`, { waitUntil: 'networkidle' });

  // showBinder with no targetTile calls openTile which pushes the tile URL
  await expect(page).toHaveURL(/\/[^/]+\/tile\/.+/);
  await expect(page.locator('#editor')).not.toHaveAttribute('disabled');
});

test('deep link to nonexistent story falls back to story list', async ({ page }) => {
  await page.goto('/nonexistent-story-xyz/tile/foo.md', { waitUntil: 'networkidle' });

  // replaceState changes URL to / and binder stays hidden
  await expect(page).toHaveURL('/');
  await expect(page.locator('#binder')).toBeHidden();
});
}

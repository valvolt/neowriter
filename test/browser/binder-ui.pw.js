if (process.env.NODE_TEST_CONTEXT) { /* run via: npm run test:browser */ } else {
const { test, expect } = require('@playwright/test');

test.afterEach(async ({ request }) => {
  const res = await request.get('/api/list');
  const stories = await res.json();
  await Promise.all(stories.map(s => request.delete(`/api/story/${s.id}`)));
});

async function createStory(page, name = 'Binder UI Test') {
  page.once('dialog', d => d.accept(name));
  await page.click('#btn-new');
  await expect(page.locator('#binder')).toBeVisible();
  await expect(page.locator('#editor')).not.toHaveAttribute('disabled');
}

// ---- Scrollable binder ----

test('binder scrolls when tiles overflow visible area', async ({ page }) => {
  await page.goto('/');
  await createStory(page, 'Scroll Test');

  const listRes = await page.request.get('/api/list');
  const stories = await listRes.json();
  const story = stories.find(s => s.name === 'Scroll Test');

  // Add 20 tiles directly via API — faster than clicking + 20 times
  for (let i = 0; i < 20; i++) {
    await page.request.post(`/api/story/${story.id}/tiles`, { data: {} });
  }

  // Reload so the binder renders all 21 tiles from the deep-link URL
  await page.reload({ waitUntil: 'networkidle' });
  await expect(page.locator('#binder-tiles-list .tile-item')).toHaveCount(21);

  // .binder-scroll must overflow (scroll) rather than clip
  const isScrollable = await page.evaluate(() => {
    const el = document.querySelector('.binder-scroll');
    return el.scrollHeight > el.clientHeight;
  });
  expect(isScrollable).toBe(true);

  // Clicking a tile that is below the fold must still work
  await page.locator('#binder-tiles-list .tile-item').last().click();
  await expect(page.locator('#editor')).not.toHaveAttribute('disabled');
});

test('binder scrolls when highlights overflow visible area', async ({ page }) => {
  await page.goto('/');
  await createStory(page, 'Highlight Scroll Test');

  const listRes = await page.request.get('/api/list');
  const stories = await listRes.json();
  const story = stories.find(s => s.name === 'Highlight Scroll Test');

  for (let i = 0; i < 20; i++) {
    await page.request.post(`/api/story/${story.id}/highlights`, { data: {} });
  }

  await page.reload({ waitUntil: 'networkidle' });
  await expect(page.locator('#binder-highlights-list .tile-item')).toHaveCount(20);

  const isScrollable = await page.evaluate(() => {
    const el = document.querySelector('.binder-scroll');
    return el.scrollHeight > el.clientHeight;
  });
  expect(isScrollable).toBe(true);

  await page.locator('#binder-highlights-list .tile-item').last().click();
  await expect(page.locator('#editor')).not.toHaveAttribute('disabled');
});

// ---- Rename from breadcrumb ----

test('clicking story name in breadcrumb renames the story', async ({ page }) => {
  await page.goto('/');
  await createStory(page, 'Old Story Name');

  page.once('dialog', d => d.accept('Renamed Story'));
  await page.locator('#open-story-name .breadcrumb-part').first().click();

  await expect(page.locator('#open-story-name')).toContainText('Renamed Story');

  // Go back and verify the story list reflects the new name
  await page.click('#btn-back');
  await expect(page.locator('#story-list')).toContainText('Renamed Story');
});

test('story rename from breadcrumb updates the URL', async ({ page }) => {
  await page.goto('/');
  await createStory(page, 'Old URL Story');

  page.once('dialog', d => d.accept('New URL Story'));
  await page.locator('#open-story-name .breadcrumb-part').first().click();

  await expect(page).toHaveURL(/New%20URL%20Story/);
});

test('clicking tile name in breadcrumb renames the tile', async ({ page }) => {
  await page.goto('/');
  await createStory(page);

  page.once('dialog', d => d.accept('My Renamed Tile'));
  // .last() is the tile-name part; .first() is the story-name part
  await page.locator('#open-story-name .breadcrumb-part').last().click();

  await expect(page.locator('#open-story-name')).toContainText('My Renamed Tile');
  await expect(page.locator('#binder-tiles-list .tile-item').first()).toContainText('My Renamed Tile');
});

test('clicking highlight name in breadcrumb renames the highlight', async ({ page }) => {
  await page.goto('/');
  await createStory(page);

  await page.click('#btn-add-highlight');
  await expect(page.locator('#binder-highlights-list .tile-item')).toHaveCount(1);
  await page.locator('#binder-highlights-list .tile-item').first().click();
  await expect(page.locator('#editor')).not.toHaveAttribute('disabled');

  page.once('dialog', d => d.accept('My Renamed Highlight'));
  await page.locator('#open-story-name .breadcrumb-part').last().click();

  await expect(page.locator('#open-story-name')).toContainText('My Renamed Highlight');
  await expect(page.locator('#binder-highlights-list .tile-item').first()).toContainText('My Renamed Highlight');
});

test('canceling rename prompt leaves the name unchanged', async ({ page }) => {
  await page.goto('/');
  await createStory(page, 'Keep This Name');

  page.once('dialog', d => d.dismiss());
  await page.locator('#open-story-name .breadcrumb-part').first().click();

  await expect(page.locator('#open-story-name')).toContainText('Keep This Name');
});
}

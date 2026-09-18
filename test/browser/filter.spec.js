const { test, expect } = require('@playwright/test');

test.beforeEach(async ({ request }) => {
  const res = await request.get('/api/list');
  const stories = await res.json();
  await Promise.all(stories.map(s => request.delete(`/api/story/${s.id}`)));
});

// --- Helpers ---

async function createStoryWithContent(request, name, tileContent = '') {
  const res = await request.post('/api/create', { data: { name } });
  const story = await res.json();
  if (tileContent) {
    await request.post(`/api/story/${story.id}/tiles/chapter-1.md/save`, {
      data: { content: tileContent }
    });
  }
  return story;
}

async function openStory(page, name) {
  await page.locator(`#story-list .story-name:text("${name}")`).click();
  await expect(page.locator('#binder')).toBeVisible();
}

// ============================================================================
// Filter: story list
// ============================================================================

test('filter input is visible in the header', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('#filter-input')).toBeVisible();
});

test('filter hides stories whose name does not match', async ({ request, page }) => {
  await createStoryWithContent(request, 'Alpha Story');
  await createStoryWithContent(request, 'Beta Story');

  await page.goto('/');
  await expect(page.locator('#story-list li')).toHaveCount(2);

  await page.fill('#filter-input', 'Alpha');
  await page.waitForTimeout(400); // debounce

  await expect(page.locator('#story-list li')).toHaveCount(1);
  await expect(page.locator('#story-list .story-name')).toHaveText('Alpha Story');
});

test('filter shows story whose tile content matches even if name does not', async ({ request, page }) => {
  await createStoryWithContent(request, 'Red Story', 'The forest is dark and deep.');
  await createStoryWithContent(request, 'Blue Story', 'The ocean is wide and vast.');

  await page.goto('/');
  await page.fill('#filter-input', 'forest');
  await page.waitForTimeout(400);

  await expect(page.locator('#story-list li')).toHaveCount(1);
  await expect(page.locator('#story-list .story-name')).toHaveText('Red Story');
});

test('clearing the filter restores all stories', async ({ request, page }) => {
  await createStoryWithContent(request, 'Story A');
  await createStoryWithContent(request, 'Story B');

  await page.goto('/');
  await page.fill('#filter-input', 'Story A');
  await page.waitForTimeout(400);
  await expect(page.locator('#story-list li')).toHaveCount(1);

  await page.fill('#filter-input', '');
  await page.waitForTimeout(400);
  await expect(page.locator('#story-list li')).toHaveCount(2);
});

test('filter with no matches shows empty story list', async ({ request, page }) => {
  await createStoryWithContent(request, 'My Story');

  await page.goto('/');
  await page.fill('#filter-input', 'zzznomatch');
  await page.waitForTimeout(400);

  await expect(page.locator('#story-list li')).toHaveCount(0);
});

test('filter is case-insensitive', async ({ request, page }) => {
  await createStoryWithContent(request, 'Adventure Time');

  await page.goto('/');
  await page.fill('#filter-input', 'adventure');
  await page.waitForTimeout(400);

  await expect(page.locator('#story-list .story-name')).toHaveText('Adventure Time');
});

test('matching text in story name is wrapped in <mark>', async ({ request, page }) => {
  await createStoryWithContent(request, 'The Forest Path');

  await page.goto('/');
  await page.fill('#filter-input', 'Forest');
  await page.waitForTimeout(400);

  // The matched substring should be inside a <mark> element
  const mark = page.locator('#story-list .story-name mark');
  await expect(mark).toHaveCount(1);
  await expect(mark).toHaveText('Forest');
});

test('matching text in tile name is wrapped in <mark>', async ({ request, page }) => {
  const story = await createStoryWithContent(request, 'Mark Test Story', '');

  await page.goto('/');
  await openStory(page, 'Mark Test Story');

  // chapter-1 tile name contains "chapter" — filter on it
  await page.fill('#filter-input', 'chapter');
  await page.waitForTimeout(400);

  const mark = page.locator('#binder-tiles-list .tile-name mark');
  await expect(mark).toHaveCount(1);
  await expect(mark).toHaveText('chapter');
});

// ============================================================================
// Filter: binder (tiles and highlights)
// ============================================================================

test('filter hides non-matching tiles in binder', async ({ request, page }) => {
  const story = await createStoryWithContent(request, 'Filter Tiles Test', 'unique-keyword here');

  // Add a second tile with different content
  await request.post(`/api/story/${story.id}/tiles`, { data: {} });
  await request.post(`/api/story/${story.id}/tiles/chapter-2.md/save`, {
    data: { content: 'completely different content' }
  });

  await page.goto('/');
  await openStory(page, 'Filter Tiles Test');

  // Without filter: both tiles visible
  await expect(page.locator('#binder-tiles-list li')).toHaveCount(2);

  // Apply filter that matches only chapter-1 content
  await page.fill('#filter-input', 'unique-keyword');
  await page.waitForTimeout(400);

  await expect(page.locator('#binder-tiles-list li')).toHaveCount(1);
});

test('filter shows "No matching tiles" placeholder when no tiles match', async ({ request, page }) => {
  await createStoryWithContent(request, 'Empty Filter Test', 'some content here');

  await page.goto('/');
  await openStory(page, 'Empty Filter Test');

  await page.fill('#filter-input', 'zzznomatch');
  await page.waitForTimeout(400);

  await expect(page.locator('#binder-tiles-list')).toContainText('No matching tiles');
});

test('clearing filter in binder restores all tiles', async ({ request, page }) => {
  const story = await createStoryWithContent(request, 'Restore Test', 'first tile');
  await request.post(`/api/story/${story.id}/tiles`, { data: {} });
  await request.post(`/api/story/${story.id}/tiles/chapter-2.md/save`, {
    data: { content: 'second tile' }
  });

  await page.goto('/');
  await openStory(page, 'Restore Test');

  await page.fill('#filter-input', 'first');
  await page.waitForTimeout(400);
  await expect(page.locator('#binder-tiles-list li')).toHaveCount(1);

  await page.fill('#filter-input', '');
  await page.waitForTimeout(400);
  await expect(page.locator('#binder-tiles-list li')).toHaveCount(2);
});

test('filter persists when navigating from story list into binder', async ({ request, page }) => {
  await createStoryWithContent(request, 'Persist Story', 'matching-word appears here');
  await createStoryWithContent(request, 'Other Story', 'nothing relevant');

  await page.goto('/');
  await page.fill('#filter-input', 'matching-word');
  await page.waitForTimeout(400);

  // Only Persist Story visible in story list
  await expect(page.locator('#story-list li')).toHaveCount(1);

  // Open the matching story
  await page.locator('#story-list .story-name').click();
  await expect(page.locator('#binder')).toBeVisible();

  // Tile with matching content should be shown
  await expect(page.locator('#binder-tiles-list li')).toHaveCount(1);
});

test('newly added tile is visible even when filter is active', async ({ request, page }) => {
  await createStoryWithContent(request, 'New Tile Test', 'first content');

  await page.goto('/');
  await openStory(page, 'New Tile Test');

  // Filter to show only the first tile
  await page.fill('#filter-input', 'first content');
  await page.waitForTimeout(400);
  await expect(page.locator('#binder-tiles-list li')).toHaveCount(1);

  // Add new tile — should appear immediately regardless of filter
  await page.click('#btn-add-tile');
  await expect(page.locator('#binder-tiles-list li')).toHaveCount(2);
});

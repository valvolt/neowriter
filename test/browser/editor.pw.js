if (process.env.NODE_TEST_CONTEXT) { /* run via: npm run test:browser */ } else {
const { test, expect } = require('@playwright/test');

test.beforeEach(async ({ request }) => {
  const res = await request.get('/api/list');
  const stories = await res.json();
  await Promise.all(stories.map(s => request.delete(`/api/story/${s.id}`)));
});

// Opens a new story and returns to a state where the binder is visible
async function openNewStory(page, name = 'Editor Test') {
  page.once('dialog', d => d.accept(name));
  await page.click('#btn-new');
  await expect(page.locator('#binder')).toBeVisible();
}

test('new story has one tile auto-created', async ({ page }) => {
  await page.goto('/');
  await openNewStory(page);

  await expect(page.locator('#binder-tiles-list li')).toHaveCount(1);
});

test('editor is disabled until a tile is opened', async ({ page }) => {
  await page.goto('/');
  // Before any story: editor is not editable
  await expect(page.locator('#editor')).toHaveAttribute('disabled', '');

  await openNewStory(page);
  // After creating a story the first tile is auto-opened, so editor is now editable
  await expect(page.locator('#editor')).not.toHaveAttribute('disabled');
});

test('clicking a tile activates the editor', async ({ page }) => {
  await page.goto('/');
  // Create story; this auto-opens the first tile
  await openNewStory(page);

  // Navigate away and back to force a manual tile click
  await page.click('#btn-back');
  await page.locator('#story-list .story-name').click();
  await expect(page.locator('#editor')).toHaveAttribute('disabled', '');

  await page.locator('#binder-tiles-list li').first().click();
  await expect(page.locator('#editor')).not.toHaveAttribute('disabled');
});

test('typing markdown updates the preview', async ({ page }) => {
  await page.goto('/');
  await openNewStory(page);
  // First tile auto-opens; editor is editable
  await expect(page.locator('#editor')).not.toHaveAttribute('disabled');

  await page.fill('#editor', '# Hello World\n\nSome paragraph text.');
  // Dispatch input so the app's event handler fires
  await page.dispatchEvent('#editor', 'input');

  await expect(page.locator('#preview h1')).toHaveText('Hello World');
  await expect(page.locator('#preview p')).toHaveText('Some paragraph text.');
});

test('stats show word and char counts', async ({ page }) => {
  await page.goto('/');
  await openNewStory(page);
  await expect(page.locator('#editor')).not.toHaveAttribute('disabled');

  await page.fill('#editor', 'hello world');
  await page.dispatchEvent('#editor', 'input');

  await expect(page.locator('#stats')).toContainText('Words: 2');
  await expect(page.locator('#stats')).toContainText('Chars: 11');
});

test('add tile creates a new tile in the binder', async ({ page }) => {
  await page.goto('/');
  await openNewStory(page);

  const before = await page.locator('#binder-tiles-list li').count();

  await page.click('#btn-add-tile');

  await expect(page.locator('#binder-tiles-list li')).toHaveCount(before + 1);
});

test('second tile opens in the editor', async ({ page }) => {
  await page.goto('/');
  await openNewStory(page);

  await page.click('#btn-add-tile');

  // New tile should be active in the editor
  await expect(page.locator('#editor')).not.toHaveAttribute('disabled');
  await expect(page.locator('#binder-tiles-list .active')).toHaveCount(1);
});

test('editor content is saved and reloaded', async ({ page }) => {
  await page.goto('/');
  await openNewStory(page, 'Save Test');
  await expect(page.locator('#editor')).not.toHaveAttribute('disabled');

  await page.fill('#editor', 'Persistent content');
  await page.dispatchEvent('#editor', 'input');

  // Navigate away and back
  await page.click('#btn-back');
  await page.locator('#story-list .story-name').click();
  await page.locator('#binder-tiles-list li').first().click();

  // Content should have been saved
  await expect(page.locator('#editor')).toContainText('Persistent content');
});

// publish toggle is only visible in hosted mode (window.local_mode === false)
// and cannot be tested against the LOCAL mode server used here
test.skip('publish toggle changes button state (hosted mode only)', async ({ page }) => {
  await page.goto('/');
  await openNewStory(page, 'Publish Test');

  const toggleBtn = page.locator('#toggle-publish');
  await expect(toggleBtn).toBeVisible();

  const before = await toggleBtn.textContent();
  await toggleBtn.click();
  const after = await toggleBtn.textContent();

  expect(after).not.toBe(before);
});
}

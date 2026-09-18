const { test, expect } = require('@playwright/test');

// Clean all stories before each test for a predictable starting state
test.beforeEach(async ({ request }) => {
  const res = await request.get('/api/list');
  const stories = await res.json();
  await Promise.all(stories.map(s => request.delete(`/api/story/${s.id}`)));
});

test('page loads with empty story list', async ({ page }) => {
  await page.goto('/');
  await expect(page).toHaveTitle('Neo Writer');
  await expect(page.locator('#story-list')).toBeVisible();
  await expect(page.locator('#story-list li')).toHaveCount(0);
});

test('create story opens binder', async ({ page }) => {
  await page.goto('/');
  page.once('dialog', d => d.accept('My Story'));
  await page.click('#btn-new');

  await expect(page.locator('#binder')).toBeVisible();
  await expect(page.locator('#binder-story-name')).toHaveText('My Story');
});

test('back button returns to story list', async ({ page }) => {
  await page.goto('/');
  page.once('dialog', d => d.accept('Back Test'));
  await page.click('#btn-new');
  await page.click('#btn-back');

  await expect(page.locator('#binder')).toBeHidden();
  await expect(page.locator('#story-list .story-name')).toHaveText('Back Test');
});

test('story appears in list after creation', async ({ page }) => {
  await page.goto('/');
  page.once('dialog', d => d.accept('Listed Story'));
  await page.click('#btn-new');
  await page.click('#btn-back');

  await expect(page.locator('#story-list li')).toHaveCount(1);
  await expect(page.locator('#story-list .story-name')).toHaveText('Listed Story');
});

test('clicking story name opens binder', async ({ page }) => {
  await page.goto('/');
  page.once('dialog', d => d.accept('Open Test'));
  await page.click('#btn-new');
  await page.click('#btn-back');

  await page.locator('#story-list .story-name').click();
  await expect(page.locator('#binder')).toBeVisible();
  await expect(page.locator('#binder-story-name')).toHaveText('Open Test');
});

test('rename story updates list', async ({ page }) => {
  await page.goto('/');
  page.once('dialog', d => d.accept('Original Name'));
  await page.click('#btn-new');
  await page.click('#btn-back');

  page.once('dialog', d => d.accept('Renamed Story'));
  await page.locator('#story-list .btn-rename').click();

  await expect(page.locator('#story-list .story-name')).toHaveText('Renamed Story');
});

test('cancel rename keeps original name', async ({ page }) => {
  await page.goto('/');
  page.once('dialog', d => d.accept('Keep Me'));
  await page.click('#btn-new');
  await page.click('#btn-back');

  page.once('dialog', d => d.dismiss());
  await page.locator('#story-list .btn-rename').click();

  await expect(page.locator('#story-list .story-name')).toHaveText('Keep Me');
});

test('delete story removes it from list', async ({ page }) => {
  await page.goto('/');
  page.once('dialog', d => d.accept('To Delete'));
  await page.click('#btn-new');
  await page.click('#btn-back');

  page.once('dialog', d => d.accept()); // confirm dialog
  await page.locator('#story-list .btn-delete').click();

  await expect(page.locator('#story-list li')).toHaveCount(0);
});

test('cancel delete keeps story', async ({ page }) => {
  await page.goto('/');
  page.once('dialog', d => d.accept('Keep Story'));
  await page.click('#btn-new');
  await page.click('#btn-back');

  page.once('dialog', d => d.dismiss());
  await page.locator('#story-list .btn-delete').click();

  await expect(page.locator('#story-list li')).toHaveCount(1);
});

test('multiple stories are listed in alphabetical order', async ({ page }) => {
  await page.goto('/');

  page.once('dialog', d => d.accept('Zebra'));
  await page.click('#btn-new');
  await expect(page.locator('#binder')).toBeVisible();
  await page.click('#btn-back');

  page.once('dialog', d => d.accept('Apple'));
  await page.click('#btn-new');
  await expect(page.locator('#binder')).toBeVisible();
  await page.click('#btn-back');

  await expect(page.locator('#story-list .story-name')).toHaveCount(2);
  const names = await page.locator('#story-list .story-name').allTextContents();
  expect(names).toEqual(['Apple', 'Zebra']);
});

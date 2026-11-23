if (process.env.NODE_TEST_CONTEXT) { /* run via: npm run test:browser */ } else {
const { test, expect } = require('@playwright/test');

test.afterEach(async ({ request }) => {
  const res = await request.get('/api/list');
  const stories = await res.json();
  await Promise.all(stories.map(s => request.delete(`/api/story/${s.id}`)));
});

async function createStoryWithTile(page, name = 'Export Test') {
  page.once('dialog', d => d.accept(name));
  await page.click('#btn-new');
  await expect(page.locator('#editor')).not.toHaveAttribute('disabled');
  await page.locator('#editor').fill('Hello export world.');
  // Wait for autosave
  await page.waitForTimeout(600);
}

async function openExportDropdown(page) {
  await expect(page.locator('#export-btn-wrap')).toBeVisible();
  await page.click('#btn-export-story');
  await expect(page.locator('#export-dropdown')).toBeVisible();
}

// --- ZIP ---

test('Export ↓ button is hidden on story list', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('#export-btn-wrap')).toBeHidden();
});

test('Export ↓ button appears when a story is open', async ({ page }) => {
  await page.goto('/');
  await createStoryWithTile(page, 'Export Visible');
  await expect(page.locator('#export-btn-wrap')).toBeVisible();
});

test('Export dropdown closes when clicking outside', async ({ page }) => {
  await page.goto('/');
  await createStoryWithTile(page, 'Dropdown Close');
  await openExportDropdown(page);
  await page.click('header');
  await expect(page.locator('#export-dropdown')).toBeHidden();
});

test('Export .zip triggers a zip download with story name in filename', async ({ page }) => {
  await page.goto('/');
  await createStoryWithTile(page, 'Zip Story');
  await openExportDropdown(page);

  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.click('#export-opt-zip'),
  ]);

  expect(download.suggestedFilename()).toMatch(/zip-story.*\.zip$/i);
});

// --- PDF ---

test('Export PDF triggers a pdf download with story name in filename', async ({ page }) => {
  await page.goto('/');
  await createStoryWithTile(page, 'Pdf Story');
  await openExportDropdown(page);

  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.click('#export-opt-pdf'),
  ]);

  const filename = download.suggestedFilename();
  expect(filename).toMatch(/pdf.story.*\.pdf$/i);
});

test('Export PDF download is a valid PDF (starts with %PDF)', async ({ page }) => {
  await page.goto('/');
  await createStoryWithTile(page, 'Pdf Content');
  await openExportDropdown(page);

  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.click('#export-opt-pdf'),
  ]);

  const stream = await download.createReadStream();
  const header = await new Promise((resolve, reject) => {
    const chunks = [];
    stream.on('data', c => chunks.push(c));
    stream.on('end', () => resolve(Buffer.concat(chunks).slice(0, 5).toString('ascii')));
    stream.on('error', reject);
  });
  expect(header).toBe('%PDF-');
});
}

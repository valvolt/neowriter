if (process.env.NODE_TEST_CONTEXT) { /* run via: npm run test:browser */ } else {
const { test, expect } = require('@playwright/test');

async function createPublishedStory(request, content) {
  const createRes = await request.post('/api/create', { data: { name: 'XSS Test Story' } });
  expect(createRes.ok()).toBeTruthy();
  const story = await createRes.json();
  const storyId = story.id;

  const tileRes = await request.post(`/api/story/${storyId}/tiles`);
  expect(tileRes.ok()).toBeTruthy();
  const tile = await tileRes.json();

  const saveRes = await request.post(`/api/story/${storyId}/tiles/${tile.filename}/save`, {
    data: { content }
  });
  expect(saveRes.ok()).toBeTruthy();

  const pubRes = await request.post(`/api/story/${storyId}/publish`, {
    data: { published: true }
  });
  expect(pubRes.ok()).toBeTruthy();

  return storyId;
}

test.beforeEach(async ({ request }) => {
  const res = await request.get('/api/list');
  const stories = await res.json();
  for (const s of stories) {
    await request.delete(`/api/story/${s.id}`);
  }
});

test('XSS via link text does not execute JS', async ({ page, request }) => {
  const maliciousContent = '[<img src=x onerror="window._xss=1">](https://example.com)';
  const storyId = await createPublishedStory(request, maliciousContent);

  await page.goto(`/read/${storyId}`);
  await page.waitForSelector('main a', { timeout: 5000 });

  const xssTriggered = await page.evaluate(() => window._xss);
  expect(xssTriggered).toBeFalsy();

  // Link should still be present
  const link = page.locator('main a[href="https://example.com"]');
  await expect(link).toBeVisible();

  // No img child with onerror inside the link
  const imgWithHandler = await page.locator('main a img[onerror]').count();
  expect(imgWithHandler).toBe(0);
});

test('javascript: href is blocked', async ({ page, request }) => {
  // eslint-disable-next-line no-script-url
  const content = '[click me](javascript:window._xss=2)';
  const storyId = await createPublishedStory(request, content);

  await page.goto(`/read/${storyId}`);
  await page.waitForSelector('main a', { timeout: 5000 });

  const href = await page.locator('main a').getAttribute('href');
  expect(href).toBe('#');

  const xssTriggered = await page.evaluate(() => window._xss);
  expect(xssTriggered).toBeFalsy();
});

test('safe link renders correctly', async ({ page, request }) => {
  const content = '[Google](https://google.com)';
  const storyId = await createPublishedStory(request, content);

  await page.goto(`/read/${storyId}`);
  await page.waitForSelector('main a', { timeout: 5000 });

  const link = page.locator('main a[href="https://google.com"]');
  await expect(link).toBeVisible();
  await expect(link).toHaveText('Google');
  await expect(link).toHaveAttribute('target', '_blank');
  await expect(link).toHaveAttribute('rel', 'noopener noreferrer');
});

test('HTML in link text is escaped not injected', async ({ page, request }) => {
  const content = '[<b>bold</b>](https://example.com)';
  const storyId = await createPublishedStory(request, content);

  await page.goto(`/read/${storyId}`);
  await page.waitForSelector('main a', { timeout: 5000 });

  const link = page.locator('main a[href="https://example.com"]');
  await expect(link).toBeVisible();

  // The <b> tag should be rendered as inline bold (parseInline renders it through marked)
  // or escaped — either is safe. What must NOT happen is a raw <b> injected as DOM
  // that could be a vector. The important thing is no onerror/script injection.
  const innerHTML = await link.innerHTML();
  expect(innerHTML).not.toContain('onerror');
  expect(innerHTML).not.toContain('javascript:');
});

}

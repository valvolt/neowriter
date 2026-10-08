const { defineConfig } = require('@playwright/test');

module.exports = defineConfig({
  testDir: 'test/browser',
  testMatch: '**/*.pw.js',
  globalTeardown: './test/browser/global-teardown.js',
  webServer: [
    {
      command: 'DATA_DIR=data_test MODE=LOCAL PORT=3099 node server.js',
      port: 3099,
      reuseExistingServer: false,
    },
    {
      command: 'node test/browser/server-hosted.js',
      port: 3100,
      reuseExistingServer: false,
    },
  ],
  projects: [
    {
      name: 'local',
      grepInvert: /@hosted/,
      use: { baseURL: 'http://localhost:3099', headless: true },
    },
    {
      name: 'hosted',
      grep: /@hosted/,
      use: {
        baseURL: 'http://localhost:3100',
        headless: true,
        // CSRF guard requires this header on mutations; the browser app sends
        // it via its api() helper, but the Playwright request fixture does not.
        extraHTTPHeaders: { 'X-Requested-With': 'XMLHttpRequest' },
      },
    },
  ],
  workers: 1,
});

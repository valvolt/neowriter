const { defineConfig } = require('@playwright/test');

module.exports = defineConfig({
  testDir: 'test/browser',
  testMatch: '**/*.pw.js',
  use: {
    baseURL: 'http://localhost:3099',
    headless: true,
  },
  webServer: {
    command: 'MODE=LOCAL PORT=3099 node server.js',
    port: 3099,
    reuseExistingServer: false,
  },
  // Run tests serially to keep data-directory state predictable
  workers: 1,
});

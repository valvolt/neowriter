'use strict';
// Test-only entry point: stubs OIDC and starts server in HOSTED mode.
// server.js has no bypass code — the stub lives entirely here.

const oidcKey = require.resolve('express-openid-connect');
require.cache[oidcKey] = {
  id: oidcKey, filename: oidcKey, loaded: true,
  exports: {
    auth: () => (req, res, next) => {
      req.oidc = { isAuthenticated: () => true, user: { email: 'test@local' } };
      next();
    },
  },
};

process.env.MODE = 'HOSTED';
process.env.DATA_DIR = 'data_test_hosted';
process.env.PORT = '3100';
process.env.CLIENT_ID = 'test-client';
process.env.ISSUER_BASE_URL = 'https://test.example.com';
process.env.SECRET = 'test-secret-at-least-32-characters-long!!';

const app = require('../../server');
const { ensureDataDir } = require('../../config');

ensureDataDir().then(() => {
  app.listen(3100, () => console.log('Hosted test server on http://localhost:3100'));
});

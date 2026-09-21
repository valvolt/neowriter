// middleware/auth.js
// Middleware: require authentication for API routes in hosted mode
const CSRF_SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

module.exports = function makeRequireUser(LOCAL_MODE) {
  return function requireUser(req, res, next) {
    if (LOCAL_MODE) return next();
    if (!req.oidc || !req.oidc.isAuthenticated()) {
      return res.status(401).json({ error: "authentication required" });
    }
    // CSRF guard: browsers block cross-origin requests with custom headers
    // (preflight required), so verifying this header is sufficient to reject
    // cross-site form/fetch attacks on state-mutating endpoints.
    if (!CSRF_SAFE_METHODS.has(req.method) && req.get('X-Requested-With') !== 'XMLHttpRequest') {
      return res.status(403).json({ error: 'CSRF check failed' });
    }
    next();
  };
};
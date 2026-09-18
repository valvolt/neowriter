// middleware/auth.js
// Middleware: require authentication for API routes in hosted mode
module.exports = function makeRequireUser(LOCAL_MODE) {
  return function requireUser(req, res, next) {
    if (LOCAL_MODE) return next();
    if (!req.oidc || !req.oidc.isAuthenticated()) {
      return res.status(401).json({ error: "authentication required" });
    }
    next();
  };
};
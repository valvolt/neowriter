// utils/sanitize.js
// Sanitize an email/username into a safe directory name
function sanitizeUsername(email) {
  let s = String(email).trim().toLowerCase();
  s = s.replace(/@/g, '-');
  s = s.replace(/[^a-z0-9\-\.]/g, '-');
  s = s.replace(/-{2,}/g, '-');
  s = s.replace(/^-+|-+$/g, '');
  return s || 'unknown';
}
// Sanitize a user-provided name into a safe filename (without extension)
function sanitizeFilename(name) {
  let s = String(name).trim();
  s = s.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  s = s.toLowerCase();
  s = s.replace(/[\s_]+/g, '-');
  s = s.replace(/[^a-z0-9\-]/g, '');
  s = s.replace(/-{2,}/g, '-');
  s = s.replace(/^-+|-+$/g, '');
  return s || 'untitled';
}
module.exports = {
  sanitizeUsername,
  sanitizeFilename,
};
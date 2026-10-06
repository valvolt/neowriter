const path = require('path');
const fs = require('fs').promises;
const { DATA_DIR } = require('../config');
const { createMetaHelpers } = require('./meta');
const { sanitizeFilename } = require('./sanitize');

const { userDir, metaFile, ensureUserData, readMeta, writeMeta, withMetaLock } = createMetaHelpers(DATA_DIR);

function normalizeSearch(s) {
  return s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
}

// Join a user-supplied filename to a trusted base dir, rejecting any traversal.
function safeJoin(dir, filename) {
  const joined = path.join(dir, path.basename(filename));
  if (!joined.startsWith(dir + path.sep) && joined !== dir) {
    const err = new Error('invalid filename');
    err.status = 400;
    throw err;
  }
  return joined;
}

async function atomicWrite(filePath, data) {
  const tmp = filePath + '.tmp';
  await fs.writeFile(tmp, data, 'utf8');
  await fs.rename(tmp, filePath);
}

function storyDir(username, id) {
  return path.join(userDir(username), id);
}

// --- In-memory content caches (tile and highlight files) ---
// Map<username, Map<"storyId/filename", string>>
const tileCache = new Map();
const highlightCache = new Map();

function _getCache(cache, username, storyId, filename) {
  const userMap = cache.get(username);
  return userMap ? userMap.get(`${storyId}/${filename}`) : undefined;
}
function _setCache(cache, username, storyId, filename, content) {
  if (!cache.has(username)) cache.set(username, new Map());
  cache.get(username).set(`${storyId}/${filename}`, content);
}
function _delCache(cache, username, storyId, filename) {
  cache.get(username)?.delete(`${storyId}/${filename}`);
}

async function readTileCached(username, storyId, filename, filePath) {
  const cached = _getCache(tileCache, username, storyId, filename);
  if (cached !== undefined) return cached;
  const content = await fs.readFile(filePath, 'utf8');
  _setCache(tileCache, username, storyId, filename, content);
  return content;
}
async function readHighlightCached(username, storyId, filename, filePath) {
  const cached = _getCache(highlightCache, username, storyId, filename);
  if (cached !== undefined) return cached;
  const content = await fs.readFile(filePath, 'utf8');
  _setCache(highlightCache, username, storyId, filename, content);
  return content;
}

// --- Tag helpers ---

function extractTags(content) {
  const re = /‡([\p{L}\p{N}_-]+|:[a-z0-9_+\-]+:)/gu;
  const set = new Set();
  let m;
  while ((m = re.exec(content)) !== null) set.add(m[1]);
  return Array.from(set);
}

function stripTags(content) {
  return content.replace(/[ \t]*‡(?:[\p{L}\p{N}_-]+|:[a-z0-9_+\-]+:)/gu, '').replace(/\n{3,}/g, '\n\n').trim();
}

// --- Pseudonym helpers ---

const PSEUDONYMS_FILE = path.join(DATA_DIR, '_pseudonyms.json');

async function readPseudonyms() {
  try {
    return JSON.parse(await fs.readFile(PSEUDONYMS_FILE, 'utf8'));
  } catch (e) { return {}; }
}

async function writePseudonyms(ps) {
  await atomicWrite(PSEUDONYMS_FILE, JSON.stringify(ps, null, 2));
}

// --- Tile order helpers ---

async function readTileOrder(username, id) {
  const orderFile = path.join(storyDir(username, id), 'tiles', '_order.json');
  try {
    const raw = await fs.readFile(orderFile, 'utf8');
    return JSON.parse(raw);
  } catch (e) {
    return null;
  }
}

async function writeTileOrder(username, id, order) {
  const orderFile = path.join(storyDir(username, id), 'tiles', '_order.json');
  await atomicWrite(orderFile, JSON.stringify(order, null, 2));
}

// --- Display name helpers (_names.json) ---

async function readNames(dirPath) {
  const namesFile = path.join(dirPath, '_names.json');
  try {
    const raw = await fs.readFile(namesFile, 'utf8');
    return JSON.parse(raw);
  } catch (e) {
    return {};
  }
}

async function writeNames(dirPath, names) {
  const namesFile = path.join(dirPath, '_names.json');
  await atomicWrite(namesFile, JSON.stringify(names, null, 2));
}

function getDisplayNameForFile(names, filename) {
  if (names && names[filename]) return names[filename];
  return filename.replace(/\.md$/, '');
}

// --- Directory size (for storage quota) ---

const _dirSizeCache = new Map();
const DIR_SIZE_TTL_MS = 10_000;

async function getUserDirSize(username) {
  const cached = _dirSizeCache.get(username);
  if (cached && Date.now() - cached.ts < DIR_SIZE_TTL_MS) return cached.size;

  async function walk(dir) {
    let total = 0;
    let entries;
    try { entries = await fs.readdir(dir, { withFileTypes: true }); }
    catch (_) { return 0; }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) total += await walk(full);
      else { try { total += (await fs.stat(full)).size; } catch (_) {} }
    }
    return total;
  }

  const size = await walk(userDir(username));
  _dirSizeCache.set(username, { size, ts: Date.now() });
  return size;
}

function invalidateDirSizeCache(username) {
  _dirSizeCache.delete(username);
}

// --- Per-user quota config (_quota.json at DATA_DIR root) ---

const QUOTA_FILE = path.join(DATA_DIR, '_quota.json');
let _quotaConfig = null;
let _quotaConfigTs = 0;
const QUOTA_CONFIG_TTL_MS = 60_000;

async function getQuotaBytes(username, defaultQuotaMB) {
  if (!_quotaConfig || Date.now() - _quotaConfigTs > QUOTA_CONFIG_TTL_MS) {
    try {
      _quotaConfig = JSON.parse(await fs.readFile(QUOTA_FILE, 'utf8'));
    } catch (_) {
      _quotaConfig = {};
    }
    _quotaConfigTs = Date.now();
  }
  const mb = (username in _quotaConfig) ? _quotaConfig[username] : defaultQuotaMB;
  return mb * 1024 * 1024;
}

module.exports = {
  userDir, metaFile, ensureUserData, readMeta, writeMeta, withMetaLock,
  normalizeSearch, safeJoin, atomicWrite, storyDir,
  tileCache, highlightCache, _getCache, _setCache, _delCache,
  readTileCached, readHighlightCached,
  extractTags, stripTags,
  PSEUDONYMS_FILE, readPseudonyms, writePseudonyms,
  readTileOrder, writeTileOrder,
  readNames, writeNames, getDisplayNameForFile,
  getUserDirSize, invalidateDirSizeCache, getQuotaBytes,
  sanitizeFilename,
};

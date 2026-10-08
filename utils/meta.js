const path = require('path');
const fs = require('fs').promises;

const _metaQueues = new Map();

function withMetaLock(username, fn) {
  const prev = _metaQueues.get(username) || Promise.resolve();
  const next = prev.then(fn);
  _metaQueues.set(username, next.catch(() => {}));
  return next;
}

const _storyQueues = new Map();

function withStoryLock(username, storyId, fn) {
  const key = `${username}/${storyId}`;
  const prev = _storyQueues.get(key) || Promise.resolve();
  const next = prev.then(fn);
  _storyQueues.set(key, next.catch(() => {}));
  return next;
}

function createMetaHelpers(DATA_DIR) {
  function userDir(username) {
    return path.join(DATA_DIR, username);
  }
  function metaFile(username) {
    return path.join(userDir(username), 'metadata.json');
  }
  async function ensureUserData(username) {
    const dir = userDir(username);
    await fs.mkdir(dir, { recursive: true });
    const mf = metaFile(username);
    try {
      await fs.access(mf);
    } catch (e) {
      await fs.writeFile(mf, JSON.stringify([], null, 2), 'utf8');
    }
  }
  async function readMeta(username) {
    const mf = metaFile(username);
    try {
      const raw = await fs.readFile(mf, 'utf8');
      const meta = JSON.parse(raw);
      if (!Array.isArray(meta)) throw new Error('metadata.json is not an array');
      return meta;
    } catch (e) {
      if (e.code === 'ENOENT') return [];
      throw e;
    }
  }
  async function writeMeta(username, meta) {
    const mf = metaFile(username);
    const tmp = mf + '.tmp';
    await fs.writeFile(tmp, JSON.stringify(meta, null, 2), 'utf8');
    await fs.rename(tmp, mf);
  }
  return { userDir, metaFile, ensureUserData, readMeta, writeMeta, withMetaLock };
}

module.exports = { createMetaHelpers, withStoryLock };

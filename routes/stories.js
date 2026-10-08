// routes/stories.js
const express = require('express');
const path = require('path');
const fs = require('fs').promises;
const { sanitizeFilename } = require('../utils/sanitize');
const { userDir, ensureUserData, readMeta, writeMeta, withMetaLock } = require('../utils/server-utils');

module.exports = function storiesRouter({ getUsername, getDisplayName, DEFAULT_USER }) {
  const router = express.Router();

  // List stories
  router.get('/list', async (req, res) => {
    try {
      const username = getUsername(req);
      await ensureUserData(username);
      const meta = await readMeta(username);
      res.json(meta);
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: 'failed to read metadata' });
    }
  });

  // Create a new story
  router.post('/create', async (req, res) => {
    const name = (req.body && req.body.name) ? String(req.body.name) : 'Untitled';
    try {
      const username = getUsername(req);
      await ensureUserData(username);
      const id = require('crypto').randomUUID();
      const author = getDisplayName(req) || username;
      await withMetaLock(username, async () => {
        const meta = await readMeta(username);
        meta.push({ id, name, author });
        await writeMeta(username, meta);
      });
      const dir = path.join(userDir(username), id);
      const tilesDir = path.join(dir, 'tiles');
      const highlightsDir = path.join(dir, 'highlights');
      await fs.mkdir(tilesDir, { recursive: true });
      await fs.mkdir(highlightsDir, { recursive: true });
      const tileFilename = 'chapter-1.md';
      await fs.writeFile(path.join(tilesDir, tileFilename), '', 'utf8');
      const orderFile = path.join(tilesDir, '_order.json');
      const orderTmp = orderFile + '.tmp';
      await fs.writeFile(orderTmp, JSON.stringify([tileFilename], null, 2), 'utf8');
      await fs.rename(orderTmp, orderFile);
      res.json({ id, name, author, tile: { filename: tileFilename, name: 'chapter-1' } });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: 'failed to create story' });
    }
  });

  // Rename story
  router.post('/rename/:id', async (req, res) => {
    const id = req.params.id;
    const name = (req.body && req.body.name) ? String(req.body.name) : undefined;
    if (!name) return res.status(400).json({ error: 'name required' });
    try {
      const username = getUsername(req);
      await withMetaLock(username, async () => {
        const meta = await readMeta(username);
        const item = meta.find(m => m.id === id);
        if (!item) throw Object.assign(new Error('not found'), { status: 404 });
        item.name = name;
        await writeMeta(username, meta);
      });
      res.json({ id, name });
    } catch (err) {
      if (err.status === 404) return res.status(404).json({ error: 'not found' });
      console.error(err);
      res.status(500).json({ error: 'failed to rename' });
    }
  });

  // Set / clear word-count target
  router.post('/story/:id/target', async (req, res) => {
    const id = req.params.id;
    const raw = parseInt(req.body && req.body.wordTarget, 10);
    const target = Number.isFinite(raw) && raw > 0 ? raw : null;
    try {
      const username = getUsername(req);
      await withMetaLock(username, async () => {
        const meta = await readMeta(username);
        const item = meta.find(m => m.id === id);
        if (!item) throw Object.assign(new Error('not found'), { status: 404 });
        if (target) item.wordTarget = target;
        else delete item.wordTarget;
        await writeMeta(username, meta);
      });
      res.json({ id, wordTarget: target });
    } catch (err) {
      if (err.status === 404) return res.status(404).json({ error: 'not found' });
      console.error(err);
      res.status(500).json({ error: 'failed to set target' });
    }
  });

  // Delete story
  router.delete('/story/:id', async (req, res) => {
    const id = req.params.id;
    try {
      const username = getUsername(req);
      let dir;
      await withMetaLock(username, async () => {
        const meta = await readMeta(username);
        const idx = meta.findIndex(m => m.id === id);
        if (idx === -1) throw Object.assign(new Error('not found'), { status: 404 });
        meta.splice(idx, 1);
        await writeMeta(username, meta);
        dir = path.join(userDir(username), id);
      });
      try {
        await fs.rm(dir, { recursive: true, force: true });
      } catch (e) {}
      res.json({ ok: true, id });
    } catch (err) {
      if (err.status === 404) return res.status(404).json({ error: 'not found' });
      console.error('failed to delete story', err);
      res.status(500).json({ error: 'failed to delete' });
    }
  });

  return router;
};

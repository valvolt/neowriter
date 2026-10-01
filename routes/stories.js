// routes/stories.js
const express = require('express');
const { v4: uuidv4 } = require('uuid');
const path = require('path');
const fs = require('fs').promises;
const { sanitizeFilename } = require('../utils/sanitize');
const { createMetaHelpers } = require('../utils/meta');

module.exports = function storiesRouter({ DATA_DIR, getUsername, getDisplayName, DEFAULT_USER }) {
  const { userDir, ensureUserData, readMeta, writeMeta } = createMetaHelpers(DATA_DIR);
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
      const id = uuidv4();
      const meta = await readMeta(username);
      const author = getDisplayName(req) || username;
      meta.push({ id, name, author });
      await writeMeta(username, meta);
      // Create directories and a tile stub as in original
      const dir = path.join(userDir(username), id);
      const tilesDir = path.join(dir, 'tiles');
      const highlightsDir = path.join(dir, 'highlights');
      await fs.mkdir(tilesDir, { recursive: true });
      await fs.mkdir(highlightsDir, { recursive: true });
      // First tile
      const tileFilename = 'chapter-1.md';
      await fs.writeFile(path.join(tilesDir, tileFilename), '', 'utf8');
      // Tile order
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
      const meta = await readMeta(username);
      const item = meta.find(m => m.id === id);
      if (!item) return res.status(404).json({ error: 'not found' });
      item.name = name;
      await writeMeta(username, meta);
      res.json({ id, name });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: 'failed to rename' });
    }
  });

  // Delete story
  router.delete('/story/:id', async (req, res) => {
    const id = req.params.id;
    try {
      const username = getUsername(req);
      const meta = await readMeta(username);
      const idx = meta.findIndex(m => m.id === id);
      if (idx === -1) return res.status(404).json({ error: 'not found' });
      meta.splice(idx, 1);
      await writeMeta(username, meta);
      // Remove directory
      const dir = path.join(userDir(username), id);
      try {
        await fs.rm(dir, { recursive: true, force: true });
      } catch (e) {}
      res.json({ ok: true, id });
    } catch (err) {
      console.error('failed to delete story', err);
      res.status(500).json({ error: 'failed to delete' });
    }
  });

  return router;
};

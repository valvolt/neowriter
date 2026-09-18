// routes/stories.js
const express = require('express');
const { v4: uuidv4 } = require('uuid');
const path = require('path');
const fs = require('fs').promises;
const { sanitizeFilename } = require('../utils/sanitize');

// Helper functions
function userDir(DATA_DIR, username) {
  return path.join(DATA_DIR, username);
}
function metaFile(DATA_DIR, username) {
  return path.join(userDir(DATA_DIR, username), 'metadata.json');
}
async function ensureUserData(DATA_DIR, username) {
  const dir = userDir(DATA_DIR, username);
  await fs.mkdir(dir, { recursive: true });
  const mf = metaFile(DATA_DIR, username);
  try {
    await fs.access(mf);
  } catch (e) {
    await fs.writeFile(mf, JSON.stringify([], null, 2), 'utf8');
  }
}
async function readMeta(DATA_DIR, username) {
  const mf = metaFile(DATA_DIR, username);
  const raw = await fs.readFile(mf, 'utf8');
  return JSON.parse(raw);
}
async function writeMeta(DATA_DIR, username, meta) {
  const mf = metaFile(DATA_DIR, username);
  await fs.writeFile(mf, JSON.stringify(meta, null, 2), 'utf8');
}

module.exports = function storiesRouter({ DATA_DIR, getUsername, getDisplayName, DEFAULT_USER }) {
  const router = express.Router();

  // List stories
  router.get('/list', async (req, res) => {
    try {
      const username = getUsername(req);
      await ensureUserData(DATA_DIR, username);
      const meta = await readMeta(DATA_DIR, username);
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
      await ensureUserData(DATA_DIR, username);
      const id = uuidv4();
      const meta = await readMeta(DATA_DIR, username);
      const author = getDisplayName(req) || username;
      meta.push({ id, name, author });
      await writeMeta(DATA_DIR, username, meta);
      // Create directories and a tile stub as in original
      const dir = path.join(userDir(DATA_DIR, username), id);
      const tilesDir = path.join(dir, 'tiles');
      const highlightsDir = path.join(dir, 'highlights');
      await fs.mkdir(tilesDir, { recursive: true });
      await fs.mkdir(highlightsDir, { recursive: true });
      // First tile
      const tileFilename = 'chapter-1.md';
      await fs.writeFile(path.join(tilesDir, tileFilename), '', 'utf8');
      // Tile order
      await fs.writeFile(path.join(tilesDir, '_order.json'), JSON.stringify([tileFilename], null, 2), 'utf8');
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
      const meta = await readMeta(DATA_DIR, username);
      const item = meta.find(m => m.id === id);
      if (!item) return res.status(404).json({ error: 'not found' });
      item.name = name;
      await writeMeta(DATA_DIR, username, meta);
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
      const meta = await readMeta(DATA_DIR, username);
      const idx = meta.findIndex(m => m.id === id);
      if (idx === -1) return res.status(404).json({ error: 'not found' });
      meta.splice(idx, 1);
      await writeMeta(DATA_DIR, username, meta);
      // Remove directory
      const dir = path.join(userDir(DATA_DIR, username), id);
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
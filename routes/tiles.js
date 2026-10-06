const express = require('express');
const path = require('path');
const fs = require('fs').promises;
const {
  readMeta, safeJoin, storyDir, atomicWrite,
  tileCache, _setCache, _delCache,
  readTileOrder, writeTileOrder, readNames, writeNames, getDisplayNameForFile,
  sanitizeFilename,
} = require('../utils/server-utils');

module.exports = function createTilesRouter({ getUsername }) {
  const router = express.Router();

  // List tiles for a story (respects _order.json)
  router.get('/api/story/:id/tiles', async (req, res) => {
    const id = req.params.id;
    try {
      const username = getUsername(req);
      const meta = await readMeta(username);
      const item = meta.find(m => m.id === id);
      if (!item) return res.status(404).json({ error: 'story not found' });

      const tilesDir = path.join(storyDir(username, id), 'tiles');
      let files = [];
      try {
        files = (await fs.readdir(tilesDir)).filter(f => f.endsWith('.md'));
      } catch (e) {
        files = [];
      }

      const order = await readTileOrder(username, id);
      let ordered;
      if (order && Array.isArray(order)) {
        const fileSet = new Set(files);
        ordered = order.filter(f => fileSet.has(f));
        for (const f of files) {
          if (!order.includes(f)) ordered.push(f);
        }
      } else {
        ordered = files;
      }

      const names = await readNames(tilesDir);
      const tiles = ordered.map(f => ({ filename: f, name: getDisplayNameForFile(names, f) }));
      res.json(tiles);
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: 'failed to list tiles' });
    }
  });

  // Create a new tile
  router.post('/api/story/:id/tiles', async (req, res) => {
    const id = req.params.id;
    try {
      const username = getUsername(req);
      const meta = await readMeta(username);
      const item = meta.find(m => m.id === id);
      if (!item) return res.status(404).json({ error: 'story not found' });

      const tilesDir = path.join(storyDir(username, id), 'tiles');
      await fs.mkdir(tilesDir, { recursive: true });

      let files = [];
      try {
        files = (await fs.readdir(tilesDir)).filter(f => f.endsWith('.md'));
      } catch (e) {
        files = [];
      }
      const existingSet = new Set(files);
      let num = files.length + 1;
      while (existingSet.has(`chapter-${num}.md`)) {
        num++;
      }
      const filename = `chapter-${num}.md`;
      await fs.writeFile(path.join(tilesDir, filename), '', 'utf8');

      const order = (await readTileOrder(username, id)) || files;
      order.push(filename);
      await writeTileOrder(username, id, order);

      res.json({ filename, name: `chapter-${num}` });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: 'failed to create tile' });
    }
  });

  // Get tile content
  router.get('/api/story/:id/tiles/:filename', async (req, res) => {
    const id = req.params.id;
    const filename = req.params.filename;
    try {
      const username = getUsername(req);
      const meta = await readMeta(username);
      const item = meta.find(m => m.id === id);
      if (!item) return res.status(404).json({ error: 'story not found' });

      const tilesDir = path.join(storyDir(username, id), 'tiles');
      const filePath = safeJoin(tilesDir, filename);
      let content = '';
      try {
        content = await fs.readFile(filePath, 'utf8');
      } catch (e) {
        return res.status(404).json({ error: 'tile not found' });
      }
      const names = await readNames(tilesDir);
      res.json({ filename, name: getDisplayNameForFile(names, filename), content });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: 'failed to read tile' });
    }
  });

  // Save tile content
  router.post('/api/story/:id/tiles/:filename/save', async (req, res) => {
    const id = req.params.id;
    const filename = req.params.filename;
    if (!req.body || typeof req.body.content !== 'string') {
      return res.status(400).json({ error: 'content required' });
    }
    try {
      const username = getUsername(req);
      const meta = await readMeta(username);
      const item = meta.find(m => m.id === id);
      if (!item) return res.status(404).json({ error: 'story not found' });

      const filePath = safeJoin(path.join(storyDir(username, id), 'tiles'), filename);
      try {
        await fs.access(filePath);
      } catch (e) {
        return res.status(404).json({ error: 'tile not found' });
      }
      await atomicWrite(filePath, req.body.content);
      _setCache(tileCache, username, id, filename, req.body.content);
      res.json({ ok: true });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: 'failed to save tile' });
    }
  });

  // Rename tile
  router.post('/api/story/:id/tiles/:filename/rename', async (req, res) => {
    const id = req.params.id;
    const filename = req.params.filename;
    const newName = (req.body && req.body.name) ? String(req.body.name) : undefined;
    if (!newName) return res.status(400).json({ error: 'name required' });

    try {
      const username = getUsername(req);
      const meta = await readMeta(username);
      const item = meta.find(m => m.id === id);
      if (!item) return res.status(404).json({ error: 'story not found' });

      const tilesDir = path.join(storyDir(username, id), 'tiles');
      const oldPath = safeJoin(tilesDir, filename);
      try {
        await fs.access(oldPath);
      } catch (e) {
        return res.status(404).json({ error: 'tile not found' });
      }

      let newFilename = sanitizeFilename(newName) + '.md';
      if (newFilename !== filename) {
        let newPath = path.join(tilesDir, newFilename);
        let counter = 1;
        while (true) {
          try {
            await fs.access(newPath);
            counter++;
            newFilename = sanitizeFilename(newName) + '-' + counter + '.md';
            newPath = path.join(tilesDir, newFilename);
          } catch (e) {
            break;
          }
        }
        await fs.rename(oldPath, newPath);
        _delCache(tileCache, username, id, filename);

        const order = await readTileOrder(username, id);
        if (order && Array.isArray(order)) {
          const idx = order.indexOf(filename);
          if (idx !== -1) {
            order[idx] = newFilename;
            await writeTileOrder(username, id, order);
          }
        }
      }

      const names = await readNames(tilesDir);
      if (newFilename !== filename) {
        delete names[filename];
      }
      names[newFilename] = newName;
      await writeNames(tilesDir, names);

      res.json({ filename: newFilename, name: newName });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: 'failed to rename tile' });
    }
  });

  // Delete tile
  router.delete('/api/story/:id/tiles/:filename', async (req, res) => {
    const id = req.params.id;
    const filename = req.params.filename;
    try {
      const username = getUsername(req);
      const meta = await readMeta(username);
      const item = meta.find(m => m.id === id);
      if (!item) return res.status(404).json({ error: 'story not found' });

      const tilesDir = path.join(storyDir(username, id), 'tiles');
      const filePath = safeJoin(tilesDir, filename);
      try {
        await fs.unlink(filePath);
        _delCache(tileCache, username, id, filename);
      } catch (e) {
        return res.status(404).json({ error: 'tile not found' });
      }

      const order = await readTileOrder(username, id);
      if (order && Array.isArray(order)) {
        const idx = order.indexOf(filename);
        if (idx !== -1) {
          order.splice(idx, 1);
          await writeTileOrder(username, id, order);
        }
      }

      const names = await readNames(tilesDir);
      if (names[filename]) {
        delete names[filename];
        await writeNames(tilesDir, names);
      }

      res.json({ ok: true, filename });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: 'failed to delete tile' });
    }
  });

  // Reorder tiles
  router.post('/api/story/:id/tiles/reorder', async (req, res) => {
    const id = req.params.id;
    const order = req.body && req.body.order;
    if (!Array.isArray(order)) return res.status(400).json({ error: 'order array required' });

    try {
      const username = getUsername(req);
      const meta = await readMeta(username);
      const item = meta.find(m => m.id === id);
      if (!item) return res.status(404).json({ error: 'story not found' });

      const tilesDir = path.join(storyDir(username, id), 'tiles');
      let actualFiles;
      try {
        actualFiles = new Set((await fs.readdir(tilesDir)).filter(f => f.endsWith('.md')));
      } catch (e) {
        actualFiles = new Set();
      }
      const unknown = order.filter(f => !actualFiles.has(f));
      if (unknown.length > 0) {
        return res.status(400).json({ error: `unknown tile(s) in order: ${unknown.join(', ')}` });
      }

      await writeTileOrder(username, id, order);
      res.json({ ok: true });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: 'failed to reorder tiles' });
    }
  });

  return router;
};

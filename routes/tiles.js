const express = require('express');
const path = require('path');
const fs = require('fs').promises;
const {
  readMeta, safeJoin, storyDir, atomicWrite,
  tileCache, _setCache, _delCache,
  readTileOrder, writeTileOrder, readNames, writeNames, getDisplayNameForFile,
  sanitizeFilename, withStoryLock,
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

      const { filename, num } = await withStoryLock(username, id, async () => {
        let files = [];
        try { files = (await fs.readdir(tilesDir)).filter(f => f.endsWith('.md')); }
        catch (e) { files = []; }

        let n = files.length + 1;
        let name;
        // Exclusive create: retry until we claim a filename atomically.
        while (true) {
          name = `chapter-${n}.md`;
          try {
            await fs.writeFile(path.join(tilesDir, name), '', { flag: 'wx' });
            break;
          } catch (e) {
            if (e.code !== 'EEXIST') throw e;
            n++;
          }
        }

        const order = (await readTileOrder(username, id)) || files;
        order.push(name);
        await writeTileOrder(username, id, order);
        return { filename: name, num: n };
      });

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
      try { await fs.access(oldPath); }
      catch (e) { return res.status(404).json({ error: 'tile not found' }); }

      const result = await withStoryLock(username, id, async () => {
        let newFilename = sanitizeFilename(newName) + '.md';
        if (newFilename !== filename) {
          // Find a non-colliding filename.
          let newPath = path.join(tilesDir, newFilename);
          let counter = 1;
          while (true) {
            try { await fs.access(newPath); counter++; newFilename = sanitizeFilename(newName) + '-' + counter + '.md'; newPath = path.join(tilesDir, newFilename); }
            catch (e) { break; }
          }

          // Update order BEFORE renaming the file so a crash here leaves the
          // content safe at the old path (tile shows new name in list but 404s
          // on open; recoverable by retrying the rename).
          const order = await readTileOrder(username, id);
          if (order && Array.isArray(order)) {
            const idx = order.indexOf(filename);
            if (idx !== -1) { order[idx] = newFilename; await writeTileOrder(username, id, order); }
          }

          await fs.rename(oldPath, path.join(tilesDir, newFilename));
          _delCache(tileCache, username, id, filename);
        }

        const names = await readNames(tilesDir);
        if (newFilename !== filename) delete names[filename];
        names[newFilename] = newName;
        await writeNames(tilesDir, names);

        return { filename: newFilename, name: newName };
      });

      res.json(result);
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
      try { await fs.access(filePath); }
      catch (e) { return res.status(404).json({ error: 'tile not found' }); }

      await withStoryLock(username, id, async () => {
        // Remove from order BEFORE unlinking: a crash between these two steps
        // leaves an orphaned file on disk (harmless) rather than a ghost entry
        // in the order (invisible, unrecoverable through the UI).
        const order = await readTileOrder(username, id);
        if (order && Array.isArray(order)) {
          const idx = order.indexOf(filename);
          if (idx !== -1) { order.splice(idx, 1); await writeTileOrder(username, id, order); }
        }

        await fs.unlink(filePath);
        _delCache(tileCache, username, id, filename);

        const names = await readNames(tilesDir);
        if (names[filename]) { delete names[filename]; await writeNames(tilesDir, names); }
      });

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

const express = require('express');
const path = require('path');
const fs = require('fs').promises;
const {
  readMeta, safeJoin, storyDir, atomicWrite,
  highlightCache, _setCache, _delCache,
  readNames, writeNames, getDisplayNameForFile,
  sanitizeFilename,
} = require('../utils/server-utils');

module.exports = function createHighlightsRouter({ getUsername }) {
  const router = express.Router();

  // List highlights for a story (sorted alphabetically by display name)
  router.get('/api/story/:id/highlights', async (req, res) => {
    const id = req.params.id;
    try {
      const username = getUsername(req);
      const meta = await readMeta(username);
      const item = meta.find(m => m.id === id);
      if (!item) return res.status(404).json({ error: 'story not found' });

      const highlightsDir = path.join(storyDir(username, id), 'highlights');
      let files = [];
      try {
        files = (await fs.readdir(highlightsDir)).filter(f => f.endsWith('.md'));
      } catch (e) {
        files = [];
      }
      const names = await readNames(highlightsDir);
      const highlights = files.map(f => ({ filename: f, name: getDisplayNameForFile(names, f) }));
      highlights.sort((a, b) => a.name.localeCompare(b.name));
      res.json(highlights);
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: 'failed to list highlights' });
    }
  });

  // Create a new highlight
  router.post('/api/story/:id/highlights', async (req, res) => {
    const id = req.params.id;
    try {
      const username = getUsername(req);
      const meta = await readMeta(username);
      const item = meta.find(m => m.id === id);
      if (!item) return res.status(404).json({ error: 'story not found' });

      const highlightsDir = path.join(storyDir(username, id), 'highlights');
      await fs.mkdir(highlightsDir, { recursive: true });

      let files = [];
      try {
        files = (await fs.readdir(highlightsDir)).filter(f => f.endsWith('.md'));
      } catch (e) {
        files = [];
      }
      const existingSet = new Set(files);
      let num = files.length + 1;
      while (existingSet.has(`highlight-${num}.md`)) {
        num++;
      }
      const filename = `highlight-${num}.md`;
      await fs.writeFile(path.join(highlightsDir, filename), '', 'utf8');
      res.json({ filename, name: `highlight-${num}` });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: 'failed to create highlight' });
    }
  });

  // Get highlight content
  router.get('/api/story/:id/highlights/:filename', async (req, res) => {
    const id = req.params.id;
    const filename = req.params.filename;
    try {
      const username = getUsername(req);
      const meta = await readMeta(username);
      const item = meta.find(m => m.id === id);
      if (!item) return res.status(404).json({ error: 'story not found' });

      const highlightsDir = path.join(storyDir(username, id), 'highlights');
      const filePath = safeJoin(highlightsDir, filename);
      let content = '';
      try {
        content = await fs.readFile(filePath, 'utf8');
      } catch (e) {
        return res.status(404).json({ error: 'highlight not found' });
      }
      const names = await readNames(highlightsDir);
      res.json({ filename, name: getDisplayNameForFile(names, filename), content });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: 'failed to read highlight' });
    }
  });

  // Save highlight content
  router.post('/api/story/:id/highlights/:filename/save', async (req, res) => {
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

      const filePath = safeJoin(path.join(storyDir(username, id), 'highlights'), filename);
      try {
        await fs.access(filePath);
      } catch (e) {
        return res.status(404).json({ error: 'highlight not found' });
      }
      await atomicWrite(filePath, req.body.content);
      _setCache(highlightCache, username, id, filename, req.body.content);
      res.json({ ok: true });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: 'failed to save highlight' });
    }
  });

  // Rename highlight
  router.post('/api/story/:id/highlights/:filename/rename', async (req, res) => {
    const id = req.params.id;
    const filename = req.params.filename;
    const newName = (req.body && req.body.name) ? String(req.body.name) : undefined;
    if (!newName) return res.status(400).json({ error: 'name required' });

    try {
      const username = getUsername(req);
      const meta = await readMeta(username);
      const item = meta.find(m => m.id === id);
      if (!item) return res.status(404).json({ error: 'story not found' });

      const highlightsDir = path.join(storyDir(username, id), 'highlights');
      const oldPath = safeJoin(highlightsDir, filename);
      try {
        await fs.access(oldPath);
      } catch (e) {
        return res.status(404).json({ error: 'highlight not found' });
      }

      const names = await readNames(highlightsDir);
      const oldName = getDisplayNameForFile(names, filename);

      let newFilename = sanitizeFilename(newName) + '.md';
      if (newFilename !== filename) {
        let newPath = path.join(highlightsDir, newFilename);
        let counter = 1;
        while (true) {
          try {
            await fs.access(newPath);
            counter++;
            newFilename = sanitizeFilename(newName) + '-' + counter + '.md';
            newPath = path.join(highlightsDir, newFilename);
          } catch (e) {
            break;
          }
        }
        await fs.rename(oldPath, newPath);
        _delCache(highlightCache, username, id, filename);
      }

      if (newFilename !== filename) {
        delete names[filename];
      }
      names[newFilename] = newName;
      await writeNames(highlightsDir, names);

      // Propagate rename into all tile and highlight files
      const tilesDir = path.join(storyDir(username, id), 'tiles');
      let tileFiles = [];
      try {
        tileFiles = (await fs.readdir(tilesDir)).filter(f => f.endsWith('.md'));
      } catch (e) {
        tileFiles = [];
      }

      let highlightFiles = [];
      try {
        highlightFiles = (await fs.readdir(highlightsDir)).filter(f => f.endsWith('.md'));
      } catch (e) {
        highlightFiles = [];
      }

      const escapedOld = oldName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const replaceRegex = new RegExp(escapedOld, 'giu');

      const replaceInFile = async (filePath) => {
        try {
          const content = await fs.readFile(filePath, 'utf8');
          if (!replaceRegex.test(content)) return;
          replaceRegex.lastIndex = 0;
          const updated = content.replace(replaceRegex, (match) => {
            if (match === match.toUpperCase()) return newName.toUpperCase();
            if (match[0] === match[0].toUpperCase()) {
              return newName.charAt(0).toUpperCase() + newName.slice(1);
            }
            return newName.toLowerCase();
          });
          if (updated !== content) {
            await atomicWrite(filePath, updated);
          }
        } catch (e) {
          console.error(`failed to update file ${filePath}`, e);
        }
      };

      await Promise.all([
        ...tileFiles.map(f => replaceInFile(path.join(tilesDir, f))),
        ...highlightFiles.map(f => replaceInFile(path.join(highlightsDir, f))),
      ]);

      res.json({ filename: newFilename, name: newName });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: 'failed to rename highlight' });
    }
  });

  // Delete highlight
  router.delete('/api/story/:id/highlights/:filename', async (req, res) => {
    const id = req.params.id;
    const filename = req.params.filename;
    try {
      const username = getUsername(req);
      const meta = await readMeta(username);
      const item = meta.find(m => m.id === id);
      if (!item) return res.status(404).json({ error: 'story not found' });

      const highlightsDir = path.join(storyDir(username, id), 'highlights');
      const filePath = safeJoin(highlightsDir, filename);
      try {
        await fs.unlink(filePath);
        _delCache(highlightCache, username, id, filename);
      } catch (e) {
        return res.status(404).json({ error: 'highlight not found' });
      }

      const names = await readNames(highlightsDir);
      if (names[filename]) {
        delete names[filename];
        await writeNames(highlightsDir, names);
      }

      res.json({ ok: true, filename });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: 'failed to delete highlight' });
    }
  });

  return router;
};

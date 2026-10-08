const path = require('path');
const fs = require('fs').promises;
const AdmZip = require('adm-zip');
const express = require('express');
const { readMeta, storyDir, readTileOrder, readNames, sanitizeFilename } = require('../utils/server-utils');

module.exports = function createExportRouter({ getUsername }) {
  const router = express.Router();

  router.get('/api/story/:id/export', async (req, res) => {
    try {
      const username = getUsername(req);
      const meta = await readMeta(username);
      const story = meta.find(m => m.id === req.params.id);
      if (!story) return res.status(404).json({ error: 'Not found' });

      const storyFolder = sanitizeFilename(story.name);
      const archive = new AdmZip();
      const dir = storyDir(username, story.id);

      // Tiles — ordered, prefixed with zero-padded index
      const order = await readTileOrder(username, story.id) || [];
      const tileNames = await readNames(path.join(dir, 'tiles')).catch(() => ({}));
      const padLen = String(order.length).length;
      const pad = n => String(n).padStart(padLen, '0');
      for (let i = 0; i < order.length; i++) {
        const f = order[i];
        const displayName = tileNames[f] || f.replace(/\.md$/, '');
        const stem = sanitizeFilename(displayName);
        const content = await fs.readFile(path.join(dir, 'tiles', f));
        archive.addFile(`${storyFolder}/tiles/${pad(i + 1)}-${stem}.md`, content);
      }

      // Highlights — display name as filename, no prefix (no canonical order)
      const hlDir = path.join(dir, 'highlights');
      try {
        const hlNames = await readNames(hlDir).catch(() => ({}));
        const hlFiles = (await fs.readdir(hlDir)).filter(f => f.endsWith('.md'));
        for (const f of hlFiles) {
          const displayName = hlNames[f] || f.replace(/\.md$/, '');
          const stem = sanitizeFilename(displayName);
          const content = await fs.readFile(path.join(hlDir, f));
          archive.addFile(`${storyFolder}/highlights/${stem}.md`, content);
        }
      } catch (_) { /* no highlights directory */ }

      // Pictures — copied as-is
      const picDir = path.join(dir, 'pictures');
      try {
        for (const f of await fs.readdir(picDir)) {
          const content = await fs.readFile(path.join(picDir, f));
          archive.addFile(`${storyFolder}/pictures/${f}`, content);
        }
      } catch (_) { /* no pictures directory */ }

      const buf = archive.toBuffer();
      res.attachment(`${storyFolder}.zip`);
      res.send(buf);
    } catch (e) {
      if (!res.headersSent) res.status(500).json({ error: 'Export failed' });
    }
  });

  return router;
};

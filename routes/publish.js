const express = require('express');
const { readMeta, writeMeta, withMetaLock, readPseudonyms, writePseudonyms } = require('../utils/server-utils');

module.exports = function createPublishRouter({ getUsername, invalidatePublishedCache }) {
  const router = express.Router();

  // Toggle publish state for a story
  router.post('/api/story/:id/publish', async (req, res) => {
    const id = req.params.id;
    const published = !!(req.body && req.body.published);
    try {
      const username = getUsername(req);
      await withMetaLock(username, async () => {
        const meta = await readMeta(username);
        const item = meta.find(m => m.id === id);
        if (!item) throw Object.assign(new Error('not found'), { status: 404 });
        item.published = published;
        await writeMeta(username, meta);
      });
      invalidatePublishedCache();
      res.json({ id, published });
    } catch (err) {
      if (err.status === 404) return res.status(404).json({ error: 'not found' });
      console.error(err);
      res.status(500).json({ error: 'failed to update publish state' });
    }
  });

  // Get publish state for a story
  router.get('/api/story/:id/published', async (req, res) => {
    const id = req.params.id;
    try {
      const username = getUsername(req);
      const meta = await readMeta(username);
      const item = meta.find(m => m.id === id);
      if (!item) return res.status(404).json({ error: 'not found' });
      res.json({ id, published: !!item.published });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: 'failed to read publish state' });
    }
  });

  // Get pseudonym for current user
  router.get('/api/pseudonym', async (req, res) => {
    try {
      const username = getUsername(req);
      const ps = await readPseudonyms();
      res.json({ pseudonym: ps[username] || null });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: 'failed to read pseudonym' });
    }
  });

  // Set pseudonym for current user
  router.post('/api/pseudonym', async (req, res) => {
    const pseudonym = String((req.body && req.body.pseudonym) || '').trim();
    if (!/^[A-Za-z0-9]{1,15}$/.test(pseudonym)) {
      return res.status(400).json({ error: 'Pseudonym must be 1–15 alphanumeric characters.' });
    }
    try {
      const username = getUsername(req);
      const ps = await readPseudonyms();
      const lc = pseudonym.toLowerCase();
      for (const [key, val] of Object.entries(ps)) {
        if (key !== username && val.toLowerCase() === lc) {
          return res.status(409).json({ error: 'taken' });
        }
      }
      ps[username] = pseudonym;
      await writePseudonyms(ps);
      res.json({ pseudonym });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: 'failed to save pseudonym' });
    }
  });

  // Delete pseudonym for current user
  router.delete('/api/pseudonym', async (req, res) => {
    try {
      const username = getUsername(req);
      const ps = await readPseudonyms();
      delete ps[username];
      await writePseudonyms(ps);
      res.json({ ok: true });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: 'failed to delete pseudonym' });
    }
  });

  return router;
};

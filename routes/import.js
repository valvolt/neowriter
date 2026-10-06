const path = require('path');
const fs = require('fs').promises;
const AdmZip = require('adm-zip');
const express = require('express');
const { v4: uuidv4 } = require('uuid');
const {
  ensureUserData, withMetaLock, readMeta, writeMeta,
  storyDir, atomicWrite, sanitizeFilename,
  readTileOrder, writeTileOrder, readNames, writeNames,
  getUserDirSize, getQuotaBytes,
} = require('../utils/server-utils');
const { ALLOWED_IMAGE_EXTS, checkImageMagicBytes } = require('../utils/image');

// Reject ZIPs whose total declared uncompressed size exceeds this (zip bomb guard)
const MAX_UNCOMPRESSED_BYTES = 200 * 1024 * 1024; // 200 MB

function stemToDisplayName(stem) {
  return stem.replace(/-/g, ' ').replace(/^./, c => c.toUpperCase());
}

function collisionFree(base, usedSet) {
  let name = base + '.md';
  let n = 2;
  while (usedSet.has(name)) name = `${base}-${n++}.md`;
  usedSet.add(name);
  return name;
}

async function atomicWriteBinary(filePath, buffer) {
  const tmp = filePath + '.tmp';
  await fs.writeFile(tmp, buffer);
  await fs.rename(tmp, filePath);
}

module.exports = function createImportRouter({ getUsername, LOCAL_MODE, STORAGE_QUOTA_MB }) {
  const router = express.Router();

  router.post('/api/import', async (req, res) => {
    try {
      const username = getUsername(req);
      if (!username) return res.status(401).json({ error: 'Not authenticated' });

      const { data, storyId } = req.body || {};
      if (!data) return res.status(400).json({ error: 'Missing data' });

      let zip;
      try { zip = new AdmZip(Buffer.from(data, 'base64')); }
      catch (_) { return res.status(400).json({ error: 'Invalid ZIP' }); }

      const entries = zip.getEntries().filter(e =>
        !e.isDirectory &&
        !e.entryName.includes('__MACOSX') &&
        !path.basename(e.entryName).startsWith('.')
      );

      if (entries.length === 0) return res.status(400).json({ error: 'Empty ZIP' });

      // Zip bomb guard: check total declared uncompressed size before any getData() call
      const totalDeclaredBytes = entries.reduce((acc, e) => acc + e.header.size, 0);
      if (totalDeclaredBytes > MAX_UNCOMPRESSED_BYTES) {
        return res.status(413).json({ error: 'ZIP content too large' });
      }

      // Quota pre-flight (HOSTED mode): reject if import would push user over quota
      if (!LOCAL_MODE) {
        const [used, quota] = await Promise.all([
          getUserDirSize(username),
          getQuotaBytes(username, STORAGE_QUOTA_MB),
        ]);
        if (used + totalDeclaredBytes > quota) {
          return res.status(413).json({ error: 'Storage quota exceeded', used, quota });
        }
      }

      // Determine top-level folder from first entry
      const topFolder = entries[0].entryName.split('/')[0];
      if (!topFolder) return res.status(400).json({ error: 'Unrecognized ZIP structure' });
      const prefix = topFolder + '/';

      // Categorize entries, sort tiles by numeric prefix
      const tileEntries = entries
        .filter(e => e.entryName.startsWith(prefix + 'tiles/') && e.entryName.endsWith('.md'))
        .sort((a, b) => {
          const ia = parseInt(path.basename(a.entryName)) || 0;
          const ib = parseInt(path.basename(b.entryName)) || 0;
          return ia - ib;
        });
      const hlEntries = entries
        .filter(e => e.entryName.startsWith(prefix + 'highlights/') && e.entryName.endsWith('.md'));
      // Only accept known image extensions for pictures
      const picEntries = entries.filter(e => {
        if (!e.entryName.startsWith(prefix + 'pictures/')) return false;
        const ext = path.extname(e.entryName).toLowerCase();
        return ALLOWED_IMAGE_EXTS.has(ext);
      });

      // Write a picture entry after sanitizing the filename and verifying magic bytes
      async function writePicture(e, picDir) {
        const rawName = path.basename(e.entryName);
        const ext = path.extname(rawName).toLowerCase();
        const stem = sanitizeFilename(path.basename(rawName, ext));
        const filename = (stem || 'picture') + ext;
        const buf = e.getData();
        if (!checkImageMagicBytes(buf, ext)) return; // skip files that fail magic byte check
        await atomicWriteBinary(path.join(picDir, filename), buf);
      }

      if (storyId) {
        // --- APPEND to existing story ---
        const meta = await readMeta(username);
        const story = meta.find(m => m.id === storyId);
        if (!story) return res.status(404).json({ error: 'Story not found' });

        const dir = storyDir(username, storyId);
        const tilesDir = path.join(dir, 'tiles');
        const hlDir = path.join(dir, 'highlights');
        const picDir = path.join(dir, 'pictures');

        const existingOrder = await readTileOrder(username, storyId) || [];
        const existingTileNames = await readNames(tilesDir).catch(() => ({}));
        const existingHlNames = await readNames(hlDir).catch(() => ({}));

        const usedTileFilenames = new Set(existingOrder);
        const usedHlFilenames = new Set(Object.keys(existingHlNames));

        // Tiles
        const newOrder = [];
        const updatedTileNames = { ...existingTileNames };
        for (const e of tileEntries) {
          const base = path.basename(e.entryName, '.md');
          const stem = base.replace(/^\d+-/, '');
          const displayName = stemToDisplayName(stem);
          const filename = collisionFree(sanitizeFilename(displayName), usedTileFilenames);
          await atomicWrite(path.join(tilesDir, filename), e.getData().toString('utf8'));
          newOrder.push(filename);
          updatedTileNames[filename] = displayName;
        }
        await writeTileOrder(username, storyId, [...existingOrder, ...newOrder]);
        await writeNames(tilesDir, updatedTileNames);

        // Highlights
        if (hlEntries.length > 0) {
          await fs.mkdir(hlDir, { recursive: true });
          const updatedHlNames = { ...existingHlNames };
          for (const e of hlEntries) {
            const stem = path.basename(e.entryName, '.md');
            const displayName = stemToDisplayName(stem);
            const filename = collisionFree(sanitizeFilename(displayName), usedHlFilenames);
            await atomicWrite(path.join(hlDir, filename), e.getData().toString('utf8'));
            updatedHlNames[filename] = displayName;
          }
          await writeNames(hlDir, updatedHlNames);
        }

        // Pictures
        if (picEntries.length > 0) {
          await fs.mkdir(picDir, { recursive: true });
          for (const e of picEntries) await writePicture(e, picDir);
        }

        return res.json({ id: storyId, name: story.name });
      } else {
        // --- NEW story ---
        const storyDisplayName = stemToDisplayName(topFolder);
        const id = uuidv4();
        await ensureUserData(username);

        const dir = storyDir(username, id);
        const tilesDir = path.join(dir, 'tiles');
        await fs.mkdir(tilesDir, { recursive: true });

        const usedTileFilenames = new Set();
        const tileOrder = [];
        const tileNames = {};

        for (const e of tileEntries) {
          const base = path.basename(e.entryName, '.md');
          const stem = base.replace(/^\d+-/, '');
          const displayName = stemToDisplayName(stem);
          const filename = collisionFree(sanitizeFilename(displayName), usedTileFilenames);
          await atomicWrite(path.join(tilesDir, filename), e.getData().toString('utf8'));
          tileOrder.push(filename);
          tileNames[filename] = displayName;
        }
        await writeTileOrder(username, id, tileOrder);
        await writeNames(tilesDir, tileNames);

        if (hlEntries.length > 0) {
          const hlDir = path.join(dir, 'highlights');
          await fs.mkdir(hlDir, { recursive: true });
          const hlNames = {};
          const usedHlFilenames = new Set();
          for (const e of hlEntries) {
            const stem = path.basename(e.entryName, '.md');
            const displayName = stemToDisplayName(stem);
            const filename = collisionFree(sanitizeFilename(displayName), usedHlFilenames);
            await atomicWrite(path.join(hlDir, filename), e.getData().toString('utf8'));
            hlNames[filename] = displayName;
          }
          await writeNames(hlDir, hlNames);
        }

        if (picEntries.length > 0) {
          const picDir = path.join(dir, 'pictures');
          await fs.mkdir(picDir, { recursive: true });
          for (const e of picEntries) await writePicture(e, picDir);
        }

        await withMetaLock(username, async () => {
          const meta = await readMeta(username);
          meta.push({ id, name: storyDisplayName, author: username });
          await writeMeta(username, meta);
        });

        return res.json({ id, name: storyDisplayName });
      }
    } catch (e) {
      if (!res.headersSent) res.status(500).json({ error: 'Import failed' });
    }
  });

  return router;
};

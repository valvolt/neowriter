const express = require('express');
const fs = require('fs').promises;
const path = require('path');
const { v4: uuidv4 } = require('uuid');

const app = express();
const PORT = process.env.PORT || 3000;

// Local/hosted mode toggle.
// When true the server runs in single-user "local" mode and uses a default
// user folder under DATA_DIR. When you implement authentication later,
// set this to false and to per-user paths.
const LOCAL_MODE = true;
const DEFAULT_USER = 'anonymous';

const ROOT = __dirname;
const DATA_DIR = path.join(ROOT, 'data');
const META_FILE = path.join(DATA_DIR, 'metadata.json');
const PUBLIC_DIR = path.join(ROOT, 'public');

app.use(express.json());
app.use(express.static(PUBLIC_DIR));

/*
 Ensure data directory, per-user folder (for LOCAL_MODE), metadata file exist.
 Also migrate existing top-level story files into the default user folder and
 ensure all metadata entries include an 'author' property (default DEFAULT_USER).
*/
async function ensureData() {
  try {
    await fs.mkdir(DATA_DIR, { recursive: true });
  } catch (e) {
    console.error('Failed to create data dir', e);
    throw e;
  }

  // Ensure default user folder when running in local mode
  if (LOCAL_MODE) {
    const userDir = path.join(DATA_DIR, DEFAULT_USER);
    try {
      await fs.mkdir(userDir, { recursive: true });
    } catch (e) {
      console.error('Failed to create user data dir', e);
      throw e;
    }
  }

  // Ensure metadata file exists
  try {
    await fs.access(META_FILE);
  } catch (e) {
    // create empty metadata file
    await fs.writeFile(META_FILE, JSON.stringify([], null, 2), 'utf8');
  }

  // Migrate existing .md files at DATA_DIR root into the default user folder and
  // ensure metadata entries have an 'author' field.
  try {
    const meta = await readMeta();
    let updated = false;

    // Ensure every metadata entry has an author (default to DEFAULT_USER when local)
    for (const item of meta) {
      if (!item.author) {
        item.author = DEFAULT_USER;
        updated = true;
      }
    }

    // Move any top-level .md files into the user folder if running local mode
    if (LOCAL_MODE) {
      const userDir = path.join(DATA_DIR, DEFAULT_USER);
 const entries = await fs.readdir(DATA_DIR);
      for (const name of entries) {
        if (name.endsWith('.md')) {
          const src = path.join(DATA_DIR, name);
          const dest = path.join(userDir, name);
          try {
            // Only move if destination does not already exist
            await fs.stat(dest).catch(() => null);
            const destExists = await fs.stat(dest).then(() => true).catch(() => false);
            if (!destExists) {
              await fs.rename(src, dest);
            } else {
              // If dest exists, remove the source to avoid duplicates
              await fs.unlink(src).catch(() => null);
            }
          } catch (e) {
            // ignore single-file migration errors but log
            console.warn(`Failed migrating ${src} -> ${dest}:`, e);
          }
        }
      }
    }

    if (updated) {
      await writeMeta(meta);
    }
  } catch (e) {
    console.warn('Migration/metadata normalization step failed', e);
  }
}

async function readMeta() {
  const raw = await fs.readFile(META_FILE, 'utf8');
  return JSON.parse(raw);
}

async function writeMeta(meta) {
  await fs.writeFile(META_FILE, JSON.stringify(meta, null, 2), 'utf8');
}

async function storyPath(id) {
  // Store per-user files when in LOCAL_MODE (under DATA_DIR/<username>/).
  // When authentication is added later this function can be extended to
  // resolve a user's folder from req.user or similar.
  const userDir = LOCAL_MODE ? path.join(DATA_DIR, DEFAULT_USER) : DATA_DIR;
  return path.join(userDir, `${id}.md`);
}

// List stories
app.get('/api/list', async (req, res) => {
  try {
    const meta = await readMeta();
    res.json(meta);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'failed to read metadata' });
  }
});

// Create story
app.post('/api/create', async (req, res) => {
  const name = (req && req.body.name) ? String(req.body.name) : 'Untitled';
  try {
    const id = uuidv4();
    const meta = await readMeta();
    // Record author metadata. In local mode we assign DEFAULT_USER. When auth is implemented
    // replace this with the authenticated username.
    const author = LOCAL_MODE ? DEFAULT_USER : ((req.user && req.user.username) || DEFAULT_USER);
    meta.push({ id, name, author });
    await writeMeta(meta);
    const file = await storyPath(id);
    await fs.writeFile(file, '', 'utf8');
    res.json({ id, name, author });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'failed to create story' });
  }
});

// Rename story
app.post('/api/rename/:id', async (req, res) => {
  const id = req.params.id;
  const name = (req.body && req.body.name) ? String(req.body.name) : undefined;
  if (!name) return res.status(400).json({ error: 'name required' });

  try {
    const meta = await readMeta();
    const item = meta.find(m => m.id === id);
    if (!item) return res.status(404).json({ error: 'not found' });
    item.name = name;
    await writeMeta(meta);
    res.json({ id, name });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'failed to rename' });
  }
});

// Get story content and metadata
app.get('/api/story/:id', async (req, res) => {
  const id = req.params.id;
  try {
    const meta = await readMeta();
    const item = meta.find(m => m.id === id);
    if (!item) return res.status(404).json({ error: 'not found' });
    const file = await storyPath(id);
    let content = '';
    try {
      content = await fs.readFile(file, 'utf8');
    } catch (e) {
      content = '';
    }
    res.json({ id, name: item.name, author: item.author || DEFAULT_USER, content });
  } catch (err) {
 console.error(err);
    res.status(500).json({ error: 'failed to read story' });
  }
});

 // Save content (autosave)
 app.post('/api/save/:id', async (req, res) => {
   const id = req.params.id;
   if (!req.body || typeof req.body.content !== 'string') {
     return res.status(400).json({ error: 'content required' });
   }
   try {
     const meta = await readMeta();
     const item = meta.find(m => m.id === id);
     if (!item) return res.status(404).json({ error: 'not found' });
     const file = await storyPath(id);
     await fs.writeFile(file, req.body.content, 'utf8');
     res.json({ ok: true });
   } catch (err) {
     console.error(err);
     res.status(500).json({ error: 'failed to save' });
   }
 });

 // Delete story (remove metadata entry and file)
 app.delete('/api/story/:id', async (req, res) => {
   const id = req.params.id;
   try {
 const meta = await readMeta();
     const idx = meta.findIndex(m => m.id === id);
     if (idx === -1) return res.status(404).json({ error: 'not found' });
     // Remove metadata entry
     const [removed] = meta.splice(idx, 1);
     await writeMeta(meta);
     // Remove the story file if present
     const file = storyPath(id);
     try {
       await fs.unlink(file);
     } catch (e) {
       // ignore if missing
     }
     res.json({ ok: true, id });
   } catch (err) {
     console.error('failed to delete story', err);
     res.status(500).json({ error: 'failed to delete' });
   }
 });

// Fallback to index.html for SPA navigation
app.get('*', (req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, 'index.html'));
});

(async () => {
  try {
    await ensureData();
    app.listen(PORT, () => {
      console.log(`Neo Writer server running on http://localhost:${PORT}`);
    });
  } catch (e) {
    console.error('Failed to start server', e);
    process.exit(1);
  }
})();
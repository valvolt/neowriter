const express = require('express');
const fs = require('fs').promises;
const path = require('path');
const { v4: uuidv4 } = require('uuid');

const app = express();
const PORT = process.env.PORT || 3000;

// Local/hosted mode toggle.
const LOCAL_MODE = true;
const DEFAULT_USER = 'anonymous';

const ROOT = __dirname;
const DATA_DIR = path.join(ROOT, 'data');
const META_FILE = path.join(DATA_DIR, 'metadata.json');
const PUBLIC_DIR = path.join(ROOT, 'public');

app.use(express.json());
app.use(express.static(PUBLIC_DIR));

// Sanitize a user-provided name into a safe filename (without extension).
// Lowercase, replace spaces/underscores with hyphens, strip non-alphanumeric (except hyphens), collapse multiple hyphens, trim hyphens.
function sanitizeFilename(name) {
  let s = String(name).trim().toLowerCase();
  s = s.replace(/[\s_]+/g, '-');
  s = s.replace(/[^a-z0-9\-]/g, '');
  s = s.replace(/-{2,}/g, '-');
  s = s.replace(/^-+|-+$/g, '');
  return s || 'untitled';
}

// Ensure data directory and metadata file exist.
async function ensureData() {
  await fs.mkdir(DATA_DIR, { recursive: true });

  if (LOCAL_MODE) {
    const userDir = path.join(DATA_DIR, DEFAULT_USER);
    await fs.mkdir(userDir, { recursive: true });
  }

  try {
    await fs.access(META_FILE);
  } catch (e) {
    await fs.writeFile(META_FILE, JSON.stringify([], null, 2), 'utf8');
  }
}

async function readMeta() {
  const raw = await fs.readFile(META_FILE, 'utf8');
  return JSON.parse(raw);
}

async function writeMeta(meta) {
  await fs.writeFile(META_FILE, JSON.stringify(meta, null, 2), 'utf8');
}

// Get the base directory for a story
function storyDir(id) {
  const userDir = LOCAL_MODE ? path.join(DATA_DIR, DEFAULT_USER) : DATA_DIR;
  return path.join(userDir, id);
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
  const name = (req.body && req.body.name) ? String(req.body.name) : 'Untitled';
  try {
    const id = uuidv4();
    const meta = await readMeta();
    const author = LOCAL_MODE ? DEFAULT_USER : ((req.user && req.user.username) || DEFAULT_USER);
    meta.push({ id, name, author });
    await writeMeta(meta);

    const dir = storyDir(id);
    const tilesDir = path.join(dir, 'tiles');
    const highlightsDir = path.join(dir, 'highlights');
    await fs.mkdir(tilesDir, { recursive: true });
    await fs.mkdir(highlightsDir, { recursive: true });

    // Create the first tile auto-named chapter-1
    const tileFilename = 'chapter-1.md';
    await fs.writeFile(path.join(tilesDir, tileFilename), '', 'utf8');

    // Initialize tile order
    await fs.writeFile(path.join(tilesDir, '_order.json'), JSON.stringify([tileFilename], null, 2), 'utf8');

    res.json({ id, name, author, tile: { filename: tileFilename, name: 'chapter-1' } });
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

// Get story metadata
app.get('/api/story/:id', async (req, res) => {
  const id = req.params.id;
  try {
    const meta = await readMeta();
    const item = meta.find(m => m.id === id);
    if (!item) return res.status(404).json({ error: 'not found' });
    res.json({ id, name: item.name, author: item.author || DEFAULT_USER });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'failed to read story' });
  }
});

// Delete story (remove metadata entry and entire story folder)
app.delete('/api/story/:id', async (req, res) => {
  const id = req.params.id;
  try {
    const meta = await readMeta();
    const idx = meta.findIndex(m => m.id === id);
    if (idx === -1) return res.status(404).json({ error: 'not found' });
    meta.splice(idx, 1);
    await writeMeta(meta);

    const dir = storyDir(id);
    try {
      await fs.rm(dir, { recursive: true, force: true });
    } catch (e) {
      // ignore removal errors
    }
    res.json({ ok: true, id });
  } catch (err) {
    console.error('failed to delete story', err);
    res.status(500).json({ error: 'failed to delete' });
  }
});

// --- Tile order helpers ---

async function readTileOrder(id) {
  const orderFile = path.join(storyDir(id), 'tiles', '_order.json');
  try {
    const raw = await fs.readFile(orderFile, 'utf8');
    return JSON.parse(raw);
  } catch (e) {
    return null; // no order file yet
  }
}

async function writeTileOrder(id, order) {
  const orderFile = path.join(storyDir(id), 'tiles', '_order.json');
  await fs.writeFile(orderFile, JSON.stringify(order, null, 2), 'utf8');
}

// --- Tile endpoints ---

// List tiles for a story (respects _order.json)
app.get('/api/story/:id/tiles', async (req, res) => {
  const id = req.params.id;
  try {
    const meta = await readMeta();
    const item = meta.find(m => m.id === id);
    if (!item) return res.status(404).json({ error: 'story not found' });

    const tilesDir = path.join(storyDir(id), 'tiles');
    let files = [];
    try {
      files = (await fs.readdir(tilesDir)).filter(f => f.endsWith('.md'));
    } catch (e) {
      files = [];
    }

    // Apply ordering from _order.json
    const order = await readTileOrder(id);
    let ordered;
    if (order && Array.isArray(order)) {
      const fileSet = new Set(files);
      // Start with ordered entries that still exist on disk
      ordered = order.filter(f => fileSet.has(f));
      // Append any files not in the order (e.g. newly discovered)
      for (const f of files) {
        if (!order.includes(f)) ordered.push(f);
      }
    } else {
      ordered = files;
    }

    const tiles = ordered.map(f => ({ filename: f, name: f.replace(/\.md$/, '') }));
    res.json(tiles);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'failed to list tiles' });
  }
});

// Create a new tile (auto-named chapter-N, finding the next unused number)
app.post('/api/story/:id/tiles', async (req, res) => {
  const id = req.params.id;
  try {
    const meta = await readMeta();
    const item = meta.find(m => m.id === id);
    if (!item) return res.status(404).json({ error: 'story not found' });

    const tilesDir = path.join(storyDir(id), 'tiles');
    await fs.mkdir(tilesDir, { recursive: true });

    // Find the next unused chapter number
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
    const filePath = path.join(tilesDir, filename);

    await fs.writeFile(filePath, '', 'utf8');

    // Append to order
    const order = (await readTileOrder(id)) || files;
    order.push(filename);
    await writeTileOrder(id, order);

    res.json({ filename, name: `chapter-${num}` });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'failed to create tile' });
  }
});

// Get tile content
app.get('/api/story/:id/tiles/:filename', async (req, res) => {
  const id = req.params.id;
  const filename = req.params.filename;
  try {
    const meta = await readMeta();
    const item = meta.find(m => m.id === id);
    if (!item) return res.status(404).json({ error: 'story not found' });

    const filePath = path.join(storyDir(id), 'tiles', filename);
    let content = '';
    try {
      content = await fs.readFile(filePath, 'utf8');
    } catch (e) {
      return res.status(404).json({ error: 'tile not found' });
    }
    res.json({ filename, name: filename.replace(/\.md$/, ''), content });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'failed to read tile' });
  }
});

// Save tile content
app.post('/api/story/:id/tiles/:filename/save', async (req, res) => {
  const id = req.params.id;
  const filename = req.params.filename;
  if (!req.body || typeof req.body.content !== 'string') {
    return res.status(400).json({ error: 'content required' });
  }
  try {
    const meta = await readMeta();
    const item = meta.find(m => m.id === id);
    if (!item) return res.status(404).json({ error: 'story not found' });

    const filePath = path.join(storyDir(id), 'tiles', filename);
    // Verify tile exists
    try {
      await fs.access(filePath);
    } catch (e) {
      return res.status(404).json({ error: 'tile not found' });
    }
    await fs.writeFile(filePath, req.body.content, 'utf8');
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'failed to save tile' });
  }
});

// Rename tile
app.post('/api/story/:id/tiles/:filename/rename', async (req, res) => {
  const id = req.params.id;
  const filename = req.params.filename;
  const newName = (req.body && req.body.name) ? String(req.body.name) : undefined;
  if (!newName) return res.status(400).json({ error: 'name required' });

  try {
    const meta = await readMeta();
    const item = meta.find(m => m.id === id);
    if (!item) return res.status(404).json({ error: 'story not found' });

    const tilesDir = path.join(storyDir(id), 'tiles');
    const oldPath = path.join(tilesDir, filename);
    try {
      await fs.access(oldPath);
    } catch (e) {
      return res.status(404).json({ error: 'tile not found' });
    }

    let newFilename = sanitizeFilename(newName) + '.md';
    // Avoid collisions
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

      // Update _order.json
      const order = await readTileOrder(id);
      if (order && Array.isArray(order)) {
        const idx = order.indexOf(filename);
        if (idx !== -1) {
          order[idx] = newFilename;
          await writeTileOrder(id, order);
        }
      }
    }

    res.json({ filename: newFilename, name: newName });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'failed to rename tile' });
  }
});

// Delete tile
app.delete('/api/story/:id/tiles/:filename', async (req, res) => {
  const id = req.params.id;
  const filename = req.params.filename;
  try {
    const meta = await readMeta();
    const item = meta.find(m => m.id === id);
    if (!item) return res.status(404).json({ error: 'story not found' });

    const filePath = path.join(storyDir(id), 'tiles', filename);
    try {
      await fs.unlink(filePath);
    } catch (e) {
      return res.status(404).json({ error: 'tile not found' });
    }

    // Remove from _order.json
    const order = await readTileOrder(id);
    if (order && Array.isArray(order)) {
      const idx = order.indexOf(filename);
      if (idx !== -1) {
        order.splice(idx, 1);
        await writeTileOrder(id, order);
      }
    }

    res.json({ ok: true, filename });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'failed to delete tile' });
  }
});

// Reorder tiles
app.post('/api/story/:id/tiles/reorder', async (req, res) => {
  const id = req.params.id;
  const order = req.body && req.body.order;
  if (!Array.isArray(order)) return res.status(400).json({ error: 'order array required' });

  try {
    const meta = await readMeta();
    const item = meta.find(m => m.id === id);
    if (!item) return res.status(404).json({ error: 'story not found' });

    await writeTileOrder(id, order);
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'failed to reorder tiles' });
  }
});

// --- Highlight endpoints ---

// List highlights for a story (sorted alphabetically)
app.get('/api/story/:id/highlights', async (req, res) => {
  const id = req.params.id;
  try {
    const meta = await readMeta();
    const item = meta.find(m => m.id === id);
    if (!item) return res.status(404).json({ error: 'story not found' });

    const highlightsDir = path.join(storyDir(id), 'highlights');
    let files = [];
    try {
      files = (await fs.readdir(highlightsDir)).filter(f => f.endsWith('.md'));
    } catch (e) {
      files = [];
    }
    // Sort alphabetically
    files.sort((a, b) => a.localeCompare(b));
    const highlights = files.map(f => ({ filename: f, name: f.replace(/\.md$/, '') }));
    res.json(highlights);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'failed to list highlights' });
  }
});

// Create a new highlight (auto-named highlight-N)
app.post('/api/story/:id/highlights', async (req, res) => {
  const id = req.params.id;
  try {
    const meta = await readMeta();
    const item = meta.find(m => m.id === id);
    if (!item) return res.status(404).json({ error: 'story not found' });

    const highlightsDir = path.join(storyDir(id), 'highlights');
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
    const filePath = path.join(highlightsDir, filename);

    await fs.writeFile(filePath, '', 'utf8');
    res.json({ filename, name: `highlight-${num}` });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'failed to create highlight' });
  }
});

// Get highlight content
app.get('/api/story/:id/highlights/:filename', async (req, res) => {
  const id = req.params.id;
  const filename = req.params.filename;
  try {
    const meta = await readMeta();
    const item = meta.find(m => m.id === id);
    if (!item) return res.status(404).json({ error: 'story not found' });

    const filePath = path.join(storyDir(id), 'highlights', filename);
    let content = '';
    try {
      content = await fs.readFile(filePath, 'utf8');
    } catch (e) {
      return res.status(404).json({ error: 'highlight not found' });
    }
    res.json({ filename, name: filename.replace(/\.md$/, ''), content });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'failed to read highlight' });
  }
});

// Save highlight content
app.post('/api/story/:id/highlights/:filename/save', async (req, res) => {
  const id = req.params.id;
  const filename = req.params.filename;
  if (!req.body || typeof req.body.content !== 'string') {
    return res.status(400).json({ error: 'content required' });
  }
  try {
    const meta = await readMeta();
    const item = meta.find(m => m.id === id);
    if (!item) return res.status(404).json({ error: 'story not found' });

    const filePath = path.join(storyDir(id), 'highlights', filename);
    try {
      await fs.access(filePath);
    } catch (e) {
      return res.status(404).json({ error: 'highlight not found' });
    }
    await fs.writeFile(filePath, req.body.content, 'utf8');
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'failed to save highlight' });
  }
});

// Rename highlight
app.post('/api/story/:id/highlights/:filename/rename', async (req, res) => {
  const id = req.params.id;
  const filename = req.params.filename;
  const newName = (req.body && req.body.name) ? String(req.body.name) : undefined;
  if (!newName) return res.status(400).json({ error: 'name required' });

  try {
    const meta = await readMeta();
    const item = meta.find(m => m.id === id);
    if (!item) return res.status(404).json({ error: 'story not found' });

    const highlightsDir = path.join(storyDir(id), 'highlights');
    const oldPath = path.join(highlightsDir, filename);
    try {
      await fs.access(oldPath);
    } catch (e) {
      return res.status(404).json({ error: 'highlight not found' });
    }

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
    }

    res.json({ filename: newFilename, name: newName });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'failed to rename highlight' });
  }
});

// Delete highlight
app.delete('/api/story/:id/highlights/:filename', async (req, res) => {
  const id = req.params.id;
  const filename = req.params.filename;
  try {
    const meta = await readMeta();
    const item = meta.find(m => m.id === id);
    if (!item) return res.status(404).json({ error: 'story not found' });

    const filePath = path.join(storyDir(id), 'highlights', filename);
    try {
      await fs.unlink(filePath);
    } catch (e) {
      return res.status(404).json({ error: 'highlight not found' });
    }
    res.json({ ok: true, filename });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'failed to delete highlight' });
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
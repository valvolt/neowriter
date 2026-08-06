require('dotenv').config();
const express = require('express');
const fs = require('fs').promises;
const fsSync = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');

const app = express();
const PORT = process.env.PORT || 3000;

// Detect mode: if Auth0 env vars are present, run in hosted mode
const LOCAL_MODE = !process.env.CLIENT_ID;
const DEFAULT_USER = 'anonymous';

const ROOT = __dirname;
const DATA_DIR = path.join(ROOT, 'data');
const PUBLIC_DIR = path.join(ROOT, 'public');

// --- Auth0 setup (hosted mode only) ---
if (!LOCAL_MODE) {
  const { auth } = require('express-openid-connect');
  app.use(
    auth({
      authRequired: false,
      auth0Logout: true,
      secret: process.env.SECRET,
      baseURL: process.env.BASE_URL,
      clientID: process.env.CLIENT_ID,
      issuerBaseURL: process.env.ISSUER_BASE_URL,
    })
  );
}

app.use(express.json({ limit: '50mb' }));
// Serve static assets but NOT index.html (we serve it dynamically)
app.use(express.static(PUBLIC_DIR, { index: false }));

// --- User helpers ---

// Sanitize an email/username into a safe directory name
function sanitizeUsername(email) {
  let s = String(email).trim().toLowerCase();
  s = s.replace(/@/g, '-');
  s = s.replace(/[^a-z0-9\-\.]/g, '-');
  s = s.replace(/-{2,}/g, '-');
  s = s.replace(/^-+|-+$/g, '');
  return s || 'unknown';
}

// Get the current username from the request
function getUsername(req) {
  if (LOCAL_MODE) return DEFAULT_USER;
  if (req.oidc && req.oidc.isAuthenticated() && req.oidc.user) {
    return sanitizeUsername(req.oidc.user.email || req.oidc.user.name || 'unknown');
  }
  return null; // not authenticated
}

// Get the display name (email) for the client
function getDisplayName(req) {
  if (LOCAL_MODE) return DEFAULT_USER;
  if (req.oidc && req.oidc.isAuthenticated() && req.oidc.user) {
    return req.oidc.user.email || req.oidc.user.name || 'unknown';
  }
  return null;
}

// Middleware: require authentication for API routes in hosted mode
function requireUser(req, res, next) {
  if (LOCAL_MODE) return next();
  if (!req.oidc || !req.oidc.isAuthenticated()) {
    return res.status(401).json({ error: 'authentication required' });
  }
  next();
}

// Sanitize a user-provided name into a safe filename (without extension).
// Normalize Unicode (NFD) to strip accents, lowercase, replace spaces/underscores with hyphens,
// strip non-alphanumeric (except hyphens), collapse multiple hyphens, trim hyphens.
function sanitizeFilename(name) {
  let s = String(name).trim();
  // NFD decomposition: split accented chars into base + combining mark, then strip combining marks
  s = s.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  s = s.toLowerCase();
  s = s.replace(/[\s_]+/g, '-');
  s = s.replace(/[^a-z0-9\-]/g, '');
  s = s.replace(/-{2,}/g, '-');
  s = s.replace(/^-+|-+$/g, '');
  return s || 'untitled';
}

// --- Per-user data helpers ---

function userDir(username) {
  return path.join(DATA_DIR, username);
}

function metaFile(username) {
  return path.join(userDir(username), 'metadata.json');
}

// Ensure data directory and metadata file exist for a user.
async function ensureUserData(username) {
  const dir = userDir(username);
  await fs.mkdir(dir, { recursive: true });
  const mf = metaFile(username);
  try {
    await fs.access(mf);
  } catch (e) {
    await fs.writeFile(mf, JSON.stringify([], null, 2), 'utf8');
  }
}

// Ensure base data directory exists (called once at startup)
async function ensureData() {
  await fs.mkdir(DATA_DIR, { recursive: true });
  if (LOCAL_MODE) {
    await ensureUserData(DEFAULT_USER);
  }
}

async function readMeta(username) {
  const mf = metaFile(username);
  const raw = await fs.readFile(mf, 'utf8');
  return JSON.parse(raw);
}

async function writeMeta(username, meta) {
  const mf = metaFile(username);
  await fs.writeFile(mf, JSON.stringify(meta, null, 2), 'utf8');
}

// Get the base directory for a story
function storyDir(username, id) {
  return path.join(userDir(username), id);
}

// --- Serve index.html dynamically (inject user info) ---

app.get('/', async (req, res) => {
  if (!LOCAL_MODE && (!req.oidc || !req.oidc.isAuthenticated())) {
    // Show login page with published stories for unauthenticated users
    let storiesHtml = '';
    try {
      let userDirs = [];
      try { userDirs = await fs.readdir(DATA_DIR); } catch (e) {}
      const published = [];
      for (const udir of userDirs) {
        const upath = path.join(DATA_DIR, udir);
        try {
          const stat = await fs.stat(upath);
          if (!stat.isDirectory()) continue;
          const mf = path.join(upath, 'metadata.json');
          const raw = await fs.readFile(mf, 'utf8');
          const meta = JSON.parse(raw);
          for (const item of meta) {
            if (item.published) {
              published.push({ id: item.id, name: item.name, author: item.author || udir, username: udir });
            }
          }
        } catch (e) { /* skip */ }
      }
      if (published.length > 0) {
        storiesHtml = '<div class="stories"><h2>Published Stories</h2><ul>' +
          published.map(s => `<li><a href="/read/${s.username}/${s.id}">${s.name}</a><span class="author">by ${s.author}</span></li>`).join('') +
          '</ul></div>';
      }
    } catch (e) { /* ignore */ }

    return res.type('html').send(`
      <!doctype html>
      <html><head><title>Neo Writer</title>
      <style>body{font-family:system-ui;display:flex;flex-direction:column;align-items:center;justify-content:center;min-height:100vh;margin:0;padding:24px;background:#f7f7f8;}
      .card{text-align:center;padding:40px;background:#fff;border-radius:12px;box-shadow:0 4px 24px rgba(0,0,0,0.08);margin-bottom:24px;}
      h1{color:#2b7cff;margin-bottom:24px;}
      a{display:inline-block;margin:8px;padding:12px 24px;background:#2b7cff;color:#fff;text-decoration:none;border-radius:6px;font-weight:500;}
      a:hover{opacity:0.9;} a.secondary{background:#f0f0f2;color:#333;}
      .stories{background:#fff;border-radius:12px;box-shadow:0 2px 12px rgba(0,0,0,0.04);padding:24px 32px;max-width:600px;width:100%;}
      .stories h2{margin:0 0 16px;font-size:18px;color:#333;}
      .stories ul{list-style:none;padding:0;margin:0;}
      .stories li{padding:10px 0;border-bottom:1px solid #eee;display:flex;align-items:center;gap:12px;}
      .stories li:last-child{border-bottom:none;}
      .stories li a{display:inline;margin:0;padding:0;background:none;color:#2b7cff;font-weight:500;font-size:15px;text-decoration:none;}
      .stories li a:hover{text-decoration:underline;}
      .stories .author{font-size:13px;color:#888;}</style>
      </head><body><div class="card"><h1>Neo Writer</h1><p>Please log in to continue.</p>
      <a href="/login">Log in</a><a href="/signup" class="secondary">Sign up</a></div>${storiesHtml}</body></html>
    `);
  }

  const username = getUsername(req) || DEFAULT_USER;
  const displayName = getDisplayName(req) || DEFAULT_USER;
  const localMode = LOCAL_MODE;

  // Read and inject into index.html
  const indexPath = path.join(PUBLIC_DIR, 'index.html');
  let html = fsSync.readFileSync(indexPath, 'utf8');
  // Replace the placeholder script block
  html = html.replace(
    /<!-- expose local_mode and username to the client -->\s*<script>[\s\S]*?<\/script>/,
    `<!-- expose local_mode and username to the client -->
  <script>
    window.local_mode = ${localMode};
    window.username = ${JSON.stringify(displayName)};
  </script>`
  );
  res.type('html').send(html);
});

// Signup route (hosted mode)
app.get('/signup', (req, res) => {
  if (LOCAL_MODE) return res.redirect('/');
  res.oidc.login({
    returnTo: '/',
    authorizationParams: { screen_hint: 'signup' },
  });
});

// Apply requireUser to all API routes
app.use('/api', requireUser);

// List stories
app.get('/api/list', async (req, res) => {
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

// Create story
app.post('/api/create', async (req, res) => {
  const name = (req.body && req.body.name) ? String(req.body.name) : 'Untitled';
  try {
    const username = getUsername(req);
    await ensureUserData(username);
    const id = uuidv4();
    const meta = await readMeta(username);
    const author = getDisplayName(req) || username;
    meta.push({ id, name, author });
    await writeMeta(username, meta);

    const dir = storyDir(username, id);
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

// Get story metadata
app.get('/api/story/:id', async (req, res) => {
  const id = req.params.id;
  try {
    const username = getUsername(req);
    const meta = await readMeta(username);
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
    const username = getUsername(req);
    const meta = await readMeta(username);
    const idx = meta.findIndex(m => m.id === id);
    if (idx === -1) return res.status(404).json({ error: 'not found' });
    meta.splice(idx, 1);
    await writeMeta(username, meta);

    const dir = storyDir(username, id);
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

async function readTileOrder(username, id) {
  const orderFile = path.join(storyDir(username, id), 'tiles', '_order.json');
  try {
    const raw = await fs.readFile(orderFile, 'utf8');
    return JSON.parse(raw);
  } catch (e) {
    return null; // no order file yet
  }
}

async function writeTileOrder(username, id, order) {
  const orderFile = path.join(storyDir(username, id), 'tiles', '_order.json');
  await fs.writeFile(orderFile, JSON.stringify(order, null, 2), 'utf8');
}

// --- Display names helpers (_names.json) ---

async function readNames(dirPath) {
  const namesFile = path.join(dirPath, '_names.json');
  try {
    const raw = await fs.readFile(namesFile, 'utf8');
    return JSON.parse(raw);
  } catch (e) {
    return {}; // no names file yet — fallback to filename-derived names
  }
}

async function writeNames(dirPath, names) {
  const namesFile = path.join(dirPath, '_names.json');
  await fs.writeFile(namesFile, JSON.stringify(names, null, 2), 'utf8');
}

// Get display name for a file: check _names.json, fallback to filename without .md
function getDisplayNameForFile(names, filename) {
  if (names && names[filename]) return names[filename];
  return filename.replace(/\.md$/, '');
}

// --- Global Todo endpoint (all stories) ---

app.get('/api/todo', async (req, res) => {
  try {
    const username = getUsername(req);
    await ensureUserData(username);
    const meta = await readMeta(username);
    const unchecked = [];
    const checked = [];

    for (const story of meta) {
      const id = story.id;
      const order = await readTileOrder(username, id);
      const dirs = ['tiles', 'highlights'];

      for (const dir of dirs) {
        const mdDir = path.join(storyDir(username, id), dir);

        let files = [];
        try {
          files = (await fs.readdir(mdDir)).filter(f => f.endsWith('.md'));
        } catch (e) {
          continue;
        }

        let ordered = files;
        if (dir === 'tiles' && order && Array.isArray(order)) {
          const fileSet = new Set(files);
          ordered = order.filter(f => fileSet.has(f));
          for (const f of files) {
            if (!order.includes(f)) ordered.push(f);
          }
        }

        for (const filename of ordered) {
          const filePath = path.join(mdDir, filename);

          let content = '';
          try {
            content = await fs.readFile(filePath, 'utf8');
          } catch (e) {
            continue;
          }

          const lines = content.split('\n');

          lines.forEach((line, lineIndex) => {
            const uncheckedMatch = line.match(/^(\s*)-\s\[ \]\s(.+)$/);
            const checkedMatch = line.match(/^(\s*)-\s\[x\]\s(.+)$/i);

            if (uncheckedMatch) {
              unchecked.push({
                text: uncheckedMatch[2].trim(),
                checked: false,
                filename,
                directory: dir,
                lineIndex,
                storyId: id,
                storyName: story.name
              });
            } else if (checkedMatch) {
              checked.push({
                text: checkedMatch[2].trim(),
                checked: true,
                filename,
                directory: dir,
                lineIndex,
                storyId: id,
                storyName: story.name
              });
            }
          });
        }
      }
    }

    res.json([...unchecked, ...checked]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'failed to aggregate global todos' });
  }
});

// --- Per-story Todo endpoint ---

// Aggregate all task list items from all tiles and highlights, unchecked first
app.get('/api/story/:id/todo', async (req, res) => {
  const id = req.params.id;

  try {
    const username = getUsername(req);
    const meta = await readMeta(username);
    const item = meta.find(m => m.id === id);
    if (!item) return res.status(404).json({ error: 'story not found' });

    const order = await readTileOrder(username, id);

    const unchecked = [];
    const checked = [];

    const dirs = ['tiles', 'highlights'];

    for (const dir of dirs) {
      const mdDir = path.join(storyDir(username, id), dir);

      let files = [];
      try {
        files = (await fs.readdir(mdDir)).filter(f => f.endsWith('.md'));
      } catch (e) {
        continue; // directory doesn't exist
      }

      // Only apply ordering to tiles
      let ordered = files;
      if (dir === 'tiles' && order && Array.isArray(order)) {
        const fileSet = new Set(files);
        ordered = order.filter(f => fileSet.has(f));
        for (const f of files) {
          if (!order.includes(f)) ordered.push(f);
        }
      }

      for (const filename of ordered) {
        const filePath = path.join(mdDir, filename);

        let content = '';
        try {
          content = await fs.readFile(filePath, 'utf8');
        } catch (e) {
          continue;
        }

        const lines = content.split('\n');

        lines.forEach((line, lineIndex) => {
          const uncheckedMatch = line.match(/^(\s*)-\s\[ \]\s(.+)$/);
          const checkedMatch = line.match(/^(\s*)-\s\[x\]\s(.+)$/i);

          if (uncheckedMatch) {
            unchecked.push({
              text: uncheckedMatch[2].trim(),
              checked: false,
              filename,
              directory: dir,
              lineIndex
            });
          } else if (checkedMatch) {
            checked.push({
              text: checkedMatch[2].trim(),
              checked: true,
              filename,
              directory: dir,
              lineIndex
            });
          }
        });
      }
    }

    res.json([...unchecked, ...checked]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'failed to aggregate todos' });
  }
});

// Toggle a todo item (check/uncheck) in its source file
app.post('/api/story/:id/todo/toggle', async (req, res) => {
  const id = req.params.id;
  const { directory, filename, lineIndex, checked } = req.body || {};

  if (!directory || !filename || lineIndex === undefined || checked === undefined) {
    return res.status(400).json({
      error: 'directory, filename, lineIndex, checked required'
    });
  }

  // Prevent arbitrary path access
  if (!['tiles', 'highlights'].includes(directory)) {
    return res.status(400).json({ error: 'invalid directory' });
  }

  try {
    const username = getUsername(req);
    const meta = await readMeta(username);
    const item = meta.find(m => m.id === id);
    if (!item) return res.status(404).json({ error: 'story not found' });

    const filePath = path.join(storyDir(username, id), directory, filename);

    let content = '';
    try {
      content = await fs.readFile(filePath, 'utf8');
    } catch (e) {
      return res.status(404).json({ error: 'file not found' });
    }

    const lines = content.split('\n');

    if (lineIndex < 0 || lineIndex >= lines.length) {
      return res.status(400).json({ error: 'lineIndex out of range' });
    }

    if (checked) {
      lines[lineIndex] = lines[lineIndex].replace(/^(\s*-\s)\[ \]/, '$1[x]');
    } else {
      lines[lineIndex] = lines[lineIndex].replace(/^(\s*-\s)\[x\]/i, '$1[ ]');
    }

    await fs.writeFile(filePath, lines.join('\n'), 'utf8');

    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'failed to toggle todo' });
  }
});

// --- Tile endpoints ---

// List tiles for a story (respects _order.json)
app.get('/api/story/:id/tiles', async (req, res) => {
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

    // Apply ordering from _order.json
    const order = await readTileOrder(username, id);
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

    // Read display names
    const names = await readNames(tilesDir);
    const tiles = ordered.map(f => ({ filename: f, name: getDisplayNameForFile(names, f) }));
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
    const username = getUsername(req);
    const meta = await readMeta(username);
    const item = meta.find(m => m.id === id);
    if (!item) return res.status(404).json({ error: 'story not found' });

    const tilesDir = path.join(storyDir(username, id), 'tiles');
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
app.get('/api/story/:id/tiles/:filename', async (req, res) => {
  const id = req.params.id;
  const filename = req.params.filename;
  try {
    const username = getUsername(req);
    const meta = await readMeta(username);
    const item = meta.find(m => m.id === id);
    if (!item) return res.status(404).json({ error: 'story not found' });

    const tilesDir = path.join(storyDir(username, id), 'tiles');
    const filePath = path.join(tilesDir, filename);
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
app.post('/api/story/:id/tiles/:filename/save', async (req, res) => {
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

    const filePath = path.join(storyDir(username, id), 'tiles', filename);
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
    const username = getUsername(req);
    const meta = await readMeta(username);
    const item = meta.find(m => m.id === id);
    if (!item) return res.status(404).json({ error: 'story not found' });

    const tilesDir = path.join(storyDir(username, id), 'tiles');
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
      const order = await readTileOrder(username, id);
      if (order && Array.isArray(order)) {
        const idx = order.indexOf(filename);
        if (idx !== -1) {
          order[idx] = newFilename;
          await writeTileOrder(username, id, order);
        }
      }
    }

    // Save display name in _names.json (remove old entry if filename changed)
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
app.delete('/api/story/:id/tiles/:filename', async (req, res) => {
  const id = req.params.id;
  const filename = req.params.filename;
  try {
    const username = getUsername(req);
    const meta = await readMeta(username);
    const item = meta.find(m => m.id === id);
    if (!item) return res.status(404).json({ error: 'story not found' });

    const tilesDir = path.join(storyDir(username, id), 'tiles');
    const filePath = path.join(tilesDir, filename);
    try {
      await fs.unlink(filePath);
    } catch (e) {
      return res.status(404).json({ error: 'tile not found' });
    }

    // Remove from _order.json
    const order = await readTileOrder(username, id);
    if (order && Array.isArray(order)) {
      const idx = order.indexOf(filename);
      if (idx !== -1) {
        order.splice(idx, 1);
        await writeTileOrder(username, id, order);
      }
    }

    // Remove from _names.json
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
app.post('/api/story/:id/tiles/reorder', async (req, res) => {
  const id = req.params.id;
  const order = req.body && req.body.order;
  if (!Array.isArray(order)) return res.status(400).json({ error: 'order array required' });

  try {
    const username = getUsername(req);
    const meta = await readMeta(username);
    const item = meta.find(m => m.id === id);
    if (!item) return res.status(404).json({ error: 'story not found' });

    await writeTileOrder(username, id, order);
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'failed to reorder tiles' });
  }
});

// --- Highlight endpoints ---

// List highlights for a story (sorted alphabetically by display name)
app.get('/api/story/:id/highlights', async (req, res) => {
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
    // Read display names
    const names = await readNames(highlightsDir);
    const highlights = files.map(f => ({ filename: f, name: getDisplayNameForFile(names, f) }));
    // Sort alphabetically by display name
    highlights.sort((a, b) => a.name.localeCompare(b.name));
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
    const username = getUsername(req);
    const meta = await readMeta(username);
    const item = meta.find(m => m.id === id);
    if (!item) return res.status(404).json({ error: 'story not found' });

    const highlightsDir = path.join(storyDir(username, id), 'highlights');
    const filePath = path.join(highlightsDir, filename);
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
app.post('/api/story/:id/highlights/:filename/save', async (req, res) => {
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

    const filePath = path.join(storyDir(username, id), 'highlights', filename);
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
    const username = getUsername(req);
    const meta = await readMeta(username);
    const item = meta.find(m => m.id === id);
    if (!item) return res.status(404).json({ error: 'story not found' });

    const highlightsDir = path.join(storyDir(username, id), 'highlights');
    const oldPath = path.join(highlightsDir, filename);
    try {
      await fs.access(oldPath);
    } catch (e) {
      return res.status(404).json({ error: 'highlight not found' });
    }

    // Get the old display name from _names.json (fallback to filename without .md)
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
    }

    // Save display name in _names.json (remove old entry if filename changed)
    if (newFilename !== filename) {
      delete names[filename];
    }
    names[newFilename] = newName;
    await writeNames(highlightsDir, names);

    // Propagate rename into all tile files: replace oldName with newName (case-insensitive, Unicode-aware)
    const tilesDir = path.join(storyDir(username, id), 'tiles');
    let tileFiles = [];
    try {
      tileFiles = (await fs.readdir(tilesDir)).filter(f => f.endsWith('.md'));
    } catch (e) {
      tileFiles = [];
    }

    const escapedOld = oldName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const replaceRegex = new RegExp(escapedOld, 'giu');

    await Promise.all(tileFiles.map(async (tileFile) => {
      const tilePath = path.join(tilesDir, tileFile);
      try {
        const content = await fs.readFile(tilePath, 'utf8');
        if (!replaceRegex.test(content)) return;
        replaceRegex.lastIndex = 0;
        // Case-preserving replacement: match the case pattern of each occurrence
        const updated = content.replace(replaceRegex, (match) => {
          // Mirror the case pattern of the match onto newName
          if (match === match.toUpperCase()) return newName.toUpperCase();
          if (match[0] === match[0].toUpperCase()) {
            return newName.charAt(0).toUpperCase() + newName.slice(1);
          }
          return newName.toLowerCase();
        });
        if (updated !== content) {
          await fs.writeFile(tilePath, updated, 'utf8');
        }
      } catch (e) {
        console.error(`failed to update tile ${tileFile}`, e);
      }
    }));

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
    const username = getUsername(req);
    const meta = await readMeta(username);
    const item = meta.find(m => m.id === id);
    if (!item) return res.status(404).json({ error: 'story not found' });

    const highlightsDir = path.join(storyDir(username, id), 'highlights');
    const filePath = path.join(highlightsDir, filename);
    try {
      await fs.unlink(filePath);
    } catch (e) {
      return res.status(404).json({ error: 'highlight not found' });
    }

    // Remove from _names.json
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

// --- Picture endpoints ---

// Check if a picture exists
app.get('/api/story/:id/pictures/:filename', async (req, res) => {
  const id = req.params.id;
  const filename = req.params.filename;
  try {
    const username = getUsername(req);
    const meta = await readMeta(username);
    const item = meta.find(m => m.id === id);
    if (!item) return res.status(404).json({ error: 'story not found' });

    const filePath = path.join(storyDir(username, id), 'pictures', filename);
    try {
      await fs.access(filePath);
    } catch (e) {
      return res.status(404).json({ error: 'picture not found' });
    }
    // Serve the file
    res.sendFile(filePath);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'failed to serve picture' });
  }
});

// Check if picture exists (HEAD-like check via query)
app.get('/api/story/:id/pictures/:filename/exists', async (req, res) => {
  const id = req.params.id;
  const filename = req.params.filename;
  try {
    const username = getUsername(req);
    const filePath = path.join(storyDir(username, id), 'pictures', filename);
    try {
      await fs.access(filePath);
      res.json({ exists: true });
    } catch (e) {
      res.json({ exists: false });
    }
  } catch (err) {
    res.status(500).json({ error: 'check failed' });
  }
});

// Upload picture (base64 in JSON body or URL to download)
app.post('/api/story/:id/pictures', async (req, res) => {
  const id = req.params.id;
  const { name, data, url } = req.body || {};
  if (!name) return res.status(400).json({ error: 'name required (provide a filename for the picture)' });

  try {
    const username = getUsername(req);
    const meta = await readMeta(username);
    const item = meta.find(m => m.id === id);
    if (!item) return res.status(404).json({ error: 'story not found' });

    const picturesDir = path.join(storyDir(username, id), 'pictures');
    await fs.mkdir(picturesDir, { recursive: true });

    const sanitized = name; // trust the frontend to sanitize
    const filePath = path.join(picturesDir, sanitized);

    if (data) {
      // base64 encoded file data
      const buffer = Buffer.from(data, 'base64');
      await fs.writeFile(filePath, buffer);
      res.json({ ok: true, filename: sanitized, path: `/api/story/${id}/pictures/${sanitized}` });
    } else if (url) {
      // Download from URL using native http/https
      // Detect actual content type from response to correct the file extension
      const contentTypeToExt = {
        'image/webp': '.webp',
        'image/jpeg': '.jpg',
        'image/png': '.png',
        'image/gif': '.gif',
        'image/svg+xml': '.svg',
        'image/bmp': '.bmp',
        'image/tiff': '.tiff',
        'image/avif': '.avif',
        'image/heic': '.heic',
        'image/heif': '.heif'
      };
      try {
        const downloadUrl = new URL(url);
        const httpMod = downloadUrl.protocol === 'https:' ? require('https') : require('http');
        let actualFilename = sanitized;
        await new Promise((resolve, reject) => {
          const doGet = (targetUrl) => {
            const mod = (typeof targetUrl === 'string' && targetUrl.startsWith('https:')) ? require('https') : httpMod;
            const reqOpts = typeof targetUrl === 'string' ? targetUrl : targetUrl;
            const parsedUrl = new URL(typeof targetUrl === 'string' ? targetUrl : url);
            const options = {
              hostname: parsedUrl.hostname,
              path: parsedUrl.pathname + parsedUrl.search,
              headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36' }
            };
            mod.get(options, (response) => {
              if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
                doGet(response.headers.location);
              } else if (response.statusCode !== 200) {
                reject(new Error(`Server returned status ${response.statusCode}`));
              } else {
                // Detect actual content type and validate it's an image
                const contentType = (response.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
                if (!contentType || !contentType.startsWith('image/')) {
                  reject(new Error('NOT_IMAGE'));
                  response.resume(); // drain the response
                  return;
                }
                if (contentTypeToExt[contentType]) {
                  const correctExt = contentTypeToExt[contentType];
                  // Replace the extension in the filename if it differs
                  const currentExt = path.extname(actualFilename).toLowerCase();
                  if (currentExt !== correctExt) {
                    const baseName = actualFilename.substring(0, actualFilename.length - currentExt.length);
                    actualFilename = baseName + correctExt;
                  }
                }
                const chunks = [];
                response.on('data', chunk => chunks.push(chunk));
                response.on('end', async () => {
                  const buffer = Buffer.concat(chunks);
                  const actualPath = path.join(picturesDir, actualFilename);
                  // Check if file already exists (unless overwrite is requested)
                  if (!req.body.overwrite) {
                    try {
                      await fs.access(actualPath);
                      // File exists — reject with EXISTS error
                      reject(new Error('EXISTS:' + actualFilename));
                      return;
                    } catch (e) {
                      // File doesn't exist — proceed
                    }
                  }
                  await fs.writeFile(actualPath, buffer);
                  resolve();
                });
                response.on('error', reject);
              }
            }).on('error', reject);
          };
          doGet(url);
        });
        res.json({ ok: true, filename: actualFilename, path: `/api/story/${id}/pictures/${encodeURIComponent(actualFilename)}` });
      } catch (e) {
        if (e.message && e.message.startsWith('EXISTS:')) {
          // File already exists — return structured response for client to handle
          const existingFilename = e.message.substring(7);
          res.json({ ok: false, error: 'EXISTS:' + existingFilename });
        } else if (e.message === 'NOT_IMAGE') {
          console.error('Failed to download image from URL', e);
          res.status(400).json({ error: 'Could not download the image (the server may be blocking automated downloads). Please save the file to your disk first, then upload it.' });
        } else {
          console.error('Failed to download image from URL', e);
          res.status(400).json({ error: 'Failed to download from URL. Please save the file to your disk first, then upload it.' });
        }
      }
    } else {
      res.status(400).json({ error: 'data or url required' });
    }
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'failed to upload picture' });
  }
});

// --- Publish feature ---

// Toggle publish state for a story
app.post('/api/story/:id/publish', async (req, res) => {
  const id = req.params.id;
  const published = !!(req.body && req.body.published);
  try {
    const username = getUsername(req);
    const meta = await readMeta(username);
    const item = meta.find(m => m.id === id);
    if (!item) return res.status(404).json({ error: 'not found' });
    item.published = published;
    await writeMeta(username, meta);
    res.json({ id, published });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'failed to update publish state' });
  }
});

// Get publish state for a story
app.get('/api/story/:id/published', async (req, res) => {
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

// --- Public routes (no authentication required) ---

// List all published stories across all users
app.get('/public/stories', async (req, res) => {
  try {
    const entries = [];
    let userDirs;
    try {
      userDirs = await fs.readdir(DATA_DIR);
    } catch (e) {
      return res.json([]);
    }
    for (const udir of userDirs) {
      const upath = path.join(DATA_DIR, udir);
      const stat = await fs.stat(upath);
      if (!stat.isDirectory()) continue;
      const mf = path.join(upath, 'metadata.json');
      try {
        const raw = await fs.readFile(mf, 'utf8');
        const meta = JSON.parse(raw);
        for (const item of meta) {
          if (item.published) {
            entries.push({ id: item.id, name: item.name, author: item.author || udir, username: udir });
          }
        }
      } catch (e) {
        // skip users with no/invalid metadata
      }
    }
    res.json(entries);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'failed to list published stories' });
  }
});

// Read a published story (full content, all tiles concatenated)
app.get('/public/story/:username/:id', async (req, res) => {
  const { username, id } = req.params;
  try {
    const mf = path.join(DATA_DIR, username, 'metadata.json');
    const raw = await fs.readFile(mf, 'utf8');
    const meta = JSON.parse(raw);
    const item = meta.find(m => m.id === id);
    if (!item || !item.published) return res.status(404).json({ error: 'not found or not published' });

    // Read tiles in order
    const tilesDir = path.join(DATA_DIR, username, id, 'tiles');
    let order = [];
    try {
      const orderRaw = await fs.readFile(path.join(tilesDir, '_order.json'), 'utf8');
      order = JSON.parse(orderRaw);
    } catch (e) {
      // fallback: read directory
      try {
        const files = await fs.readdir(tilesDir);
        order = files.filter(f => f.endsWith('.md')).sort();
      } catch (e2) {
        order = [];
      }
    }

    let content = '';
    for (const filename of order) {
      try {
        const tile = await fs.readFile(path.join(tilesDir, filename), 'utf8');
        content += (content ? '\n\n' : '') + tile;
      } catch (e) {
        // skip unreadable tiles
      }
    }

    res.json({ id, name: item.name, author: item.author || username, content });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'failed to read published story' });
  }
});

// Serve pictures from published stories
app.get('/public/story/:username/:id/pictures/:filename', async (req, res) => {
  const { username, id, filename } = req.params;
  try {
    // Verify story is published
    const mf = path.join(DATA_DIR, username, 'metadata.json');
    const raw = await fs.readFile(mf, 'utf8');
    const meta = JSON.parse(raw);
    const item = meta.find(m => m.id === id);
    if (!item || !item.published) return res.status(404).send('Not found');

    const filePath = path.join(DATA_DIR, username, id, 'pictures', filename);
    try {
      await fs.access(filePath);
      res.sendFile(filePath);
    } catch (e) {
      res.status(404).send('Not found');
    }
  } catch (err) {
    res.status(404).send('Not found');
  }
});

// Serve the reader page for published stories
app.get('/read/:username/:id', async (req, res) => {
  const { username, id } = req.params;
  try {
    // Verify story is published
    const mf = path.join(DATA_DIR, username, 'metadata.json');
    const raw = await fs.readFile(mf, 'utf8');
    const meta = JSON.parse(raw);
    const item = meta.find(m => m.id === id);
    if (!item || !item.published) return res.status(404).send('Story not found');

    const readerPath = path.join(PUBLIC_DIR, 'reader.html');
    res.sendFile(readerPath);
  } catch (err) {
    res.status(404).send('Story not found');
  }
});

// Fallback to dynamic index.html for SPA navigation
app.get('*', (req, res) => {
  if (!LOCAL_MODE && (!req.oidc || !req.oidc.isAuthenticated())) {
    return res.redirect('/');
  }

  const username = getUsername(req) || DEFAULT_USER;
  const displayName = getDisplayName(req) || DEFAULT_USER;
  const localMode = LOCAL_MODE;

  const indexPath = path.join(PUBLIC_DIR, 'index.html');
  let html = fsSync.readFileSync(indexPath, 'utf8');
  html = html.replace(
    /<!-- expose local_mode and username to the client -->\s*<script>[\s\S]*?<\/script>/,
    `<!-- expose local_mode and username to the client -->
  <script>
    window.local_mode = ${localMode};
    window.username = ${JSON.stringify(displayName)};
  </script>`
  );
  res.type('html').send(html);
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
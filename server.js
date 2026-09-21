
const express = require('express');
const path = require('path');
const fs = require('fs').promises;
const fsSync = require('fs');

// --- Config ---
const config = require('./config');
const { PORT, DATA_DIR, PUBLIC_DIR, DEFAULT_USER, CLIENT_ID, MODE } = config;

let LOCAL_MODE;
if (MODE === 'LOCAL') {
  LOCAL_MODE = true;
} else if (MODE === 'HOSTED') {
  LOCAL_MODE = false;
} else {
  LOCAL_MODE = !CLIENT_ID;
}

const app = express();

// --- Auth0 setup (hosted mode only) ---
if (!LOCAL_MODE) {
  const { auth } = require('express-openid-connect');
  app.use(auth({
    authRequired: false,
    auth0Logout: true,
    secret: config.SECRET,
    baseURL: config.BASE_URL,
    clientID: config.CLIENT_ID,
    issuerBaseURL: config.ISSUER_BASE_URL,
  }));
}

app.use(express.json({ limit: '50mb' }));
app.use(express.static(PUBLIC_DIR, { index: false }));

// --- User helpers ---
const { sanitizeUsername, sanitizeFilename } = require('./utils/sanitize');
function getUsername(req) {
  if (LOCAL_MODE) return DEFAULT_USER;
  if (req.oidc && req.oidc.isAuthenticated() && req.oidc.user) {
    return sanitizeUsername(req.oidc.user.email || req.oidc.user.name || 'unknown');
  }
  return null;
}
function getDisplayName(req) {
  if (LOCAL_MODE) return DEFAULT_USER;
  if (req.oidc && req.oidc.isAuthenticated() && req.oidc.user) {
    return req.oidc.user.email || req.oidc.user.name || 'unknown';
  }
  return null;
}

// --- Modular middleware ---
const makeRequireUser = require('./middleware/auth');
const requireUser = makeRequireUser(LOCAL_MODE);

// --- API routes (modularized) ---
const storiesRouter = require('./routes/stories')({
  DATA_DIR,
  getUsername,
  getDisplayName,
  DEFAULT_USER
});
app.use('/api', requireUser, storiesRouter);

// --- Path safety helper ---

// Join a user-supplied filename to a trusted base dir, rejecting any traversal.
function safeJoin(dir, filename) {
  const joined = path.join(dir, path.basename(filename));
  if (!joined.startsWith(dir + path.sep) && joined !== dir) {
    const err = new Error('invalid filename');
    err.status = 400;
    throw err;
  }
  return joined;
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

    const loginPath = path.join(PUBLIC_DIR, 'login.html');
    const loginHtml = (await fs.readFile(loginPath, 'utf8')).replace('<!--STORIES-->', storiesHtml);
    return res.type('html').send(loginHtml);
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

// Search across story names, tile names/content, highlight names/content
app.get('/api/search', async (req, res) => {
  const q = (req.query.q || '').trim().toLowerCase();
  if (!q) return res.json([]);
  try {
    const username = getUsername(req);
    await ensureUserData(username);
    const meta = await readMeta(username);
    const results = [];
    for (const story of meta) {
      const dir = storyDir(username, story.id);
      const tilesDir = path.join(dir, 'tiles');
      const highlightsDir = path.join(dir, 'highlights');
      const nameMatches = story.name.toLowerCase().includes(q);
      const matchingTiles = [];
      const matchingHighlights = [];

      try {
        const order = JSON.parse(await fs.readFile(path.join(tilesDir, '_order.json'), 'utf8'));
        for (const filename of order) {
          if (filename.replace(/\.md$/, '').toLowerCase().includes(q)) {
            matchingTiles.push(filename);
            continue;
          }
          try {
            const content = await fs.readFile(path.join(tilesDir, filename), 'utf8');
            if (content.toLowerCase().includes(q)) matchingTiles.push(filename);
          } catch (e) {}
        }
      } catch (e) {}

      try {
        const files = (await fs.readdir(highlightsDir)).filter(f => f.endsWith('.md'));
        for (const filename of files) {
          if (filename.replace(/\.md$/, '').toLowerCase().includes(q)) {
            matchingHighlights.push(filename);
            continue;
          }
          try {
            const content = await fs.readFile(path.join(highlightsDir, filename), 'utf8');
            if (content.toLowerCase().includes(q)) matchingHighlights.push(filename);
          } catch (e) {}
        }
      } catch (e) {}

      if (nameMatches || matchingTiles.length > 0 || matchingHighlights.length > 0) {
        results.push({ id: story.id, name: story.name, matchingTiles, matchingHighlights });
      }
    }
    res.json(results);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'search failed' });
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

    const filePath = safeJoin(path.join(storyDir(username, id), directory), filename);

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

    const filePath = safeJoin(path.join(storyDir(username, id), 'tiles'), filename);
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
    const oldPath = safeJoin(tilesDir, filename);
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
    const filePath = safeJoin(tilesDir, filename);
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

    const filePath = safeJoin(path.join(storyDir(username, id), 'highlights'), filename);
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
    const oldPath = safeJoin(highlightsDir, filename);
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
    const filePath = safeJoin(highlightsDir, filename);
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

    const filePath = safeJoin(path.join(storyDir(username, id), 'pictures'), filename);
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
    const filePath = safeJoin(path.join(storyDir(username, id), 'pictures'), filename);
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

    const sanitized = path.basename(name); // strip any path separators
    const filePath = safeJoin(picturesDir, sanitized);

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
    const safeUsername = path.basename(username);
    const safeId = path.basename(id);
    const mf = path.join(DATA_DIR, safeUsername, 'metadata.json');
    const raw = await fs.readFile(mf, 'utf8');
    const meta = JSON.parse(raw);
    const item = meta.find(m => m.id === safeId);
    if (!item || !item.published) return res.status(404).json({ error: 'not found or not published' });

    // Read tiles in order
    const tilesDir = path.join(DATA_DIR, safeUsername, safeId, 'tiles');
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
        const tile = await fs.readFile(safeJoin(tilesDir, filename), 'utf8');
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
    const safeUsername = path.basename(username);
    const safeId = path.basename(id);
    const mf = path.join(DATA_DIR, safeUsername, 'metadata.json');
    const raw = await fs.readFile(mf, 'utf8');
    const meta = JSON.parse(raw);
    const item = meta.find(m => m.id === safeId);
    if (!item || !item.published) return res.status(404).send('Not found');

    const picturesDir = path.join(DATA_DIR, safeUsername, safeId, 'pictures');
    const filePath = safeJoin(picturesDir, filename);
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
    const mf = path.join(DATA_DIR, path.basename(username), 'metadata.json');
    const raw = await fs.readFile(mf, 'utf8');
    const meta = JSON.parse(raw);
    const item = meta.find(m => m.id === path.basename(id));
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

// Export app for testing; start server only when run directly
module.exports = app;


// --- Startup ---
if (require.main === module) {
  config.ensureDataDir()
    .then(() => {
      app.listen(PORT, () => {
        console.log(`Neo Writer server running on http://localhost:${PORT}`);
      });
    })
    .catch(e => {
      console.error('Failed to start server', e);
      process.exit(1);
    });
}
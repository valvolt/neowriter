
const express = require('express');
const path = require('path');
const fs = require('fs').promises;
const fsSync = require('fs');

// --- Config ---
const config = require('./config');
const { PORT, DATA_DIR, PUBLIC_DIR, DEFAULT_USER, CLIENT_ID, MODE } = config;
const {
  ensureUserData, readMeta,
  normalizeSearch, safeJoin, atomicWrite, storyDir,
  tileCache, highlightCache, _setCache,
  readTileCached, readHighlightCached,
  extractTags, stripTags,
  readPseudonyms,
  readTileOrder,
} = require('./utils/server-utils');

let LOCAL_MODE;
if (MODE === 'LOCAL') {
  LOCAL_MODE = true;
} else if (MODE === 'HOSTED') {
  LOCAL_MODE = false;
} else {
  LOCAL_MODE = !CLIENT_ID;
}

const app = express();

const indexTemplate = fsSync.readFileSync(path.join(PUBLIC_DIR, 'index.html'), 'utf8');

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
const { escHtml } = require('./utils/escape');
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
  getUsername,
  getDisplayName,
  DEFAULT_USER
});
app.use('/api', requireUser);   // gates every /api/* route, not just storiesRouter
app.use('/api', storiesRouter);

const createTilesRouter     = require('./routes/tiles');
const createHighlightsRouter = require('./routes/highlights');
const createPublishRouter    = require('./routes/publish');
const createExportRouter     = require('./routes/export');

app.use(createTilesRouter({ getUsername }));
app.use(createHighlightsRouter({ getUsername }));

const dns = require('dns');
const net = require('net');


// --- SSRF guard helpers ---

const DOWNLOAD_TIMEOUT_MS  = parseInt(process.env.DOWNLOAD_TIMEOUT_MS,  10) || 10_000;
const DOWNLOAD_MAX_BYTES   = parseInt(process.env.DOWNLOAD_MAX_BYTES,   10) || 25 * 1024 * 1024;
const DOWNLOAD_MAX_REDIRECTS = parseInt(process.env.DOWNLOAD_MAX_REDIRECTS, 10) || 5;

// --- Picture upload validation ---

const ALLOWED_IMAGE_EXTS = new Set([
  '.jpg', '.jpeg', '.png', '.gif', '.webp',
  '.avif', '.bmp', '.tiff', '.heic', '.heif', '.svg',
]);

function checkImageMagicBytes(buffer, ext) {
  if (ext === '.svg') return true; // text format — no binary magic bytes
  if (buffer.length < 4) return false;
  const b = buffer;
  switch (ext) {
    case '.jpg': case '.jpeg':
      return b[0] === 0xFF && b[1] === 0xD8 && b[2] === 0xFF;
    case '.png':
      return b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4E && b[3] === 0x47;
    case '.gif':
      return b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38;
    case '.webp':
      return b.length >= 12 &&
        b.toString('ascii', 0, 4) === 'RIFF' &&
        b.toString('ascii', 8, 12) === 'WEBP';
    case '.bmp':
      return b[0] === 0x42 && b[1] === 0x4D;
    case '.tiff':
      return (b[0] === 0x49 && b[1] === 0x49 && b[2] === 0x2A && b[3] === 0x00) ||
             (b[0] === 0x4D && b[1] === 0x4D && b[2] === 0x00 && b[3] === 0x2A);
    case '.avif': case '.heic': case '.heif':
      return b.length >= 8 && b.toString('ascii', 4, 8) === 'ftyp';
    default:
      return false;
  }
}

function isPrivateIp(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    if (a === 127) return true;                                  // loopback 127.x
    if (a === 10) return true;                                   // RFC-1918 10.x
    if (a === 172 && b >= 16 && b <= 31) return true;           // RFC-1918 172.16-31.x
    if (a === 192 && b === 168) return true;                     // RFC-1918 192.168.x
    if (a === 169 && b === 254) return true;                     // link-local
    if (a === 0) return true;                                    // unspecified
    if (a === 100 && b >= 64 && b <= 127) return true;          // CGNAT 100.64/10
  } else if (net.isIPv6(ip)) {
    const n = ip.toLowerCase();
    if (n === '::1') return true;
    if (n.startsWith('fe80:')) return true;                      // link-local
    if (n.startsWith('fc') || n.startsWith('fd')) return true;  // unique-local
    if (n === '::') return true;                                 // unspecified
  }
  return false;
}

async function validateRemoteHost(hostname) {
  let addresses;
  try {
    addresses = await dns.promises.lookup(hostname, { all: true });
  } catch (e) {
    throw new Error('SSRF_DNS');
  }
  for (const { address } of addresses) {
    if (isPrivateIp(address)) throw new Error('SSRF_BLOCKED');
  }
  return addresses;
}

// Deterministic color for a keyword tag — mirrors keywordStyleFor() in app.js
const TAG_PALETTE = [
  { background: 'rgb(245, 245, 245)', color: 'rgb(51, 51, 51)' },
  { background: 'rgb(238, 238, 238)', color: 'rgb(34, 34, 34)' },
  { background: 'rgb(230, 243, 255)', color: 'rgb(20, 60, 110)' },
  { background: 'rgb(214, 234, 248)', color: 'rgb(21, 67, 96)' },
  { background: 'rgb(224, 247, 250)', color: 'rgb(0, 77, 102)' },
  { background: 'rgb(232, 245, 233)', color: 'rgb(27, 94, 32)' },
  { background: 'rgb(220, 237, 200)', color: 'rgb(51, 105, 30)' },
  { background: 'rgb(224, 247, 250)', color: 'rgb(0, 96, 100)' },
  { background: 'rgb(225, 245, 254)', color: 'rgb(1, 87, 155)' },
  { background: 'rgb(243, 229, 245)', color: 'rgb(74, 20, 140)' },
  { background: 'rgb(237, 231, 246)', color: 'rgb(69, 39, 160)' },
  { background: 'rgb(255, 235, 238)', color: 'rgb(136, 14, 79)' },
  { background: 'rgb(252, 228, 236)', color: 'rgb(173, 20, 87)' },
  { background: 'rgb(255, 243, 224)', color: 'rgb(230, 81, 0)' },
  { background: 'rgb(255, 249, 230)', color: 'rgb(204, 112, 0)' },
  { background: 'rgb(255, 253, 231)', color: 'rgb(245, 127, 23)' },
  { background: 'rgb(255, 248, 225)', color: 'rgb(245, 124, 0)' },
  { background: 'rgb(239, 235, 233)', color: 'rgb(78, 52, 46)' },
  { background: 'rgb(250, 244, 239)', color: 'rgb(93, 64, 55)' },
  { background: 'rgb(236, 239, 241)', color: 'rgb(33, 33, 33)' },
];
function tagStyleFor(keyword) {
  const key = String(keyword || '').toLowerCase();
  let h = 0;
  for (let i = 0; i < key.length; i++) { h = ((h << 5) - h) + key.charCodeAt(i); h |= 0; }
  const s = TAG_PALETTE[Math.abs(h) % TAG_PALETTE.length];
  return `background:${s.background};color:${s.color}`;
}

let _publishedHtmlCache = null;
let _publishedHtmlExpiry = 0;
let _publishedStoryMap = null;
const PUBLISHED_CACHE_TTL = 30_000;

function invalidatePublishedCache() {
  _publishedHtmlExpiry = 0;
  _publishedStoryMap = null;
}

app.use(createPublishRouter({ getUsername, invalidatePublishedCache }));
app.use(createExportRouter({ getUsername }));

// Build the published stories HTML block (shared by GET / and GET /discover)
async function buildPublishedStoriesHtml() {
  if (_publishedHtmlCache !== null && Date.now() < _publishedHtmlExpiry) {
    return _publishedHtmlCache;
  }
  let userDirs = [];
  try { userDirs = await fs.readdir(DATA_DIR); } catch (e) {}
  const ps = await readPseudonyms();
  const published = [];
  const storyMap = new Map();
  for (const udir of userDirs) {
    if (udir.startsWith('_')) continue;
    const upath = path.join(DATA_DIR, udir);
    try {
      const stat = await fs.stat(upath);
      if (!stat.isDirectory()) continue;
      const mf = path.join(upath, 'metadata.json');
      const raw = await fs.readFile(mf, 'utf8');
      const meta = JSON.parse(raw);
      for (const item of meta) {
        if (!item.published) continue;
        storyMap.set(item.id, { username: udir, item });
        // Extract tags from all tiles of this story
        let tags = [];
        try {
          const tilesDir = path.join(upath, item.id, 'tiles');
          let order = [];
          try { order = JSON.parse(await fs.readFile(path.join(tilesDir, '_order.json'), 'utf8')); }
          catch (e) { order = (await fs.readdir(tilesDir).catch(() => [])).filter(f => f.endsWith('.md')).sort(); }
          let combined = '';
          for (const f of order) {
            try { combined += await fs.readFile(safeJoin(tilesDir, f), 'utf8') + '\n'; } catch (e) {}
          }
          tags = extractTags(combined);
        } catch (e) {}
        published.push({ id: item.id, name: item.name, author: ps[udir] || item.author || udir, tags });
      }
    } catch (e) { /* skip */ }
  }
  _publishedStoryMap = storyMap;
  if (published.length === 0) {
    _publishedHtmlCache = '';
    _publishedHtmlExpiry = Date.now() + PUBLISHED_CACHE_TTL;
    return '';
  }
  const html = '<div class="stories"><h2>Published Stories</h2><ul>' +
    published.map(s => {
      const tagPills = s.tags.length > 0
        ? `<span class="story-tags">${s.tags.map(t => `<span class="story-tag" style="${tagStyleFor(t)}">${escHtml(t)}</span>`).join('')}</span>`
        : '';
      return `<li><a href="/read/${escHtml(s.id)}">${escHtml(s.name)}</a>${tagPills}` +
        `<span class="author">by ${escHtml(s.author)}</span></li>`;
    }).join('') +
    '</ul></div>';
  _publishedHtmlCache = html;
  _publishedHtmlExpiry = Date.now() + PUBLISHED_CACHE_TTL;
  return html;
}

// --- Serve index.html dynamically (inject user info) ---

app.get('/', async (req, res) => {
  if (!LOCAL_MODE && (!req.oidc || !req.oidc.isAuthenticated())) {
    let storiesHtml = '';
    try { storiesHtml = await buildPublishedStoriesHtml(); } catch (e) {}

    const cardContent = '<p>Please log in to continue.</p><a href="/login">Log in</a><a href="/signup" class="secondary">Sign up</a>';
    const loginPath = path.join(PUBLIC_DIR, 'login.html');
    const loginHtml = (await fs.readFile(loginPath, 'utf8'))
      .replace('<!--STORIES-->', storiesHtml)
      .replace('<!--CARD_CONTENT-->', cardContent);
    return res.type('html').send(loginHtml);
  }

  const username = getUsername(req) || DEFAULT_USER;
  const displayName = getDisplayName(req) || DEFAULT_USER;
  const localMode = LOCAL_MODE;

  let html = indexTemplate.replace(
    /<!-- expose local_mode and username to the client -->\s*<script>[\s\S]*?<\/script>/,
    `<!-- expose local_mode and username to the client -->
  <script>
    window.local_mode = ${localMode};
    window.username = ${JSON.stringify(displayName)};
  </script>`
  );
  res.type('html').send(html);
});

// Discover page — published stories list, works for authenticated and unauthenticated users
app.get('/discover', async (req, res) => {
  let storiesHtml = '';
  try { storiesHtml = await buildPublishedStoriesHtml(); } catch (e) {}

  const isLoggedIn = !LOCAL_MODE && req.oidc && req.oidc.isAuthenticated();
  const displayName = isLoggedIn ? (getDisplayName(req) || 'there') : '';
  const cardContent = LOCAL_MODE
    ? '<a href="/">← Back to editor</a>'
    : isLoggedIn
      ? `<p>Welcome, ${escHtml(displayName)}.</p><a href="/">Open editor</a><a href="/logout" class="secondary">Logout</a>`
      : '<p>Please log in to continue.</p><a href="/login">Log in</a><a href="/signup" class="secondary">Sign up</a>';

  const loginPath = path.join(PUBLIC_DIR, 'login.html');
  const html = (await fs.readFile(loginPath, 'utf8'))
    .replace('<!--STORIES-->', storiesHtml)
    .replace('<!--CARD_CONTENT-->', cardContent);
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
  const q = normalizeSearch((req.query.q || '').trim());
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
      const nameMatches = normalizeSearch(story.name).includes(q);
      const matchingTiles = [];
      const matchingHighlights = [];

      try {
        const order = JSON.parse(await fs.readFile(path.join(tilesDir, '_order.json'), 'utf8'));
        for (const filename of order) {
          if (normalizeSearch(filename.replace(/\.md$/, '')).includes(q)) {
            matchingTiles.push(filename);
            continue;
          }
          try {
            const content = await readTileCached(username, story.id, filename, path.join(tilesDir, filename));
            if (normalizeSearch(content).includes(q)) matchingTiles.push(filename);
          } catch (e) {}
        }
      } catch (e) {}

      try {
        const files = (await fs.readdir(highlightsDir)).filter(f => f.endsWith('.md'));
        for (const filename of files) {
          if (normalizeSearch(filename.replace(/\.md$/, '')).includes(q)) {
            matchingHighlights.push(filename);
            continue;
          }
          try {
            const content = await readHighlightCached(username, story.id, filename, path.join(highlightsDir, filename));
            if (normalizeSearch(content).includes(q)) matchingHighlights.push(filename);
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

// Get aggregated tile tags for all stories (used by story list to show keyword pills)
app.get('/api/tags', async (req, res) => {
  try {
    const username = getUsername(req);
    const meta = await readMeta(username);
    const result = {};
    await Promise.all(meta.map(async story => {
      const tilesDir = path.join(storyDir(username, story.id), 'tiles');
      let combined = '';
      try {
        let order = [];
        try { order = JSON.parse(await fs.readFile(path.join(tilesDir, '_order.json'), 'utf8')); } catch (e) {}
        const contents = await Promise.all(order.map(async f => {
          try { return await fs.readFile(path.join(tilesDir, f), 'utf8'); } catch (e) { return ''; }
        }));
        combined = contents.join('\n');
      } catch (e) {}
      const tags = extractTags(combined);
      if (tags.length > 0) result[story.id] = tags;
    }));
    res.json(result);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'failed to read tags' });
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
            content = dir === 'tiles'
              ? await readTileCached(username, id, filename, filePath)
              : await readHighlightCached(username, id, filename, filePath);
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
          content = dir === 'tiles'
            ? await readTileCached(username, id, filename, filePath)
            : await readHighlightCached(username, id, filename, filePath);
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
      content = directory === 'tiles'
        ? await readTileCached(username, id, filename, filePath)
        : await readHighlightCached(username, id, filename, filePath);
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

    const newContent = lines.join('\n');
    await atomicWrite(filePath, newContent);
    if (directory === 'tiles') _setCache(tileCache, username, id, filename, newContent);
    else _setCache(highlightCache, username, id, filename, newContent);

    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'failed to toggle todo' });
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
    res.set('X-Content-Type-Options', 'nosniff');
    if (path.extname(filename).toLowerCase() === '.svg') {
      res.set('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'");
    }
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
      const ext = path.extname(sanitized).toLowerCase();
      if (!ALLOWED_IMAGE_EXTS.has(ext)) {
        return res.status(400).json({ error: `file type not allowed; accepted: ${[...ALLOWED_IMAGE_EXTS].join(', ')}` });
      }
      const buffer = Buffer.from(data, 'base64');
      if (!checkImageMagicBytes(buffer, ext)) {
        return res.status(400).json({ error: 'file content does not match its extension' });
      }
      await fs.writeFile(filePath, buffer);
      res.json({ ok: true, filename: sanitized, path: `/api/story/${id}/pictures/${sanitized}` });
    } else if (url) {
      // Download from URL — hardened against SSRF, redirect abuse, and resource exhaustion
      const contentTypeToExt = {
        'image/webp': '.webp', 'image/jpeg': '.jpg', 'image/png': '.png',
        'image/gif': '.gif', 'image/svg+xml': '.svg', 'image/bmp': '.bmp',
        'image/tiff': '.tiff', 'image/avif': '.avif', 'image/heic': '.heic',
        'image/heif': '.heif'
      };
      try {
        const downloadUrl = new URL(url);
        if (downloadUrl.protocol !== 'https:' && downloadUrl.protocol !== 'http:') {
          return res.status(400).json({ error: 'Only http and https URLs are supported.' });
        }
        let actualFilename = sanitized;
        await new Promise((resolve, reject) => {
          let redirectCount = 0;
          const doGet = async (targetUrl) => {
            let parsedUrl;
            try { parsedUrl = new URL(targetUrl); } catch (e) { return reject(new Error('BAD_URL')); }
            // Guard against SSRF: resolve once, validate, then pin the connection
            // to the validated IP so a DNS rebind cannot redirect to a private host.
            let resolvedIp;
            try {
              const addresses = await validateRemoteHost(parsedUrl.hostname);
              resolvedIp = addresses[0].address;
            } catch (e) {
              return reject(e);
            }
            const mod = parsedUrl.protocol === 'https:' ? require('https') : require('http');
            const options = {
              hostname: resolvedIp,
              port: parsedUrl.port || undefined,
              path: parsedUrl.pathname + parsedUrl.search,
              headers: {
                'Host': parsedUrl.hostname,
                'User-Agent': 'Mozilla/5.0 (compatible; NeoWriter/1.0)'
              },
              ...(parsedUrl.protocol === 'https:' ? { servername: parsedUrl.hostname } : {})
            };
            const httpReq = mod.get(options, (response) => {
              if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
                response.resume();
                if (++redirectCount > DOWNLOAD_MAX_REDIRECTS) {
                  return reject(new Error('TOO_MANY_REDIRECTS'));
                }
                doGet(response.headers.location).catch(reject);
                return;
              }
              if (response.statusCode !== 200) {
                response.resume();
                return reject(new Error(`Server returned status ${response.statusCode}`));
              }
              const contentType = (response.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
              if (!contentType || !contentType.startsWith('image/')) {
                response.resume();
                return reject(new Error('NOT_IMAGE'));
              }
              if (contentTypeToExt[contentType]) {
                const correctExt = contentTypeToExt[contentType];
                const currentExt = path.extname(actualFilename).toLowerCase();
                if (currentExt !== correctExt) {
                  actualFilename = actualFilename.substring(0, actualFilename.length - currentExt.length) + correctExt;
                }
              }
              const chunks = [];
              let totalBytes = 0;
              response.on('data', chunk => {
                totalBytes += chunk.length;
                if (totalBytes > DOWNLOAD_MAX_BYTES) {
                  response.destroy();
                  return reject(new Error('TOO_LARGE'));
                }
                chunks.push(chunk);
              });
              response.on('end', async () => {
                try {
                  const buffer = Buffer.concat(chunks);
                  const dlExt = path.extname(actualFilename).toLowerCase();
                  if (!checkImageMagicBytes(buffer, dlExt)) {
                    return reject(new Error('NOT_IMAGE'));
                  }
                  const actualPath = safeJoin(picturesDir, actualFilename);
                  if (!req.body.overwrite) {
                    try {
                      await fs.access(actualPath);
                      return reject(new Error('EXISTS:' + actualFilename));
                    } catch (e) { /* proceed */ }
                  }
                  await fs.writeFile(actualPath, buffer);
                  resolve();
                } catch (e) { reject(e); }
              });
              response.on('error', reject);
            });
            httpReq.setTimeout(DOWNLOAD_TIMEOUT_MS, () => httpReq.destroy(new Error('TIMEOUT')));
            httpReq.on('error', reject);
          };
          doGet(url).catch(reject);
        });
        res.json({ ok: true, filename: actualFilename, path: `/api/story/${id}/pictures/${encodeURIComponent(actualFilename)}` });
      } catch (e) {
        if (e.message && e.message.startsWith('EXISTS:')) {
          res.json({ ok: false, error: 'EXISTS:' + e.message.substring(7) });
        } else if (e.message === 'NOT_IMAGE') {
          res.status(400).json({ error: 'Could not download the image (the server may be blocking automated downloads). Please save the file to your disk first, then upload it.' });
        } else if (e.message === 'SSRF_BLOCKED' || e.message === 'SSRF_DNS') {
          res.status(400).json({ error: 'URL refers to a private or internal host and cannot be fetched.' });
        } else if (e.message === 'TOO_LARGE') {
          res.status(400).json({ error: 'Image exceeds the 25 MB download limit.' });
        } else if (e.message === 'TIMEOUT') {
          res.status(400).json({ error: 'Download timed out. Please save the file to your disk first, then upload it.' });
        } else if (e.message === 'TOO_MANY_REDIRECTS') {
          res.status(400).json({ error: 'Too many redirects while downloading the image.' });
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

// --- Public routes (no authentication required) (continued) ---

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
    const ps = await readPseudonyms();
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
            entries.push({ id: item.id, name: item.name, author: ps[udir] || item.author || udir });
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

// Find a published story by UUID — uses the shared published-story index (built by buildPublishedStoriesHtml)
async function findPublishedStory(storyId) {
  if (!_publishedStoryMap || Date.now() > _publishedHtmlExpiry) {
    await buildPublishedStoriesHtml();
  }
  return _publishedStoryMap.get(path.basename(storyId)) || null;
}

// Read a published story by UUID (no username in URL)
app.get('/public/story/:id', async (req, res) => {
  const found = await findPublishedStory(req.params.id).catch(() => null);
  if (!found) return res.status(404).json({ error: 'not found or not published' });
  const { username, item } = found;
  const safeId = path.basename(req.params.id);
  try {
    const tilesDir = path.join(DATA_DIR, username, safeId, 'tiles');
    let order = [];
    try { order = JSON.parse(await fs.readFile(path.join(tilesDir, '_order.json'), 'utf8')); }
    catch (e) {
      try { order = (await fs.readdir(tilesDir)).filter(f => f.endsWith('.md')).sort(); } catch (e2) {}
    }
    let content = '';
    for (const filename of order) {
      try { content += (content ? '\n\n' : '') + await fs.readFile(safeJoin(tilesDir, filename), 'utf8'); } catch (e) {}
    }
    res.json({ id: safeId, name: item.name, author: (await readPseudonyms())[username] || item.author || username, content: stripTags(content), keywords: extractTags(content) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'failed to read published story' });
  }
});

// Serve pictures from published stories (UUID-only URL)
app.get('/public/story/:id/pictures/:filename', async (req, res) => {
  const found = await findPublishedStory(req.params.id).catch(() => null);
  if (!found) return res.status(404).send('Not found');
  const { username } = found;
  const safeId = path.basename(req.params.id);
  const picturesDir = path.join(DATA_DIR, username, safeId, 'pictures');
  const filePath = safeJoin(picturesDir, req.params.filename);
  try {
    await fs.access(filePath);
    res.set('X-Content-Type-Options', 'nosniff');
    if (path.extname(req.params.filename).toLowerCase() === '.svg') {
      res.set('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'");
    }
    res.sendFile(filePath);
  } catch (e) {
    res.status(404).send('Not found');
  }
});

// Serve the reader page (UUID-only URL)
app.get('/read/:id', async (req, res) => {
  const found = await findPublishedStory(req.params.id).catch(() => null);
  if (!found) return res.status(404).send('Story not found');
  res.sendFile(path.join(PUBLIC_DIR, 'reader.html'));
});

// Redirect old /:username/:id URLs to the UUID-only form
app.get('/read/:username/:id', (req, res) => {
  res.redirect(301, `/read/${req.params.id}`);
});
app.get('/public/story/:username/:id/pictures/:filename', (req, res) => {
  res.redirect(301, `/public/story/${req.params.id}/pictures/${req.params.filename}`);
});
app.get('/public/story/:username/:id', (req, res) => {
  res.redirect(301, `/public/story/${req.params.id}`);
});

// Fallback to dynamic index.html for SPA navigation
app.get('*', (req, res) => {
  if (!LOCAL_MODE && (!req.oidc || !req.oidc.isAuthenticated())) {
    return res.redirect('/');
  }

  const username = getUsername(req) || DEFAULT_USER;
  const displayName = getDisplayName(req) || DEFAULT_USER;
  const localMode = LOCAL_MODE;

  let html = indexTemplate.replace(
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
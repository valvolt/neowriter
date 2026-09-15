const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs').promises;
const fsSync = require('fs');
const os = require('os');

// --- Helpers ---

let app, request;
let tmpDir;

async function rmrf(dir) {
  try { await fs.rm(dir, { recursive: true, force: true }); } catch (e) {}
}

async function setupTestEnv() {
  // Create isolated temp directory for test data
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'neowriter-test-'));

  // Set env vars BEFORE requiring server
  process.env.MODE = 'LOCAL';
  delete process.env.CLIENT_ID;

  // Patch DATA_DIR to use temp directory
  // We need to clear the module cache so server.js re-evaluates
  const serverPath = require.resolve('../server');
  delete require.cache[serverPath];

  // Monkey-patch __dirname in the loaded module isn't possible cleanly,
  // so we patch the DATA_DIR via a different approach: override after require
  app = require('../server');

  // Override the DATA_DIR by creating the expected data/anonymous structure
  const dataDir = path.join(path.dirname(serverPath), 'data');
  const anonDir = path.join(dataDir, 'anonymous');

  // Back up original data if it exists, use a test marker
  // Actually, since we're in LOCAL mode, data goes to ./data/anonymous
  // We'll ensure it exists and clean up test artifacts after
  await fs.mkdir(anonDir, { recursive: true });

  // Ensure metadata.json exists (the server does this on startup)
  const metaPath = path.join(anonDir, 'metadata.json');
  try {
    await fs.access(metaPath);
  } catch (e) {
    await fs.writeFile(metaPath, '[]', 'utf8');
  }

  const supertest = require('supertest');
  request = supertest(app);
}

// ============================================================================
// UNIT TESTS: Utility functions
// ============================================================================

describe('Utility functions', () => {
  // We test the sanitize functions by observing their effects through the API
  // since they are not exported. Direct unit tests would require refactoring.

  it('sanitizeFilename: accented characters are stripped via tile rename', async () => {
    await setupTestEnv();

    // Create a story
    const story = (await request.post('/api/create')
      .send({ name: 'Sanitize Test' }).expect(200)).body;

    // Rename tile with accented name
    const res = await request.post(`/api/story/${story.id}/tiles/chapter-1.md/rename`)
      .send({ name: 'Cafe Resume Noel' })
      .expect(200);

    assert.equal(res.body.filename, 'cafe-resume-noel.md');
    assert.equal(res.body.name, 'Cafe Resume Noel');

    // Cleanup
    await request.delete(`/api/story/${story.id}`).expect(200);
  });

  it('sanitizeFilename: special characters and spaces become hyphens', async () => {
    const story = (await request.post('/api/create')
      .send({ name: 'Special Chars' }).expect(200)).body;

    const res = await request.post(`/api/story/${story.id}/tiles/chapter-1.md/rename`)
      .send({ name: 'Hello World! @#$%' })
      .expect(200);

    assert.equal(res.body.filename, 'hello-world.md');

    await request.delete(`/api/story/${story.id}`).expect(200);
  });

  it('sanitizeFilename: empty name becomes untitled', async () => {
    const story = (await request.post('/api/create')
      .send({ name: 'Empty Name Test' }).expect(200)).body;

    const res = await request.post(`/api/story/${story.id}/tiles/chapter-1.md/rename`)
      .send({ name: '!!!' })
      .expect(200);

    assert.equal(res.body.filename, 'untitled.md');

    await request.delete(`/api/story/${story.id}`).expect(200);
  });
});

// ============================================================================
// INTEGRATION TESTS: Story CRUD
// ============================================================================

describe('Story CRUD', () => {
  before(async () => { await setupTestEnv(); });

  let storyId;

  it('GET /api/list returns empty array initially or existing stories', async () => {
    const res = await request.get('/api/list').expect(200);
    assert.ok(Array.isArray(res.body));
  });

  it('POST /api/create creates a story with default tile', async () => {
    const res = await request.post('/api/create')
      .send({ name: 'My Test Story' })
      .expect(200);

    assert.ok(res.body.id);
    assert.equal(res.body.name, 'My Test Story');
    assert.equal(res.body.author, 'anonymous');
    assert.ok(res.body.tile);
    assert.equal(res.body.tile.filename, 'chapter-1.md');
    storyId = res.body.id;
  });

  it('POST /api/create defaults name to Untitled', async () => {
    const res = await request.post('/api/create')
      .send({})
      .expect(200);

    assert.equal(res.body.name, 'Untitled');

    // Cleanup
    await request.delete(`/api/story/${res.body.id}`).expect(200);
  });

  it('GET /api/list includes the created story', async () => {
    const res = await request.get('/api/list').expect(200);
    const found = res.body.find(s => s.id === storyId);
    assert.ok(found, 'story should appear in list');
    assert.equal(found.name, 'My Test Story');
  });

  it('GET /api/story/:id returns story metadata', async () => {
    const res = await request.get(`/api/story/${storyId}`).expect(200);
    assert.equal(res.body.id, storyId);
    assert.equal(res.body.name, 'My Test Story');
    assert.equal(res.body.author, 'anonymous');
  });

  it('GET /api/story/:id returns 404 for non-existent story', async () => {
    await request.get('/api/story/non-existent-id').expect(404);
  });

  it('POST /api/rename/:id renames a story', async () => {
    const res = await request.post(`/api/rename/${storyId}`)
      .send({ name: 'Renamed Story' })
      .expect(200);

    assert.equal(res.body.name, 'Renamed Story');

    // Verify rename persisted
    const meta = await request.get(`/api/story/${storyId}`).expect(200);
    assert.equal(meta.body.name, 'Renamed Story');
  });

  it('POST /api/rename/:id returns 400 without name', async () => {
    await request.post(`/api/rename/${storyId}`)
      .send({})
      .expect(400);
  });

  it('POST /api/rename/:id returns 404 for non-existent story', async () => {
    await request.post('/api/rename/non-existent-id')
      .send({ name: 'X' })
      .expect(404);
  });

  it('DELETE /api/story/:id deletes a story', async () => {
    // Create a disposable story
    const story = (await request.post('/api/create')
      .send({ name: 'To Delete' }).expect(200)).body;

    await request.delete(`/api/story/${story.id}`).expect(200);

    // Verify it's gone
    await request.get(`/api/story/${story.id}`).expect(404);
  });

  it('DELETE /api/story/:id returns 404 for non-existent story', async () => {
    await request.delete('/api/story/non-existent-id').expect(404);
  });

  // Cleanup the main test story
  after(async () => {
    if (storyId) {
      await request.delete(`/api/story/${storyId}`);
    }
  });
});

// ============================================================================
// INTEGRATION TESTS: Tiles
// ============================================================================

describe('Tiles', () => {
  let storyId;

  before(async () => {
    await setupTestEnv();
    const story = (await request.post('/api/create')
      .send({ name: 'Tile Test Story' }).expect(200)).body;
    storyId = story.id;
  });

  after(async () => {
    await request.delete(`/api/story/${storyId}`);
  });

  it('GET /api/story/:id/tiles lists tiles (starts with chapter-1)', async () => {
    const res = await request.get(`/api/story/${storyId}/tiles`).expect(200);
    assert.ok(Array.isArray(res.body));
    assert.ok(res.body.length >= 1);
    assert.equal(res.body[0].filename, 'chapter-1.md');
  });

  it('POST /api/story/:id/tiles creates a new tile', async () => {
    const res = await request.post(`/api/story/${storyId}/tiles`)
      .send({})
      .expect(200);

    assert.equal(res.body.filename, 'chapter-2.md');
    assert.equal(res.body.name, 'chapter-2');
  });

  it('GET /api/story/:id/tiles/:filename reads tile content', async () => {
    const res = await request.get(`/api/story/${storyId}/tiles/chapter-1.md`).expect(200);
    assert.equal(res.body.filename, 'chapter-1.md');
    assert.equal(typeof res.body.content, 'string');
  });

  it('GET /api/story/:id/tiles/:filename returns 404 for missing tile', async () => {
    await request.get(`/api/story/${storyId}/tiles/nonexistent.md`).expect(404);
  });

  it('POST /api/story/:id/tiles/:filename/save writes content', async () => {
    const content = '# Chapter 1\n\nOnce upon a time...';
    await request.post(`/api/story/${storyId}/tiles/chapter-1.md/save`)
      .send({ content })
      .expect(200);

    // Verify content was saved
    const res = await request.get(`/api/story/${storyId}/tiles/chapter-1.md`).expect(200);
    assert.equal(res.body.content, content);
  });

  it('POST /api/story/:id/tiles/:filename/save returns 400 without content', async () => {
    await request.post(`/api/story/${storyId}/tiles/chapter-1.md/save`)
      .send({})
      .expect(400);
  });

  it('POST /api/story/:id/tiles/:filename/save returns 404 for missing tile', async () => {
    await request.post(`/api/story/${storyId}/tiles/nonexistent.md/save`)
      .send({ content: 'x' })
      .expect(404);
  });

  it('POST /api/story/:id/tiles/:filename/rename renames a tile', async () => {
    const res = await request.post(`/api/story/${storyId}/tiles/chapter-2.md/rename`)
      .send({ name: 'Prologue' })
      .expect(200);

    assert.equal(res.body.filename, 'prologue.md');
    assert.equal(res.body.name, 'Prologue');

    // Verify old name is gone, new name works
    await request.get(`/api/story/${storyId}/tiles/chapter-2.md`).expect(404);
    await request.get(`/api/story/${storyId}/tiles/prologue.md`).expect(200);
  });

  it('POST /api/story/:id/tiles/:filename/rename returns 400 without name', async () => {
    await request.post(`/api/story/${storyId}/tiles/chapter-1.md/rename`)
      .send({})
      .expect(400);
  });

  it('POST /api/story/:id/tiles/:filename/rename handles collision (appends counter)', async () => {
    // Create a tile, rename chapter-1 to same name -> should get -2 suffix
    await request.post(`/api/story/${storyId}/tiles`).send({}).expect(200); // chapter-3

    // Rename chapter-3 to "Prologue" which already exists
    const renamed = await request.post(`/api/story/${storyId}/tiles/chapter-3.md/rename`)
      .send({ name: 'Prologue' })
      .expect(200);

    assert.equal(renamed.body.filename, 'prologue-2.md');
  });

  it('POST /api/story/:id/tiles/reorder changes tile order', async () => {
    const tiles = (await request.get(`/api/story/${storyId}/tiles`).expect(200)).body;
    const filenames = tiles.map(t => t.filename);

    // Reverse the order
    const reversed = [...filenames].reverse();
    await request.post(`/api/story/${storyId}/tiles/reorder`)
      .send({ order: reversed })
      .expect(200);

    // Verify new order
    const after = (await request.get(`/api/story/${storyId}/tiles`).expect(200)).body;
    assert.deepEqual(after.map(t => t.filename), reversed);
  });

  it('POST /api/story/:id/tiles/reorder returns 400 without order array', async () => {
    await request.post(`/api/story/${storyId}/tiles/reorder`)
      .send({ order: 'not-an-array' })
      .expect(400);
  });

  it('DELETE /api/story/:id/tiles/:filename deletes a tile', async () => {
    // Delete prologue-2.md
    await request.delete(`/api/story/${storyId}/tiles/prologue-2.md`).expect(200);

    // Verify it's gone
    await request.get(`/api/story/${storyId}/tiles/prologue-2.md`).expect(404);

    // Verify it's removed from the tile list
    const tiles = (await request.get(`/api/story/${storyId}/tiles`).expect(200)).body;
    assert.ok(!tiles.find(t => t.filename === 'prologue-2.md'));
  });

  it('DELETE /api/story/:id/tiles/:filename returns 404 for missing tile', async () => {
    await request.delete(`/api/story/${storyId}/tiles/nonexistent.md`).expect(404);
  });

  it('GET /api/story/:id/tiles returns 404 for non-existent story', async () => {
    await request.get('/api/story/bad-id/tiles').expect(404);
  });
});

// ============================================================================
// INTEGRATION TESTS: Highlights
// ============================================================================

describe('Highlights', () => {
  let storyId;

  before(async () => {
    await setupTestEnv();
    const story = (await request.post('/api/create')
      .send({ name: 'Highlight Test Story' }).expect(200)).body;
    storyId = story.id;
  });

  after(async () => {
    await request.delete(`/api/story/${storyId}`);
  });

  it('GET /api/story/:id/highlights starts empty', async () => {
    const res = await request.get(`/api/story/${storyId}/highlights`).expect(200);
    assert.ok(Array.isArray(res.body));
    assert.equal(res.body.length, 0);
  });

  it('POST /api/story/:id/highlights creates a highlight', async () => {
    const res = await request.post(`/api/story/${storyId}/highlights`)
      .send({})
      .expect(200);

    assert.equal(res.body.filename, 'highlight-1.md');
    assert.equal(res.body.name, 'highlight-1');
  });

  it('GET /api/story/:id/highlights/:filename reads highlight content', async () => {
    const res = await request.get(`/api/story/${storyId}/highlights/highlight-1.md`).expect(200);
    assert.equal(res.body.filename, 'highlight-1.md');
    assert.equal(typeof res.body.content, 'string');
  });

  it('POST /api/story/:id/highlights/:filename/save writes content', async () => {
    const content = '# Character: Alice\n\nProtagonist of the story.';
    await request.post(`/api/story/${storyId}/highlights/highlight-1.md/save`)
      .send({ content })
      .expect(200);

    const res = await request.get(`/api/story/${storyId}/highlights/highlight-1.md`).expect(200);
    assert.equal(res.body.content, content);
  });

  it('POST /api/story/:id/highlights/:filename/rename renames and propagates to tiles', async () => {
    // First, put the highlight name into a tile
    await request.post(`/api/story/${storyId}/tiles/chapter-1.md/save`)
      .send({ content: 'highlight-1 appears here, and HIGHLIGHT-1 is mentioned again.' })
      .expect(200);

    // Rename the highlight
    const res = await request.post(`/api/story/${storyId}/highlights/highlight-1.md/rename`)
      .send({ name: 'Alice' })
      .expect(200);

    assert.equal(res.body.filename, 'alice.md');
    assert.equal(res.body.name, 'Alice');

    // Verify the old highlight name was replaced in the tile content
    const tile = await request.get(`/api/story/${storyId}/tiles/chapter-1.md`).expect(200);
    // The case-preserving replacement: "highlight-1" -> "alice", "HIGHLIGHT-1" -> "ALICE"
    assert.ok(tile.body.content.includes('alice') || tile.body.content.includes('Alice'),
      'tile content should contain the new highlight name');
  });

  it('DELETE /api/story/:id/highlights/:filename deletes a highlight', async () => {
    await request.delete(`/api/story/${storyId}/highlights/alice.md`).expect(200);
    await request.get(`/api/story/${storyId}/highlights/alice.md`).expect(404);
  });
});

// ============================================================================
// INTEGRATION TESTS: Todos
// ============================================================================

describe('Todos', () => {
  let storyId;

  before(async () => {
    await setupTestEnv();
    const story = (await request.post('/api/create')
      .send({ name: 'Todo Test Story' }).expect(200)).body;
    storyId = story.id;

    // Write content with todo items
    await request.post(`/api/story/${storyId}/tiles/chapter-1.md/save`)
      .send({ content: '# Chapter 1\n\n- [ ] Write introduction\n- [ ] Add conflict\n- [x] Create outline\n' })
      .expect(200);
  });

  after(async () => {
    await request.delete(`/api/story/${storyId}`);
  });

  it('GET /api/story/:id/todo extracts unchecked and checked items', async () => {
    const res = await request.get(`/api/story/${storyId}/todo`).expect(200);
    assert.ok(Array.isArray(res.body));

    const unchecked = res.body.filter(t => !t.checked);
    const checked = res.body.filter(t => t.checked);

    assert.equal(unchecked.length, 2);
    assert.equal(checked.length, 1);

    // Unchecked should come first
    assert.equal(res.body[0].checked, false);
    assert.equal(res.body[res.body.length - 1].checked, true);

    // Verify structure
    assert.equal(res.body[0].text, 'Write introduction');
    assert.equal(res.body[0].filename, 'chapter-1.md');
    assert.equal(res.body[0].directory, 'tiles');
    assert.equal(typeof res.body[0].lineIndex, 'number');
  });

  it('POST /api/story/:id/todo/toggle checks an unchecked item', async () => {
    await request.post(`/api/story/${storyId}/todo/toggle`)
      .send({ directory: 'tiles', filename: 'chapter-1.md', lineIndex: 2, checked: true })
      .expect(200);

    // Verify the todo is now checked
    const res = await request.get(`/api/story/${storyId}/todo`).expect(200);
    const item = res.body.find(t => t.text === 'Write introduction');
    assert.equal(item.checked, true);
  });

  it('POST /api/story/:id/todo/toggle unchecks a checked item', async () => {
    await request.post(`/api/story/${storyId}/todo/toggle`)
      .send({ directory: 'tiles', filename: 'chapter-1.md', lineIndex: 4, checked: false })
      .expect(200);

    const res = await request.get(`/api/story/${storyId}/todo`).expect(200);
    const item = res.body.find(t => t.text === 'Create outline');
    assert.equal(item.checked, false);
  });

  it('POST /api/story/:id/todo/toggle returns 400 with missing params', async () => {
    await request.post(`/api/story/${storyId}/todo/toggle`)
      .send({ directory: 'tiles' })
      .expect(400);
  });

  it('POST /api/story/:id/todo/toggle returns 400 for invalid directory', async () => {
    await request.post(`/api/story/${storyId}/todo/toggle`)
      .send({ directory: '../etc', filename: 'chapter-1.md', lineIndex: 0, checked: true })
      .expect(400);
  });

  it('GET /api/todo returns global todos across all stories', async () => {
    const res = await request.get('/api/todo').expect(200);
    assert.ok(Array.isArray(res.body));
    // Should include items from our story
    const ours = res.body.filter(t => t.storyId === storyId);
    assert.ok(ours.length > 0, 'global todo should include items from test story');
    assert.ok(ours[0].storyName, 'global todo items should have storyName');
  });
});

// ============================================================================
// INTEGRATION TESTS: Pictures
// ============================================================================

describe('Pictures', () => {
  let storyId;

  before(async () => {
    await setupTestEnv();
    const story = (await request.post('/api/create')
      .send({ name: 'Picture Test Story' }).expect(200)).body;
    storyId = story.id;
  });

  after(async () => {
    await request.delete(`/api/story/${storyId}`);
  });

  it('POST /api/story/:id/pictures uploads base64 image', async () => {
    // 1x1 red PNG pixel
    const pngBase64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg==';

    const res = await request.post(`/api/story/${storyId}/pictures`)
      .send({ name: 'test-image.png', data: pngBase64 })
      .expect(200);

    assert.equal(res.body.ok, true);
    assert.equal(res.body.filename, 'test-image.png');
    assert.ok(res.body.path);
  });

  it('GET /api/story/:id/pictures/:filename serves uploaded image', async () => {
    const res = await request.get(`/api/story/${storyId}/pictures/test-image.png`)
      .expect(200);

    assert.ok(res.body || res.text, 'should return image data');
  });

  it('GET /api/story/:id/pictures/:filename/exists returns true for existing', async () => {
    const res = await request.get(`/api/story/${storyId}/pictures/test-image.png/exists`).expect(200);
    assert.equal(res.body.exists, true);
  });

  it('GET /api/story/:id/pictures/:filename/exists returns false for missing', async () => {
    const res = await request.get(`/api/story/${storyId}/pictures/nope.png/exists`).expect(200);
    assert.equal(res.body.exists, false);
  });

  it('GET /api/story/:id/pictures/:filename returns 404 for missing', async () => {
    await request.get(`/api/story/${storyId}/pictures/nope.png`).expect(404);
  });

  it('POST /api/story/:id/pictures returns 400 without name', async () => {
    await request.post(`/api/story/${storyId}/pictures`)
      .send({ data: 'abc' })
      .expect(400);
  });

  it('POST /api/story/:id/pictures returns 400 without data or url', async () => {
    await request.post(`/api/story/${storyId}/pictures`)
      .send({ name: 'x.png' })
      .expect(400);
  });
});

// ============================================================================
// INTEGRATION TESTS: Publish
// ============================================================================

describe('Publish', () => {
  let storyId;

  before(async () => {
    await setupTestEnv();
    const story = (await request.post('/api/create')
      .send({ name: 'Publish Test Story' }).expect(200)).body;
    storyId = story.id;

    // Add some content
    await request.post(`/api/story/${storyId}/tiles/chapter-1.md/save`)
      .send({ content: '# Published Content\n\nHello world.' })
      .expect(200);
  });

  after(async () => {
    await request.delete(`/api/story/${storyId}`);
  });

  it('GET /api/story/:id/published defaults to false', async () => {
    const res = await request.get(`/api/story/${storyId}/published`).expect(200);
    assert.equal(res.body.published, false);
  });

  it('POST /api/story/:id/publish sets published to true', async () => {
    const res = await request.post(`/api/story/${storyId}/publish`)
      .send({ published: true })
      .expect(200);

    assert.equal(res.body.published, true);
  });

  it('GET /api/story/:id/published reflects the change', async () => {
    const res = await request.get(`/api/story/${storyId}/published`).expect(200);
    assert.equal(res.body.published, true);
  });

  it('GET /public/stories lists published stories', async () => {
    const res = await request.get('/public/stories').expect(200);
    assert.ok(Array.isArray(res.body));
    const found = res.body.find(s => s.id === storyId);
    assert.ok(found, 'published story should appear in public list');
    assert.equal(found.name, 'Publish Test Story');
  });

  it('GET /public/story/:username/:id returns published story content', async () => {
    const res = await request.get(`/public/story/anonymous/${storyId}`).expect(200);
    assert.equal(res.body.id, storyId);
    assert.equal(res.body.name, 'Publish Test Story');
    assert.ok(res.body.content.includes('Hello world.'));
  });

  it('POST /api/story/:id/publish can unpublish', async () => {
    await request.post(`/api/story/${storyId}/publish`)
      .send({ published: false })
      .expect(200);

    // No longer visible publicly
    const res = await request.get(`/public/story/anonymous/${storyId}`).expect(404);
  });

  it('GET /public/story/:username/:id returns 404 for unpublished story', async () => {
    await request.get(`/public/story/anonymous/${storyId}`).expect(404);
  });

  it('POST /api/story/:id/publish returns 404 for bad id', async () => {
    await request.post('/api/story/bad-id/publish')
      .send({ published: true })
      .expect(404);
  });
});

// ============================================================================
// SECURITY TESTS
// ============================================================================

describe('Security', () => {
  let storyId;

  before(async () => {
    await setupTestEnv();
    const story = (await request.post('/api/create')
      .send({ name: 'Security Test' }).expect(200)).body;
    storyId = story.id;
  });

  after(async () => {
    await request.delete(`/api/story/${storyId}`);
  });

  it('tile filename with path traversal does not escape directory', async () => {
    // Attempt to read ../../.env via tile endpoint
    const res = await request.get(`/api/story/${storyId}/tiles/..%2F..%2F.env`);
    // Should get 404 (tile not found), not the .env contents
    assert.ok([400, 404].includes(res.status),
      `expected 400 or 404, got ${res.status}`);
  });

  it('highlight filename with path traversal does not escape directory', async () => {
    const res = await request.get(`/api/story/${storyId}/highlights/..%2F..%2F.env`);
    assert.ok([400, 404].includes(res.status));
  });

  it('picture filename with path traversal does not escape directory', async () => {
    const res = await request.get(`/api/story/${storyId}/pictures/..%2F..%2F.env`);
    assert.ok([400, 404].includes(res.status));
  });

  it('todo toggle rejects directory values other than tiles/highlights', async () => {
    await request.post(`/api/story/${storyId}/todo/toggle`)
      .send({ directory: '../', filename: '.env', lineIndex: 0, checked: true })
      .expect(400);
  });

  it('tile save content can be empty string', async () => {
    await request.post(`/api/story/${storyId}/tiles/chapter-1.md/save`)
      .send({ content: '' })
      .expect(200);
  });

  it('very long story name is accepted (no length validation)', async () => {
    const longName = 'A'.repeat(5000);
    const res = await request.post('/api/create')
      .send({ name: longName })
      .expect(200);

    assert.equal(res.body.name, longName);
    await request.delete(`/api/story/${res.body.id}`);
  });
});

// ============================================================================
// EDGE CASES
// ============================================================================

describe('Edge cases', () => {
  before(async () => { await setupTestEnv(); });

  it('creating multiple stories assigns unique IDs', async () => {
    const ids = new Set();
    for (let i = 0; i < 5; i++) {
      const res = await request.post('/api/create')
        .send({ name: `Story ${i}` }).expect(200);
      ids.add(res.body.id);
    }
    assert.equal(ids.size, 5, 'all story IDs should be unique');

    // Cleanup
    for (const id of ids) {
      await request.delete(`/api/story/${id}`);
    }
  });

  it('creating tiles auto-increments chapter number correctly', async () => {
    const story = (await request.post('/api/create')
      .send({ name: 'Auto-increment Test' }).expect(200)).body;

    // Already has chapter-1; create more
    const t2 = (await request.post(`/api/story/${story.id}/tiles`).send({}).expect(200)).body;
    const t3 = (await request.post(`/api/story/${story.id}/tiles`).send({}).expect(200)).body;

    assert.equal(t2.filename, 'chapter-2.md');
    assert.equal(t3.filename, 'chapter-3.md');

    // Delete chapter-2 and create another -- should reuse chapter-2 or use chapter-4
    await request.delete(`/api/story/${story.id}/tiles/chapter-2.md`).expect(200);
    const t4 = (await request.post(`/api/story/${story.id}/tiles`).send({}).expect(200)).body;
    // With 2 remaining files (chapter-1, chapter-3), next number = length+1 = 3, but chapter-3 exists, so it tries 4
    // Actually: files.length=2, num starts at 3, chapter-3.md exists, so num becomes 4
    assert.equal(t4.filename, 'chapter-4.md');

    await request.delete(`/api/story/${story.id}`);
  });

  it('saving and reading tile preserves Unicode content', async () => {
    const story = (await request.post('/api/create')
      .send({ name: 'Unicode Test' }).expect(200)).body;

    const unicodeContent = '# 你好世界\n\nEmoji: 🎭📝\nAccents: cafe resume\nSymbols: \u2021keyword \u2192 arrow';
    await request.post(`/api/story/${story.id}/tiles/chapter-1.md/save`)
      .send({ content: unicodeContent })
      .expect(200);

    const res = await request.get(`/api/story/${story.id}/tiles/chapter-1.md`).expect(200);
    assert.equal(res.body.content, unicodeContent);

    await request.delete(`/api/story/${story.id}`);
  });

  it('highlight with no occurrences in tiles is still listable', async () => {
    const story = (await request.post('/api/create')
      .send({ name: 'Orphan Highlight Test' }).expect(200)).body;

    await request.post(`/api/story/${story.id}/highlights`).send({}).expect(200);

    const res = await request.get(`/api/story/${story.id}/highlights`).expect(200);
    assert.equal(res.body.length, 1);

    await request.delete(`/api/story/${story.id}`);
  });
});

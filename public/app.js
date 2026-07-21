// Neo Writer - client app
//
// Responsibilities:
// - Render markdown with marked -> HTML
// - Post-process text nodes to replace arrow sequences (but not inside code/pre)
// - Render mermaid diagrams from fenced ```mermaid blocks
// - Full-story preview: renders all tiles concatenated in order (when editing tiles)
// - Single-highlight preview: renders only the active highlight (when editing highlights)
// - Scroll preview to cursor position when typing
// - Binder UI: stories contain tiles and highlights sections
// - Drag-and-drop tile reordering (not for highlights)
(() => {
  const api = (path, opts = {}) => fetch(path, opts).then(r => r.json());
  const $ = id => document.getElementById(id);

  const storyListEl = $('story-list');
  const binderEl = $('binder');
  const binderStoryName = $('binder-story-name');
  const binderTilesList = $('binder-tiles-list');
  const binderHighlightsList = $('binder-highlights-list');
  const btnBack = $('btn-back');
  const btnAddTile = $('btn-add-tile');
  const btnAddHighlight = $('btn-add-highlight');
  const editor = $('editor');
  const preview = $('preview');
  const stats = $('stats');
  const btnNew = $('btn-new');
  const btnRefresh = $('btn-refresh');
  const currentName = $('current-name');
  const openStoryEl = $('open-story-name');
  const userInfoEl = $('user-info');

  // Populate the header user info
  if (typeof window !== 'undefined' && userInfoEl) {
    const uname = window.username || 'anonymous';
    const lm = window.local_mode ? 'local mode' : 'hosted mode';
    userInfoEl.textContent = `${uname} (${lm})`;
  }

  // Initial editor state
  if (editor) {
    editor.disabled = true;
    editor.placeholder = 'create or open a story';
  }
  if (openStoryEl) openStoryEl.textContent = '';

  let currentStoryId = null;
  let currentStoryName = null;

  // Editing mode: 'tile' or 'highlight'
  let editMode = null;
  let currentTileFilename = null;
  let currentHighlightFilename = null;

  // Full-story rendering state
  let tilesOrder = [];
  let tilesCache = {};

  // Highlights list (sorted alphabetically, fetched from server)
  let highlightsList = [];

  // --- Utilities ---

  function updateStats(text) {
    const chars = text.length;
    const words = text.trim().length ? text.trim().split(/\s+/).length : 0;
    stats.textContent = `Words: ${words} \u2014 Chars: ${chars}`;
  }

  function initMermaidIfPresent() {
    if (typeof mermaid === 'undefined') return;
    try {
      mermaid.initialize && mermaid.initialize({ startOnLoad: false, securityLevel: 'loose' });
    } catch (e) {
      console.warn('mermaid.initialize failed', e);
    }
  }
  initMermaidIfPresent();

  function decodeHtmlEntities(html) {
    const tmp = document.createElement('textarea');
    tmp.innerHTML = html;
    return tmp.value;
  }

  function replaceArrowsInContainer(container) {
    if (!container) return;
    const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT, null, false);
    let node;
    while ((node = walker.nextNode())) {
      if (!node.parentElement) continue;
      const skip = node.parentElement.closest && node.parentElement.closest('code, pre');
      if (skip) continue;
      node.nodeValue = node.nodeValue
        .replace(/<-->|<-->/g, '\u2194')
        .replace(/-->|-->/g, '\u2192')
        .replace(/<--|<--/g, '\u2190');
    }
  }

  function renderMermaidDiagrams(container) {
    if (!container || typeof mermaid === 'undefined') return;
    const codeBlocks = container.querySelectorAll('pre code.language-mermaid, code.language-mermaid');
    if (!codeBlocks || codeBlocks.length === 0) return;

    codeBlocks.forEach((code) => {
      const pre = code.closest('pre') || code.parentElement;
      if (!pre || !pre.parentNode) return;
      let diagramText = (code.textContent || '').trim();
      if (!diagramText) diagramText = decodeHtmlEntities(code.innerHTML || '').trim();
      if (!diagramText) return;

      const mermaidDiv = document.createElement('div');
      mermaidDiv.className = 'mermaid';
      mermaidDiv.textContent = diagramText;
      pre.parentNode.replaceChild(mermaidDiv, pre);
    });

    try {
      if (typeof mermaid.init === 'function') {
        const nodes = container.querySelectorAll('.mermaid');
        try { mermaid.init(undefined, nodes); } catch (e) {
          console.warn('mermaid.init failed', e);
        }
      }
      if (mermaid.mermaidAPI && typeof mermaid.mermaidAPI.render === 'function') {
        container.querySelectorAll('.mermaid').forEach((div) => {
          const txt = div.textContent || '';
          if (!txt.trim()) return;
          const id = 'mermaid-' + Math.random().toString(36).slice(2, 9);
          try {
            mermaid.mermaidAPI.render(id, txt, (svgCode) => { div.innerHTML = svgCode; }, div);
          } catch (e) { console.error('mermaid render failed', e); }
        });
      }
    } catch (e) {
      console.error('Error rendering mermaid diagrams', e);
    }
  }

  // Render markdown text into the preview pane with optional scroll fraction
  function renderMarkdownToPreview(text, scrollFraction) {
    const html = (typeof marked !== 'undefined' && typeof marked.parse === 'function') ? marked.parse(text || '') : (text || '');
    const container = document.createElement('div');
    container.innerHTML = html;
    replaceArrowsInContainer(container);
    preview.innerHTML = container.innerHTML;

    try { renderMermaidDiagrams(preview); } catch (e) { console.error('renderMermaidDiagrams error', e); }

    if (typeof scrollFraction === 'number' && isFinite(scrollFraction)) {
      const maxScroll = preview.scrollHeight - preview.clientHeight;
      preview.scrollTop = Math.max(0, Math.min(maxScroll, scrollFraction * preview.scrollHeight));
    }
  }

  // --- Full-story rendering (tiles mode) ---

  function getFullStoryText() {
    return tilesOrder.map(f => tilesCache[f] || '').join('\n\n');
  }

  function getCursorScrollFraction() {
    if (!currentTileFilename || !tilesOrder.length) return 0;
    let offsetBefore = 0;
    for (const f of tilesOrder) {
      if (f === currentTileFilename) break;
      offsetBefore += (tilesCache[f] || '').length + 2;
    }
    const cursorInTile = editor.selectionStart || 0;
    const totalOffset = offsetBefore + cursorInTile;
    const fullLength = getFullStoryText().length;
    if (fullLength === 0) return 0;
    return totalOffset / fullLength;
  }

  function renderFullStory() {
    const fullText = getFullStoryText();
    const fraction = getCursorScrollFraction();
    renderMarkdownToPreview(fullText, fraction);
  }

  // --- Single-highlight rendering (highlight mode) ---

  function renderCurrentHighlight() {
    const text = editor.value || '';
    // Simple proportional scroll based on cursor position in the highlight
    const cursorPos = editor.selectionStart || 0;
    const fraction = text.length > 0 ? cursorPos / text.length : 0;
    renderMarkdownToPreview(text, fraction);
  }

  // --- Render dispatcher ---

  function renderPreview() {
    if (editMode === 'tile') {
      renderFullStory();
    } else if (editMode === 'highlight') {
      renderCurrentHighlight();
    } else {
      // No active edit — show full story if we have tiles
      if (tilesOrder.length > 0) {
        renderMarkdownToPreview(getFullStoryText(), 0);
      } else {
        preview.innerHTML = '';
      }
    }
  }

  // Fetch all tile contents for the current story
  async function fetchAllTilesContent() {
    if (!currentStoryId) return;
    try {
      const tiles = await api(`/api/story/${currentStoryId}/tiles`);
      const tilesList = Array.isArray(tiles) ? tiles : [];
      tilesOrder = tilesList.map(t => t.filename);
      tilesCache = {};
      await Promise.all(tilesList.map(async (tile) => {
        try {
          const res = await api(`/api/story/${currentStoryId}/tiles/${tile.filename}`);
          tilesCache[tile.filename] = res.content || '';
        } catch (e) {
          tilesCache[tile.filename] = '';
        }
      }));
    } catch (e) {
      console.error('failed to fetch all tiles content', e);
    }
  }

  // Fetch highlights list
  async function fetchHighlightsList() {
    if (!currentStoryId) return;
    try {
      const hl = await api(`/api/story/${currentStoryId}/highlights`);
      highlightsList = Array.isArray(hl) ? hl : [];
    } catch (e) {
      console.error('failed to fetch highlights', e);
      highlightsList = [];
    }
  }

  // --- View switching ---

  function showStoryList() {
    storyListEl.style.display = '';
    document.querySelector('.menu-controls').style.display = '';
    binderEl.style.display = 'none';
    currentStoryId = null;
    currentStoryName = null;
    editMode = null;
    currentTileFilename = null;
    currentHighlightFilename = null;
    tilesOrder = [];
    tilesCache = {};
    highlightsList = [];
    if (editor) {
      editor.value = '';
      editor.disabled = true;
      editor.placeholder = 'create or open a story';
    }
    if (openStoryEl) openStoryEl.textContent = '';
    if (currentName) currentName.textContent = '';
    updateStats('');
    if (preview) preview.innerHTML = '';
  }

  async function showBinder(storyId, storyName) {
    currentStoryId = storyId;
    currentStoryName = storyName;
    editMode = null;
    currentTileFilename = null;
    currentHighlightFilename = null;
    storyListEl.style.display = 'none';
    document.querySelector('.menu-controls').style.display = 'none';
    binderEl.style.display = '';
    binderStoryName.textContent = storyName;

    await fetchAllTilesContent();
    await fetchHighlightsList();
    loadTilesList();
    loadHighlightsList();
    renderPreview();
  }

  // --- Story list ---

  function buildStoryItem(item) {
    const li = document.createElement('li');
    li.className = 'story-item';
    li.dataset.id = item.id;

    const left = document.createElement('div');
    left.style.display = 'inline-flex';
    left.style.alignItems = 'center';
    left.style.gap = '8px';
    left.style.flex = '1';
    left.style.overflow = 'hidden';

    const nameSpan = document.createElement('span');
    nameSpan.className = 'story-name';
    nameSpan.textContent = item.name || 'Untitled';
    nameSpan.style.cursor = 'pointer';
    left.appendChild(nameSpan);
    li.appendChild(left);

    const controls = document.createElement('div');
    controls.style.display = 'inline-flex';
    controls.style.gap = '6px';
    controls.style.alignItems = 'center';

    const renameBtn = document.createElement('button');
    renameBtn.className = 'btn-rename';
    renameBtn.textContent = 'Rename';
    controls.appendChild(renameBtn);

    const deleteBtn = document.createElement('button');
    deleteBtn.className = 'btn-delete';
    deleteBtn.textContent = 'Delete';
    deleteBtn.title = 'Delete story';
    controls.appendChild(deleteBtn);

    li.appendChild(controls);

    left.addEventListener('click', () => showBinder(item.id, item.name));
    nameSpan.addEventListener('click', (ev) => { ev.stopPropagation(); showBinder(item.id, item.name); });

    renameBtn.addEventListener('click', async (ev) => {
      ev.stopPropagation();
      const newName = prompt('New name', item.name || 'Untitled');
      if (!newName) return;
      try {
        await api(`/api/rename/${item.id}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: newName })
        });
        await loadList();
      } catch (e) {
        console.error('rename failed', e);
        alert('Rename failed');
      }
    });

    deleteBtn.addEventListener('click', async (ev) => {
      ev.stopPropagation();
      const ok = confirm(`Delete "${item.name || 'Untitled'}"? This action cannot be undone.`);
      if (!ok) return;
      try {
        const resp = await fetch(`/api/story/${item.id}`, { method: 'DELETE' });
        if (!resp.ok) throw new Error('delete failed');
        if (currentStoryId === item.id) showStoryList();
        await loadList();
      } catch (e) {
        console.error('delete failed', e);
        alert('Delete failed');
      }
    });

    return li;
  }

  async function loadList() {
    storyListEl.innerHTML = '';
    try {
      const list = await api('/api/list');
      (Array.isArray(list) ? list : []).forEach(item => {
        storyListEl.appendChild(buildStoryItem(item));
      });
    } catch (e) {
      console.error('failed to load list', e);
      storyListEl.innerHTML = '<li class="error">Failed to load</li>';
    }
  }

  async function createStory() {
    const name = prompt('Story name', 'Untitled');
    if (!name) return;
    try {
      const res = await api('/api/create', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name })
      });
      await loadList();
      if (res && res.id) {
        await showBinder(res.id, res.name);
        if (res.tile && res.tile.filename) {
          openTile(res.tile.filename);
        }
      }
    } catch (e) {
      console.error('create failed', e);
      alert('Create failed');
    }
  }

  // --- Binder: tiles list ---

  function loadTilesList() {
    binderTilesList.innerHTML = '';
    if (!currentStoryId) return;
    tilesOrder.forEach(filename => {
      const tile = { filename, name: filename.replace(/\.md$/, '') };
      binderTilesList.appendChild(buildTileItem(tile));
    });
  }

  function buildTileItem(tile) {
    const li = document.createElement('li');
    li.className = 'tile-item';
    li.dataset.filename = tile.filename;
    if (editMode === 'tile' && tile.filename === currentTileFilename) {
      li.classList.add('active');
    }

    // Drag and drop
    li.draggable = true;
    li.addEventListener('dragstart', (ev) => {
      ev.dataTransfer.effectAllowed = 'move';
      ev.dataTransfer.setData('text/plain', tile.filename);
      li.classList.add('dragging');
    });
    li.addEventListener('dragend', () => {
      li.classList.remove('dragging');
      binderTilesList.querySelectorAll('.tile-item').forEach(el => el.classList.remove('drag-over'));
    });
    li.addEventListener('dragover', (ev) => {
      ev.preventDefault();
      ev.dataTransfer.dropEffect = 'move';
      li.classList.add('drag-over');
    });
    li.addEventListener('dragleave', () => {
      li.classList.remove('drag-over');
    });
    li.addEventListener('drop', async (ev) => {
      ev.preventDefault();
      li.classList.remove('drag-over');
      const draggedFilename = ev.dataTransfer.getData('text/plain');
      if (!draggedFilename || draggedFilename === tile.filename) return;

      const order = [...tilesOrder];
      const fromIdx = order.indexOf(draggedFilename);
      if (fromIdx === -1) return;
      order.splice(fromIdx, 1);
      const toIdx = order.indexOf(tile.filename);
      order.splice(toIdx, 0, draggedFilename);

      try {
        await api(`/api/story/${currentStoryId}/tiles/reorder`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ order })
        });
        tilesOrder = order;
        loadTilesList();
        renderPreview();
      } catch (e) {
        console.error('reorder failed', e);
      }
    });

    const nameSpan = document.createElement('span');
    nameSpan.className = 'tile-name';
    nameSpan.textContent = tile.name;
    nameSpan.title = tile.filename;
    nameSpan.style.cursor = 'pointer';
    li.appendChild(nameSpan);

    const controls = document.createElement('div');
    controls.className = 'tile-controls';

    const renameBtn = document.createElement('button');
    renameBtn.className = 'btn-tile-rename';
    renameBtn.textContent = 'Ren';
    renameBtn.title = 'Rename tile';
    controls.appendChild(renameBtn);

    const deleteBtn = document.createElement('button');
    deleteBtn.className = 'btn-tile-delete';
    deleteBtn.textContent = 'Del';
    deleteBtn.title = 'Delete tile';
    controls.appendChild(deleteBtn);

    li.appendChild(controls);

    nameSpan.addEventListener('click', () => openTile(tile.filename));

    renameBtn.addEventListener('click', async (ev) => {
      ev.stopPropagation();
      const newName = prompt('New tile name', tile.name);
      if (!newName) return;
      try {
        const res = await api(`/api/story/${currentStoryId}/tiles/${tile.filename}/rename`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: newName })
        });
        if (res.filename && res.filename !== tile.filename) {
          const content = tilesCache[tile.filename] || '';
          delete tilesCache[tile.filename];
          tilesCache[res.filename] = content;
          const idx = tilesOrder.indexOf(tile.filename);
          if (idx !== -1) tilesOrder[idx] = res.filename;
          if (currentTileFilename === tile.filename) {
            currentTileFilename = res.filename;
            updateBreadcrumb();
          }
        }
        loadTilesList();
      } catch (e) {
        console.error('rename tile failed', e);
        alert('Rename tile failed');
      }
    });

    deleteBtn.addEventListener('click', async (ev) => {
      ev.stopPropagation();
      const ok = confirm(`Delete tile "${tile.name}"? This cannot be undone.`);
      if (!ok) return;
      try {
        const resp = await fetch(`/api/story/${currentStoryId}/tiles/${tile.filename}`, { method: 'DELETE' });
        if (!resp.ok) throw new Error('delete tile failed');
        delete tilesCache[tile.filename];
        tilesOrder = tilesOrder.filter(f => f !== tile.filename);
        if (editMode === 'tile' && currentTileFilename === tile.filename) {
          editMode = null;
          currentTileFilename = null;
          editor.value = '';
          editor.disabled = true;
          editor.placeholder = 'select a tile to edit';
          updateStats('');
          updateBreadcrumb();
        }
        loadTilesList();
        renderPreview();
      } catch (e) {
        console.error('delete tile failed', e);
        alert('Delete tile failed');
      }
    });

    return li;
  }

  function openTile(filename) {
    if (!currentStoryId) return;
    editMode = 'tile';
    currentTileFilename = filename;
    currentHighlightFilename = null;
    const content = tilesCache[filename] || '';
    if (editor) {
      editor.disabled = false;
      editor.value = content;
      editor.placeholder = 'Start typing markdown...';
    }
    updateStats(editor.value);
    updateBreadcrumb();
    loadTilesList();
    loadHighlightsList();
    renderPreview();
    try { editor.focus(); } catch (e) {}
  }

  async function addTile() {
    if (!currentStoryId) return;
    try {
      const res = await api(`/api/story/${currentStoryId}/tiles`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({})
      });
      if (res && res.filename) {
        tilesOrder.push(res.filename);
        tilesCache[res.filename] = '';
        loadTilesList();
        openTile(res.filename);
      }
    } catch (e) {
      console.error('add tile failed', e);
      alert('Add tile failed');
    }
  }

  // --- Binder: highlights list ---

  function loadHighlightsList() {
    binderHighlightsList.innerHTML = '';
    if (!currentStoryId) return;
    if (highlightsList.length === 0) {
      const placeholder = document.createElement('li');
      placeholder.className = 'binder-placeholder';
      placeholder.textContent = 'No highlights yet';
      binderHighlightsList.appendChild(placeholder);
      return;
    }
    highlightsList.forEach(hl => {
      binderHighlightsList.appendChild(buildHighlightItem(hl));
    });
  }

  function buildHighlightItem(hl) {
    const li = document.createElement('li');
    li.className = 'tile-item';
    li.dataset.filename = hl.filename;
    if (editMode === 'highlight' && hl.filename === currentHighlightFilename) {
      li.classList.add('active');
    }
    // No drag-and-drop for highlights

    const nameSpan = document.createElement('span');
    nameSpan.className = 'tile-name';
    nameSpan.textContent = hl.name;
    nameSpan.title = hl.filename;
    nameSpan.style.cursor = 'pointer';
    li.appendChild(nameSpan);

    const controls = document.createElement('div');
    controls.className = 'tile-controls';

    const renameBtn = document.createElement('button');
    renameBtn.className = 'btn-tile-rename';
    renameBtn.textContent = 'Ren';
    renameBtn.title = 'Rename highlight';
    controls.appendChild(renameBtn);

    const deleteBtn = document.createElement('button');
    deleteBtn.className = 'btn-tile-delete';
    deleteBtn.textContent = 'Del';
    deleteBtn.title = 'Delete highlight';
    controls.appendChild(deleteBtn);

    li.appendChild(controls);

    nameSpan.addEventListener('click', () => openHighlight(hl.filename));

    renameBtn.addEventListener('click', async (ev) => {
      ev.stopPropagation();
      const newName = prompt('New highlight name', hl.name);
      if (!newName) return;
      try {
        const res = await api(`/api/story/${currentStoryId}/highlights/${hl.filename}/rename`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: newName })
        });
        if (res.filename && res.filename !== hl.filename) {
          if (editMode === 'highlight' && currentHighlightFilename === hl.filename) {
            currentHighlightFilename = res.filename;
            updateBreadcrumb();
          }
        }
        // Re-fetch highlights (order may change due to alphabetical sort)
        await fetchHighlightsList();
        loadHighlightsList();
      } catch (e) {
        console.error('rename highlight failed', e);
        alert('Rename highlight failed');
      }
    });

    deleteBtn.addEventListener('click', async (ev) => {
      ev.stopPropagation();
      const ok = confirm(`Delete highlight "${hl.name}"? This cannot be undone.`);
      if (!ok) return;
      try {
        const resp = await fetch(`/api/story/${currentStoryId}/highlights/${hl.filename}`, { method: 'DELETE' });
        if (!resp.ok) throw new Error('delete highlight failed');
        if (editMode === 'highlight' && currentHighlightFilename === hl.filename) {
          editMode = null;
          currentHighlightFilename = null;
          editor.value = '';
          editor.disabled = true;
          editor.placeholder = 'select a tile or highlight to edit';
          updateStats('');
          updateBreadcrumb();
          renderPreview();
        }
        await fetchHighlightsList();
        loadHighlightsList();
      } catch (e) {
        console.error('delete highlight failed', e);
        alert('Delete highlight failed');
      }
    });

    return li;
  }

  async function openHighlight(filename) {
    if (!currentStoryId) return;
    try {
      const res = await api(`/api/story/${currentStoryId}/highlights/${filename}`);
      editMode = 'highlight';
      currentHighlightFilename = filename;
      currentTileFilename = null;
      if (editor) {
        editor.disabled = false;
        editor.value = res.content || '';
        editor.placeholder = 'Start typing markdown...';
      }
      updateStats(editor.value);
      updateBreadcrumb();
      loadTilesList();
      loadHighlightsList();
      renderPreview();
      try { editor.focus(); } catch (e) {}
    } catch (e) {
      console.error('load highlight failed', e);
      alert('Failed to load highlight');
    }
  }

  async function addHighlight() {
    if (!currentStoryId) return;
    try {
      const res = await api(`/api/story/${currentStoryId}/highlights`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({})
      });
      if (res && res.filename) {
        await fetchHighlightsList();
        loadHighlightsList();
        openHighlight(res.filename);
      }
    } catch (e) {
      console.error('add highlight failed', e);
      alert('Add highlight failed');
    }
  }

  // --- Breadcrumb ---

  function updateBreadcrumb() {
    const storyLabel = currentStoryName || '';
    let itemLabel = '';
    if (editMode === 'tile' && currentTileFilename) {
      itemLabel = currentTileFilename.replace(/\.md$/, '');
    } else if (editMode === 'highlight' && currentHighlightFilename) {
      itemLabel = currentHighlightFilename.replace(/\.md$/, '');
    }
    const breadcrumb = itemLabel ? `${storyLabel} \u203A ${itemLabel}` : storyLabel;
    if (openStoryEl) openStoryEl.textContent = breadcrumb;
    if (currentName) currentName.textContent = breadcrumb;
  }

  // --- Autosave ---

  async function saveCurrent() {
    if (!currentStoryId) return;
    if (editMode === 'tile' && currentTileFilename) {
      try {
        await fetch(`/api/story/${currentStoryId}/tiles/${currentTileFilename}/save`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ content: editor.value })
        });
      } catch (e) {
        console.error('autosave failed', e);
      }
    } else if (editMode === 'highlight' && currentHighlightFilename) {
      try {
        await fetch(`/api/story/${currentStoryId}/highlights/${currentHighlightFilename}/save`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ content: editor.value })
        });
      } catch (e) {
        console.error('autosave failed', e);
      }
    }
  }

  // --- Event listeners ---

  editor.addEventListener('input', () => {
    const text = editor.value;
    updateStats(text);

    // Update cache
    if (editMode === 'tile' && currentTileFilename) {
      tilesCache[currentTileFilename] = text;
    }

    renderPreview();
    saveCurrent();
  });

  editor.addEventListener('click', () => {
    if (editMode) renderPreview();
  });
  editor.addEventListener('keyup', (ev) => {
    if (['ArrowUp','ArrowDown','ArrowLeft','ArrowRight','Home','End','PageUp','PageDown'].includes(ev.key)) {
      if (editMode) renderPreview();
    }
  });

  btnNew.addEventListener('click', createStory);
  btnRefresh.addEventListener('click', loadList);
  btnBack.addEventListener('click', () => {
    showStoryList();
    loadList();
  });
  btnAddTile.addEventListener('click', addTile);
  btnAddHighlight.addEventListener('click', addHighlight);

  // --- Context menu ---

  const contextMenu = $('context-menu');

  function showContextMenu(x, y) {
    contextMenu.style.left = x + 'px';
    contextMenu.style.top = y + 'px';
    contextMenu.style.display = 'block';
  }

  function hideContextMenu() {
    contextMenu.style.display = 'none';
  }

  editor.addEventListener('contextmenu', (ev) => {
    if (editor.disabled) return; // don't show if no file open
    ev.preventDefault();
    showContextMenu(ev.clientX, ev.clientY);
  });

  document.addEventListener('click', (ev) => {
    if (!contextMenu.contains(ev.target)) {
      hideContextMenu();
    }
  });

  document.addEventListener('keydown', (ev) => {
    if (ev.key === 'Escape') hideContextMenu();
  });

  contextMenu.addEventListener('click', (ev) => {
    const action = ev.target.dataset.action;
    if (!action) return;
    hideContextMenu();

    if (action === 'insert-table') {
      insertTable();
    } else if (action === 'insert-picture') {
      insertPicture();
    }
  });

  function insertTable() {
    const table = '\n| Col 1 | Col 2 | Col 3 |\n|-------|-------|-------|\n|       |       |       |\n|       |       |       |\n';
    // Insert at the end of selection (selectionEnd), without deleting selected text
    const pos = editor.selectionEnd;
    const before = editor.value.substring(0, pos);
    const after = editor.value.substring(pos);
    editor.value = before + table + after;

    // Place cursor after the inserted table
    const newPos = pos + table.length;
    editor.selectionStart = newPos;
    editor.selectionEnd = newPos;

    // Trigger update
    editor.dispatchEvent(new Event('input'));
    editor.focus();
  }

  // --- Insert Picture (dialog-based) ---

  const picDialogOverlay = $('picture-dialog-overlay');
  const picDialogName = $('picture-dialog-name');
  const picDialogUrl = $('picture-dialog-url');
  const picDialogFile = $('picture-dialog-file');
  const picDialogCancel = $('picture-dialog-cancel');
  const picDialogOk = $('picture-dialog-ok');
  let pictureInsertPos = null;

  function openPictureDialog() {
    picDialogName.value = '';
    picDialogUrl.value = '';
    picDialogFile.value = '';
    pictureInsertPos = editor.selectionEnd;
    editor.selectionStart = pictureInsertPos;
    picDialogOverlay.style.display = '';
    picDialogName.focus();
  }

  function closePictureDialog() {
    picDialogOverlay.style.display = 'none';
  }

  function insertPicture() {
    if (!currentStoryId) return;
    openPictureDialog();
  }

  picDialogCancel.addEventListener('click', closePictureDialog);
  picDialogOverlay.addEventListener('click', (ev) => {
    if (ev.target === picDialogOverlay) closePictureDialog();
  });

  picDialogOk.addEventListener('click', async () => {
    const baseName = picDialogName.value.trim();
    const urlValue = picDialogUrl.value.trim();
    const fileValue = picDialogFile.files[0];

    if (!baseName) {
      alert('Please provide a name for the picture.');
      return;
    }

    // Determine source: file takes priority over URL
    let extension = '';
    let source = null; // 'file' or 'url'

    if (fileValue) {
      source = 'file';
      // Get extension from the uploaded file
      const parts = fileValue.name.split('.');
      extension = parts.length > 1 ? '.' + parts.pop().toLowerCase() : '';
    } else if (urlValue) {
      source = 'url';
      // Try to extract extension from URL
      try {
        const urlPath = new URL(urlValue).pathname;
        const urlParts = urlPath.split('/').pop().split('.');
        extension = urlParts.length > 1 ? '.' + urlParts.pop().toLowerCase() : '.png';
      } catch (e) {
        extension = '.png';
      }
    } else {
      alert('Please upload a file or provide a URL.');
      return;
    }

    const fullFilename = baseName + extension;

    // Check if file exists
    try {
      const check = await api(`/api/story/${currentStoryId}/pictures/${encodeURIComponent(fullFilename)}/exists`);
      if (check.exists) {
        const overwrite = confirm(`A picture named "${fullFilename}" already exists. Overwrite?`);
        if (!overwrite) return;
      }
    } catch (e) {
      // proceed
    }

    closePictureDialog();

    if (source === 'file') {
      // Read file as base64 and upload
      const reader = new FileReader();
      reader.onload = async () => {
        const base64 = reader.result.split(',')[1];
        await uploadPictureData(fullFilename, base64);
      };
      reader.readAsDataURL(fileValue);
    } else if (source === 'url') {
      await uploadPictureFromUrl(fullFilename, urlValue);
    }
  });

  async function uploadPictureData(name, base64Data) {
    if (!currentStoryId) return;
    try {
      const res = await api(`/api/story/${currentStoryId}/pictures`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, data: base64Data })
      });
      if (res.ok && res.path) {
        insertPictureMarkdown(name, res.path);
      } else {
        alert('Failed to upload picture');
      }
    } catch (e) {
      console.error('upload picture failed', e);
      alert('Failed to upload picture');
    }
  }

  async function uploadPictureFromUrl(name, url) {
    if (!currentStoryId) return;
    try {
      const res = await api(`/api/story/${currentStoryId}/pictures`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, url })
      });
      if (res.ok && res.path) {
        insertPictureMarkdown(name, res.path);
      } else {
        alert('Failed to upload picture from URL');
      }
    } catch (e) {
      console.error('upload picture from URL failed', e);
      alert('Failed to upload picture from URL');
    }
  }

  function insertPictureMarkdown(altText, picPath) {
    const md = `\n![${altText}](${picPath})\n`;
    const pos = pictureInsertPos != null ? pictureInsertPos : editor.selectionEnd;
    const before = editor.value.substring(0, pos);
    const after = editor.value.substring(pos);
    editor.value = before + md + after;

    const newPos = pos + md.length;
    editor.selectionStart = newPos;
    editor.selectionEnd = newPos;

    editor.dispatchEvent(new Event('input'));
    editor.focus();
    pictureInsertPos = null;
  }

  // --- Initial load ---
  showStoryList();
  loadList();

  // Expose for debugging
  window._neo = { loadList, openTile, openHighlight, saveCurrent, renderPreview, showBinder, showStoryList };
})();

// Neo Writer - client app
//
// Responsibilities:
// - Render markdown with marked -> HTML
// - Post-process text nodes to replace arrow sequences (but not inside code/pre)
// - Render mermaid diagrams from fenced ```mermaid blocks
// - Sync editor -> preview scrolling and autosave
// - Binder UI: stories contain tiles and highlights sections
(() => {
  const api = (path, opts = {}) => fetch(path, opts).then(r => r.json());
  const $ = id => document.getElementById(id);

  const sidebarEl = $('sidebar');
  const storyListEl = $('story-list');
  const binderEl = $('binder');
  const binderStoryName = $('binder-story-name');
  const binderTilesList = $('binder-tiles-list');
  const btnBack = $('btn-back');
  const btnAddTile = $('btn-add-tile');
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

  // Initial editor state: disabled until user opens a tile.
  if (editor) {
    editor.disabled = true;
    editor.placeholder = 'create or open a story';
  }
  if (openStoryEl) openStoryEl.textContent = '';

  let currentStoryId = null;
  let currentStoryName = null;
  let currentTileFilename = null;

  // --- Utilities ---

  function updateStats(text) {
    const chars = text.length;
    const words = text.trim().length ? text.trim().split(/\s+/).length : 0;
    stats.textContent = `Words: ${words} — Chars: ${chars}`;
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

  function renderMarkdown(text, forceScrollBottom = false) {
    const html = (typeof marked !== 'undefined' && typeof marked.parse === 'function') ? marked.parse(text || '') : (text || '');
    const container = document.createElement('div');
    container.innerHTML = html;
    replaceArrowsInContainer(container);
    preview.innerHTML = container.innerHTML;

    try { renderMermaidDiagrams(preview); } catch (e) { console.error('renderMermaidDiagrams error', e); }

    try {
      if (forceScrollBottom) {
        preview.scrollTop = preview.scrollHeight;
      } else {
        const editorAtBottom = (editor.scrollTop + editor.clientHeight) >= (editor.scrollHeight - 20);
        if (editorAtBottom) {
          preview.scrollTop = preview.scrollHeight;
        } else {
          const editorScroll = editor.scrollTop;
          const editorHeight = Math.max(1, editor.scrollHeight - editor.clientHeight);
          const previewHeight = Math.max(1, preview.scrollHeight - preview.clientHeight);
          const ratio = editorScroll / editorHeight;
          preview.scrollTop = ratio * previewHeight;
        }
      }
    } catch (e) {}
  }

  function syncScrollFromEditor() {
    try {
      const editorScroll = editor.scrollTop;
      const editorHeight = Math.max(1, editor.scrollHeight - editor.clientHeight);
      const previewHeight = Math.max(1, preview.scrollHeight - preview.clientHeight);
      const ratio = editorScroll / editorHeight;
      preview.scrollTop = ratio * previewHeight;
    } catch (e) {}
  }

  // --- View switching: story list vs binder ---

  function showStoryList() {
    storyListEl.style.display = '';
    document.querySelector('.menu-controls').style.display = '';
    binderEl.style.display = 'none';
    currentStoryId = null;
    currentStoryName = null;
    currentTileFilename = null;
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

  function showBinder(storyId, storyName) {
    currentStoryId = storyId;
    currentStoryName = storyName;
    storyListEl.style.display = 'none';
    document.querySelector('.menu-controls').style.display = 'none';
    binderEl.style.display = '';
    binderStoryName.textContent = storyName;
    loadTilesList();
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

    // Click name to open binder
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
        if (currentStoryId === item.id) {
          showStoryList();
        }
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
        showBinder(res.id, res.name);
        // Open the first tile in the editor
        if (res.tile && res.tile.filename) {
          loadTile(res.tile.filename);
        }
      }
    } catch (e) {
      console.error('create failed', e);
      alert('Create failed');
    }
  }

  // --- Binder: tiles list ---

  async function loadTilesList() {
    binderTilesList.innerHTML = '';
    if (!currentStoryId) return;
    try {
      const tiles = await api(`/api/story/${currentStoryId}/tiles`);
      (Array.isArray(tiles) ? tiles : []).forEach(tile => {
        binderTilesList.appendChild(buildTileItem(tile));
      });
    } catch (e) {
      console.error('failed to load tiles', e);
      binderTilesList.innerHTML = '<li class="error">Failed to load tiles</li>';
    }
  }

  function buildTileItem(tile) {
    const li = document.createElement('li');
    li.className = 'tile-item';
    li.dataset.filename = tile.filename;
    if (tile.filename === currentTileFilename) {
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
      // Remove all drop indicators
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

      // Compute new order from current DOM
      const items = Array.from(binderTilesList.querySelectorAll('.tile-item'));
      const order = items.map(el => el.dataset.filename);
      // Remove dragged item from its current position
      const fromIdx = order.indexOf(draggedFilename);
      if (fromIdx === -1) return;
      order.splice(fromIdx, 1);
      // Insert before the drop target
      const toIdx = order.indexOf(tile.filename);
      order.splice(toIdx, 0, draggedFilename);

      // Save new order to server
      try {
        await api(`/api/story/${currentStoryId}/tiles/reorder`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ order })
        });
        await loadTilesList();
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

    // Click to open tile
    nameSpan.addEventListener('click', () => loadTile(tile.filename));

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
        // If the currently open tile was renamed, update the reference
        if (currentTileFilename === tile.filename && res.filename) {
          currentTileFilename = res.filename;
          updateBreadcrumb();
        }
        await loadTilesList();
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
        // If the deleted tile was open, clear editor
        if (currentTileFilename === tile.filename) {
          currentTileFilename = null;
          editor.value = '';
          editor.disabled = true;
          editor.placeholder = 'select a tile to edit';
          updateStats('');
          preview.innerHTML = '';
          updateBreadcrumb();
        }
        await loadTilesList();
      } catch (e) {
        console.error('delete tile failed', e);
        alert('Delete tile failed');
      }
    });

    return li;
  }

  async function loadTile(filename) {
    if (!currentStoryId) return;
    try {
      const res = await api(`/api/story/${currentStoryId}/tiles/${filename}`);
      currentTileFilename = filename;
      if (editor) {
        editor.disabled = false;
        editor.value = res.content || '';
        editor.placeholder = 'Start typing markdown...';
      }
      updateStats(editor.value);
      renderMarkdown(editor.value);
      updateBreadcrumb();
      // Highlight active tile in list
      loadTilesList();
      try { editor.focus(); } catch (e) {}
    } catch (e) {
      console.error('load tile failed', e);
      alert('Failed to load tile');
    }
  }

  async function addTile() {
    if (!currentStoryId) return;
    try {
      const res = await api(`/api/story/${currentStoryId}/tiles`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({})
      });
      await loadTilesList();
      if (res && res.filename) {
        loadTile(res.filename);
      }
    } catch (e) {
      console.error('add tile failed', e);
      alert('Add tile failed');
    }
  }

  function updateBreadcrumb() {
    const storyLabel = currentStoryName || '';
    const tileLabel = currentTileFilename ? currentTileFilename.replace(/\.md$/, '') : '';
    const breadcrumb = tileLabel ? `${storyLabel} › ${tileLabel}` : storyLabel;
    if (openStoryEl) openStoryEl.textContent = breadcrumb;
    if (currentName) currentName.textContent = breadcrumb;
  }

  // --- Autosave ---

  async function saveCurrent() {
    if (!currentStoryId || !currentTileFilename) return;
    try {
      await fetch(`/api/story/${currentStoryId}/tiles/${currentTileFilename}/save`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: editor.value })
      });
    } catch (e) {
      console.error('autosave failed', e);
    }
  }

  // --- Event listeners ---

  editor.addEventListener('input', () => {
    const text = editor.value;
    updateStats(text);
    const caretAtEnd = (editor.selectionStart === editor.selectionEnd)
      && (editor.selectionStart >= editor.value.length - 1);
    renderMarkdown(text, caretAtEnd);
    saveCurrent();
  });

  editor.addEventListener('scroll', syncScrollFromEditor);

  btnNew.addEventListener('click', createStory);
  btnRefresh.addEventListener('click', loadList);
  btnBack.addEventListener('click', () => {
    showStoryList();
    loadList();
  });
  btnAddTile.addEventListener('click', addTile);

  // --- Initial load ---
  showStoryList();
  loadList();

  // Expose for debugging
  window._neo = { loadList, loadTile, saveCurrent, renderMarkdown, showBinder, showStoryList };
})();
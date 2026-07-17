// Neo Writer - client app (clean, stable implementation)
//
// Responsibilities:
// - Render markdown with marked -> HTML
// - Post-process text nodes to replace arrow sequences (but not inside code/pre)
// - Render mermaid diagrams from fenced ```mermaid blocks
// - Sync editor -> preview scrolling and autosave
(() => {
  const api = (path, opts = {}) => fetch(path, opts).then(r => r.json());
  const $ = id => document.getElementById(id);

  const storyListEl = $('story-list');
  const editor = $('editor');
  const preview = $('preview');
  const stats = $('stats');
  const btnNew = $('btn-new');
  const btnRefresh = $('btn-refresh');
  const currentName = $('current-name');
  const openStoryEl = $('open-story-name');
  const userInfoEl = $('user-info');
  // Populate the header user info exposed by index.html
  if (typeof window !== 'undefined' && userInfoEl) {
    const uname = window.username || 'anonymous';
    const lm = window.local_mode ? 'local mode' : 'hosted mode';
    userInfoEl.textContent = `${uname} (${lm})`;
  }

  // Initial editor state: disabled until user opens/creates a story.
  if (editor) {
    editor.disabled = true;
    editor.placeholder = 'create or open a story';
  }
  if (openStoryEl) openStoryEl.textContent = '';

  let currentId = null;

  // Utilities
  function updateStats(text) {
    const chars = text.length;
    const words = text.trim().length ? text.trim().split(/\s+/).length : 0;
    stats.textContent = `Words: ${words} — Chars: ${chars}`;
  }

  // Attempt to initialize mermaid if it's available on the page.
  // We use startOnLoad: false so we render programmatically.
  function initMermaidIfPresent() {
    if (typeof mermaid === 'undefined') return;
    try {
      mermaid.initialize && mermaid.initialize({ startOnLoad: false, securityLevel: 'loose' });
    } catch (e) {
      console.warn('mermaid.initialize failed', e);
    }
  }
  initMermaidIfPresent();

  // Decode HTML entities safely (used to decode > etc. inside code blocks if needed)
  function decodeHtmlEntities(html) {
    const tmp = document.createElement('textarea');
    tmp.innerHTML = html;
    return tmp.value;
  }

  // Replace arrow-like sequences in text nodes within `container`, but skip nodes that
  // are inside <code> or <pre> elements.
  function replaceArrowsInContainer(container) {
    if (!container) return;
    const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT, null, false);
    let node;
    while ((node = walker.nextNode())) {
      // skip replacements inside code or pre elements
      if (!node.parentElement) continue;
      const skip = node.parentElement.closest && node.parentElement.closest('code, pre');
      if (skip) continue;

      node.nodeValue = node.nodeValue
        .replace(/<-->|<-->/g, '↔')
        .replace(/-->|-->/g, '→')
        .replace(/<--|<--/g, '←');
    }
  }

  // Render mermaid diagrams inside `container`.
  // Looks for fenced code blocks produced by marked: <pre><code class="language-mermaid">...</code></pre>
  // It replaces the <pre> with a div.mermaid containing the raw diagram text and invokes mermaid.
  function renderMermaidDiagrams(container) {
    if (!container || typeof mermaid === 'undefined') return;

    // selector: code blocks labeled as language-mermaid (common output of marked)
    const codeBlocks = container.querySelectorAll('pre code.language-mermaid, code.language-mermaid');
    if (!codeBlocks || codeBlocks.length === 0) return;

    // Replace each code block's <pre> with a div.mermaid containing the diagram text.
    codeBlocks.forEach((code) => {
      const pre = code.closest('pre') || code.parentElement;
      if (!pre || !pre.parentNode) return;

      // Prefer textContent (often already unescaped), otherwise decode innerHTML
      let diagramText = (code.textContent || '').trim();
      if (!diagramText) diagramText = decodeHtmlEntities(code.innerHTML || '').trim();
      if (!diagramText) return;

      const mermaidDiv = document.createElement('div');
      mermaidDiv.className = 'mermaid';
      // Use textContent so the diagram text isn't interpreted as HTML.
      mermaidDiv.textContent = diagramText;

      pre.parentNode.replaceChild(mermaidDiv, pre);
    });

    // Now invoke mermaid on the newly inserted elements.
    try {
      // Preferred API: mermaid.init (initializes elements with class 'mermaid')
      if (typeof mermaid.init === 'function') {
        // Pass NodeList of new elements under container
        const nodes = container.querySelectorAll('.mermaid');
        // mermaid.init may accept a selector or NodeList depending on version; passing NodeList works in common builds
        try {
          mermaid.init && mermaid.init(undefined, nodes);
        } catch (e) {
          // fallthrough to mermaid.mermaidAPI if init fails
          console.warn('mermaid.init failed, falling back to mermaid.mermaidAPI if available', e);
        }
      }

      // If mermaid.init didn't render (or isn't available), try mermaid.mermaidAPI.render for each element
      if (mermaid.mermaidAPI && typeof mermaid.mermaidAPI.render === 'function') {
        container.querySelectorAll('.mermaid').forEach((div) => {
          const txt = div.textContent || '';
          if (!txt.trim()) return;
          const id = 'mermaid-' + Math.random().toString(36).slice(2, 9);
          try {
            // mermaidAPI.render(name, txt, cb, element)
            mermaid.mermaidAPI.render(id, txt, (svgCode) => {
              div.innerHTML = svgCode;
            }, div);
          } catch (e) {
            console.error('mermaid.mermaidAPI.render failed', e);
          }
        });
      }
    } catch (e) {
      console.error('Error rendering mermaid diagrams', e);
    }
  }

  // Main render pipeline: markdown -> html (marked), post-process, mermaid render, insert into preview, sync scroll.
  function renderMarkdown(text, forceScrollBottom = false) {
    const html = (typeof marked !== 'undefined' && typeof marked.parse === 'function') ? marked.parse(text || '') : (text || '');

    const container = document.createElement('div');
    container.innerHTML = html;

    // Arrow replacementsskip code/pre)
    replaceArrowsInContainer(container);

    // Insert processed HTML to preview
    preview.innerHTML = container.innerHTML;

    // Mermaid rendering: replace code blocks with SVGs where applicable
    try {
      renderMermaidDiagrams(preview);
    } catch (e) {
      // mermaid may not be available or may throw; keep the raw output in that case
      console.error('renderMermaidDiagrams error', e);
    }

    // Scroll sync: if forced or editor at bottom, scroll preview to bottom; otherwise proportional sync
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
    } catch (e) {
      // ignore measurement errors
    }
  }

  // Editor -> preview proportional scroll sync helper (used on 'scroll' events)
  function syncScrollFromEditor() {
    try {
      const editorScroll = editor.scrollTop;
      const editorHeight = Math.max(1, editor.scrollHeight - editor.clientHeight);
      const previewHeight = Math.max(1, preview.scrollHeight - preview.clientHeight);
      const ratio = editorScroll / editorHeight;
      preview.scrollTop = ratio * previewHeight;
    } catch (e) {
      // ignore measurement errors
    }
  }

  // Story list / load / save functions (unchanged behavior)
  function buildStoryItem(item) {
    const li = document.createElement('li');
    li.className = 'story-item';
    li.dataset.id = item.id;
    li.dataset.author = item.author || (window && window.username) || 'anonymous';
    li.style.cursor = 'pointer';
    li.style.display = 'flex';
    li.style.justifyContent = 'space-between';
    li.style.alignItems = 'center';

    const left = document.createElement('div');
    left.style.display = 'inline-flex';
    left.style.alignItems = 'center';
    left.style.gap = '8px';

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

    // Click the whole left area to open the story in the editor.
    // If the rename/delete button (or a child) was clicked, do not open.
    left.addEventListener('click', (ev) => {
      if (ev && ev.target && ev.target.closest && (ev.target.closest('.btn-rename') || ev.target.closest('.btn-delete'))) return;
      loadStory(item.id);
    });

    // Allow clicking the name to open explicitly as well.
    nameSpan.addEventListener('click', () => loadStory(item.id));

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
        if (currentId === item.id) currentName.textContent = newName;
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
        // remove from UI and reload list
        if (currentId === item.id) {
          currentId = null;
          if (editor) {
            editor.value = '';
            editor.disabled = true;
            editor.placeholder = 'create or open a story';
          }
          currentName.textContent = '';
          if (openStoryEl) openStoryEl.textContent = '';
          updateStats('');
          if (preview) preview.innerHTML = '';
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
    const name = prompt('Story name', 'Untitled') || 'Untitled';
    try {
      const res = await api('/api/create', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name })
      });
 await loadList();
      if (res && res.id) loadStory(res.id);
    } catch (e) {
      console.error('create failed', e);
      alert('Create failed');
    }
  }

  async function loadStory(id) {
    try {
      const res = await api(`/api/story/${id}`);
      currentId = id;
      // enable editor and populate
      if (editor) {
        editor.disabled = false;
        editor.value = res.content || '';
        editor.placeholder = 'Start typing markdown...';
      }
      currentName.textContent = res.name || 'Untitled';
      if (openStoryEl) openStoryEl.textContent = res.name || 'Untitled';
      updateStats(editor.value);
      renderMarkdown(editor.value);
      // focus editor after a short delay to ensure it's enabled
      try { editor.focus(); } catch (e) {}
    } catch (e) {
      console.error('load story failed', e);
      alert('Failed to load story');
    }
  }

  async function saveCurrent() {
    if (!currentId) return;
    try {
      await fetch(`/api/save/${currentId}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: editor.value })
      });
    } catch (e) {
      console.error('autosave failed', e);
    }
  }

  // Autosave on every keystroke (persist with each keystroke)
  editor.addEventListener('input', (ev) => {
    const text = editor.value;
    updateStats(text);

    // Detect whether the caret is at the end of the document (no selection)
    const caretAtEnd = (editor.selectionStart === editor.selectionEnd)
      && (editor.selectionStart >= editor.value.length - 1);

    renderMarkdown(text, caretAtEnd);

    // save immediately (no debounce)
    saveCurrent();
  });

  // Sync scrolling editor -> preview
  editor.addEventListener('scroll', syncScrollFromEditor);

  // Buttons
  btnNew.addEventListener('click', createStory);
  btnRefresh.addEventListener('click', loadList);

  // Initial load
  loadList();

  // Expose for debugging
  window._neo = { loadList, loadStory, saveCurrent, renderMarkdown };
})();

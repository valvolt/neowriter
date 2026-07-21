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

  // Highlights sort mode: 'alpha', 'most', 'least'
  let highlightsSortMode = 'alpha';
  const highlightsSortEl = $('highlights-sort');

  // Bubble keyword: when set, highlights with this keyword float to top
  let highlightsBubbleKeyword = null;

  // Toggle for highlight rendering in preview
  let highlightsRenderEnabled = true;
  const toggleHighlightsEl = $('toggle-highlights');

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

  // Configure marked: open links in new tab + sanitize raw HTML
  if (typeof marked !== 'undefined') {
    marked.use({
      renderer: {
        // Escape raw HTML blocks/inline so they display as text, not rendered HTML
        html(token) {
          const raw = typeof token === 'string' ? token : (token.raw || token.text || '');
          return raw.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
        },
        // Open all links in new tab
        link(token) {
          const href = typeof token === 'string' ? token : (token.href || '');
          const title = (typeof token === 'object' && token.title) ? ` title="${token.title}"` : '';
          const text = (typeof token === 'object' && token.text) ? token.text : href;
          return `<a href="${href}"${title} target="_blank" rel="noopener noreferrer">${text}</a>`;
        }
      }
    });
  }

  // Pre-process markdown: convert lines starting with "- " to em-dash dialogue
  // (prevents marked from interpreting them as unordered list items)
  // Exception: task items "- [ ]", "- [x]", "- [X]" are left intact for checkbox rendering
  function preprocessMarkdown(text) {
    return text.replace(/^- (?!\[[ xX]\])/gm, '\u2014 ');
  }

  // Render markdown text into the preview pane with optional scroll fraction
  function renderMarkdownToPreview(text, scrollFraction) {
    const processed = preprocessMarkdown(text || '');
    const html = (typeof marked !== 'undefined' && typeof marked.parse === 'function') ? marked.parse(processed) : (processed);
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

  // --- Keyword pill rendering ---

  function hashStringToInt(str) {
    let h = 0;
    for (let i = 0; i < str.length; i++) {
      h = ((h << 5) - h) + str.charCodeAt(i);
      h |= 0;
    }
    return Math.abs(h);
  }

  function keywordStyleFor(keyword) {
    const palette = [
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
      { background: 'rgb(236, 239, 241)', color: 'rgb(33, 33, 33)' }
    ];
    const key = (typeof keyword === 'string') ? keyword.toLowerCase() : String(keyword || '');
    const idx = hashStringToInt(key) % palette.length;
    return palette[idx];
  }

  function renderKeywordsInPreview() {
    // Match ‡ followed by word characters (Unicode letters, numbers, hyphens, underscores)
    const re = /\u2021([\p{L}\p{N}_-]+)/gu;

    const walker = document.createTreeWalker(preview, NodeFilter.SHOW_TEXT, null, false);
    const textNodes = [];
    let node;
    while ((node = walker.nextNode())) {
      textNodes.push(node);
    }

    textNodes.forEach(textNode => {
      if (!textNode.parentElement) return;
      const parent = textNode.parentElement;
      if (parent.closest('code, pre, .mermaid, .keyword-pill')) return;

      const text = textNode.nodeValue;
      if (!re.test(text)) return;
      re.lastIndex = 0;

      const frag = document.createDocumentFragment();
      let lastIndex = 0;
      let match;
      re.lastIndex = 0;
      while ((match = re.exec(text)) !== null) {
        if (match.index > lastIndex) {
          frag.appendChild(document.createTextNode(text.substring(lastIndex, match.index)));
        }
        const span = document.createElement('span');
        span.className = 'keyword-pill';
        span.textContent = match[1]; // keyword without the ‡
        const style = keywordStyleFor(match[1]);
        span.style.background = style.background;
        span.style.color = style.color;
        frag.appendChild(span);
        lastIndex = re.lastIndex;
      }
      if (lastIndex < text.length) {
        frag.appendChild(document.createTextNode(text.substring(lastIndex)));
      }
      parent.replaceChild(frag, textNode);
    });
  }

  // --- Highlight words in preview ---

  // Build a map from lowercase highlight name to filename for quick lookup
  function getHighlightNameToFilenameMap() {
    const map = {};
    highlightsList.forEach(hl => {
      if (hl.name) map[hl.name.toLowerCase()] = hl.filename;
    });
    return map;
  }

  function highlightWordsInPreview() {
    if (!highlightsList || highlightsList.length === 0) return;
    // Sort highlight names by length descending to match longer names first
    const names = highlightsList.map(hl => hl.name).filter(n => n && n.trim());
    names.sort((a, b) => b.length - a.length);
    if (names.length === 0) return;

    const nameToFilename = getHighlightNameToFilenameMap();

    // Build a combined regex for all highlight names (case-insensitive)
    const escaped = names.map(n => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
    const combinedRegex = new RegExp(`(${escaped.join('|')})`, 'gi');

    // Walk text nodes in the preview, skip code/pre/mark elements
    const walker = document.createTreeWalker(preview, NodeFilter.SHOW_TEXT, null, false);
    const textNodes = [];
    let node;
    while ((node = walker.nextNode())) {
      textNodes.push(node);
    }

    textNodes.forEach(textNode => {
      if (!textNode.parentElement) return;
      const parent = textNode.parentElement;
      if (parent.closest('code, pre, mark, .mermaid')) return;

      const text = textNode.nodeValue;
      if (!combinedRegex.test(text)) return;
      combinedRegex.lastIndex = 0; // reset regex state

      // Split text by matches and create fragment
      const frag = document.createDocumentFragment();
      let lastIndex = 0;
      let match;
      combinedRegex.lastIndex = 0;
      while ((match = combinedRegex.exec(text)) !== null) {
        // Add text before match
        if (match.index > lastIndex) {
          frag.appendChild(document.createTextNode(text.substring(lastIndex, match.index)));
        }
        // Add highlighted mark with data attribute for tooltip
        const mark = document.createElement('mark');
        mark.className = 'highlight-mark';
        mark.textContent = match[0];
        const filename = nameToFilename[match[0].toLowerCase()];
        if (filename) {
          mark.dataset.highlightFilename = filename;
          // Use keyword color if highlight has keywords
          const firstKw = getFirstKeywordForHighlight(filename);
          if (firstKw) {
            const kwStyle = keywordStyleFor(firstKw);
            mark.style.background = kwStyle.background;
            mark.style.color = kwStyle.color;
          }
        }
        frag.appendChild(mark);
        lastIndex = combinedRegex.lastIndex;
      }
      // Add remaining text
      if (lastIndex < text.length) {
        frag.appendChild(document.createTextNode(text.substring(lastIndex)));
      }
      parent.replaceChild(frag, textNode);
    });
  }

  // --- Extract keywords from highlight content ---

  function extractKeywordsFromContent(content) {
    if (!content) return [];
    const re = /\u2021([\p{L}\p{N}_-]+)/gu;
    const set = new Set();
    let m;
    while ((m = re.exec(content)) !== null) {
      set.add(m[1]);
    }
    return Array.from(set);
  }

  // Get the first keyword for a highlight (by filename), or null
  function getFirstKeywordForHighlight(filename) {
    const content = highlightsContentCache[filename];
    if (!content) return null;
    const keywords = extractKeywordsFromContent(content);
    return keywords.length > 0 ? keywords[0] : null;
  }

  // Pre-fetch all highlight contents (for keyword extraction and tooltips)
  async function prefetchAllHighlightContents() {
    if (!currentStoryId || highlightsList.length === 0) return;
    await Promise.all(highlightsList.map(async (hl) => {
      if (highlightsContentCache[hl.filename] !== undefined) return;
      try {
        const res = await api(`/api/story/${currentStoryId}/highlights/${hl.filename}`);
        highlightsContentCache[hl.filename] = res.content || '';
      } catch (e) {
        highlightsContentCache[hl.filename] = '';
      }
    }));
  }

  // --- Highlight hover tooltip ---

  const highlightTooltip = $('highlight-tooltip');
  const highlightTooltipText = $('highlight-tooltip-text');
  const highlightTooltipImg = $('highlight-tooltip-img');
  const highlightsContentCache = {};

  function extractHighlightPreview(content) {
    // Extract first ~3 lines of plain text (strip markdown syntax)
    const lines = (content || '').split('\n').filter(l => l.trim());
    let textLines = [];
    let firstImage = null;

    for (const line of lines) {
      // Check for image
      const imgMatch = line.match(/!\[([^\]]*)\]\(([^)]+)\)/);
      if (imgMatch && !firstImage) {
        firstImage = imgMatch[2];
        continue; // don't include image markdown in text preview
      }
      if (textLines.length < 3) {
        // Strip basic markdown formatting
        let clean = line
          .replace(/^#{1,6}\s+/, '') // headings
          .replace(/\*\*([^*]+)\*\*/g, '$1') // bold
          .replace(/\*([^*]+)\*/g, '$1') // italic
          .replace(/__([^_]+)__/g, '$1') // bold
          .replace(/_([^_]+)_/g, '$1') // italic
          .replace(/`([^`]+)`/g, '$1') // inline code
          .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1') // links
          .replace(/^[-*+]\s+/, '') // list items
          .replace(/^\d+\.\s+/, ''); // numbered list
        if (clean.trim()) textLines.push(clean.trim());
      }
      if (textLines.length >= 3 && firstImage) break;
    }

    // Also scan remaining lines for first image if not found yet
    if (!firstImage) {
      for (const line of lines) {
        const imgMatch = line.match(/!\[([^\]]*)\]\(([^)]+)\)/);
        if (imgMatch) {
          firstImage = imgMatch[2];
          break;
        }
      }
    }

    return {
      text: textLines.join('\n') || '(empty)',
      image: firstImage
    };
  }

  async function fetchHighlightContent(filename) {
    if (highlightsContentCache[filename] !== undefined) {
      return highlightsContentCache[filename];
    }
    if (!currentStoryId) return '';
    try {
      const res = await api(`/api/story/${currentStoryId}/highlights/${filename}`);
      const content = res.content || '';
      highlightsContentCache[filename] = content;
      return content;
    } catch (e) {
      highlightsContentCache[filename] = '';
      return '';
    }
  }

  function showHighlightTooltip(mark, x, y) {
    const filename = mark.dataset.highlightFilename;
    if (!filename) return;

    // Position tooltip near the cursor
    const tooltipX = Math.min(x + 12, window.innerWidth - 320);
    const tooltipY = Math.min(y + 16, window.innerHeight - 200);
    highlightTooltip.style.left = tooltipX + 'px';
    highlightTooltip.style.top = tooltipY + 'px';

    // Show loading state
    highlightTooltipText.textContent = '...';
    highlightTooltipImg.style.display = 'none';
    highlightTooltip.style.display = '';

    // Fetch and display content
    fetchHighlightContent(filename).then(content => {
      // Check if tooltip is still visible (user might have moved away)
      if (highlightTooltip.style.display === 'none') return;

      const { text, image } = extractHighlightPreview(content);
      highlightTooltipText.textContent = text;

      if (image) {
        highlightTooltipImg.src = image;
        highlightTooltipImg.style.display = '';
      } else {
        highlightTooltipImg.style.display = 'none';
      }
    });
  }

  function hideHighlightTooltip() {
    highlightTooltip.style.display = 'none';
    highlightTooltipImg.src = '';
  }

  // Event delegation for highlight mark hover
  preview.addEventListener('mouseenter', (ev) => {
    const mark = ev.target.closest('.highlight-mark');
    if (!mark || !mark.dataset.highlightFilename) return;
    const rect = mark.getBoundingClientRect();
    showHighlightTooltip(mark, rect.left, rect.bottom);
  }, true);

  preview.addEventListener('mouseleave', (ev) => {
    const mark = ev.target.closest('.highlight-mark');
    if (!mark) return;
    // Check if we're leaving the mark element
    const related = ev.relatedTarget;
    if (related && mark.contains(related)) return;
    hideHighlightTooltip();
  }, true);

  // Also hide tooltip on scroll
  preview.addEventListener('scroll', hideHighlightTooltip);

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
    // Apply keyword pill rendering and highlight word marking after rendering
    renderKeywordsInPreview();
    if (highlightsRenderEnabled) {
      highlightWordsInPreview();
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
    await prefetchAllHighlightContents();
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

  // Count occurrences of a highlight name across all tiles
  function countHighlightOccurrences(name) {
    if (!name) return 0;
    const fullText = tilesOrder.map(f => tilesCache[f] || '').join('\n\n');
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const regex = new RegExp(escaped, 'gi');
    const matches = fullText.match(regex);
    return matches ? matches.length : 0;
  }

  // Get sorted highlights list based on current sort mode
  function getSortedHighlights() {
    const items = highlightsList.map(hl => ({
      ...hl,
      count: countHighlightOccurrences(hl.name)
    }));

    // If bubble keyword is active, partition by keyword membership
    if (highlightsBubbleKeyword) {
      const withKw = [];
      const withoutKw = [];
      items.forEach(hl => {
        const content = highlightsContentCache[hl.filename] || '';
        const keywords = extractKeywordsFromContent(content);
        if (keywords.some(k => k.toLowerCase() === highlightsBubbleKeyword.toLowerCase())) {
          withKw.push(hl);
        } else {
          withoutKw.push(hl);
        }
      });
      withKw.sort((a, b) => a.name.localeCompare(b.name));
      withoutKw.sort((a, b) => a.name.localeCompare(b.name));
      return [...withKw, ...withoutKw];
    }

    if (highlightsSortMode === 'most') {
      items.sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
    } else if (highlightsSortMode === 'least') {
      items.sort((a, b) => a.count - b.count || a.name.localeCompare(b.name));
    } else {
      // 'alpha' — default
      items.sort((a, b) => a.name.localeCompare(b.name));
    }
    return items;
  }

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
    const sorted = getSortedHighlights();
    sorted.forEach(hl => {
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

    // Keyword pills from highlight content (clickable for bubble-to-top)
    const hlContent = highlightsContentCache[hl.filename] || '';
    const keywords = extractKeywordsFromContent(hlContent);
    if (keywords.length > 0) {
      const kwContainer = document.createElement('span');
      kwContainer.className = 'highlight-keywords';
      keywords.forEach(kw => {
        const pill = document.createElement('span');
        pill.className = 'keyword-pill';
        pill.textContent = kw;
        pill.style.cursor = 'pointer';
        const style = keywordStyleFor(kw);
        pill.style.background = style.background;
        pill.style.color = style.color;
        pill.addEventListener('click', (ev) => {
          ev.stopPropagation();
          highlightsBubbleKeyword = kw;
          if (highlightsSortEl) highlightsSortEl.value = '';
          loadHighlightsList();
        });
        kwContainer.appendChild(pill);
      });
      li.appendChild(kwContainer);
    }

    // Occurrence count badge
    const countSpan = document.createElement('span');
    countSpan.className = 'highlight-count';
    const count = typeof hl.count === 'number' ? hl.count : countHighlightOccurrences(hl.name);
    countSpan.textContent = count;
    countSpan.title = `${count} occurrence${count !== 1 ? 's' : ''} in tiles`;
    li.appendChild(countSpan);

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
      // Update tooltip cache with fresh content
      highlightsContentCache[filename] = res.content || '';
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

    // Update cache and refresh highlights counts when editing tiles
    if (editMode === 'tile' && currentTileFilename) {
      tilesCache[currentTileFilename] = text;
      loadHighlightsList();
    }

    // Update tooltip cache when editing a highlight and refresh menu (keywords may change)
    if (editMode === 'highlight' && currentHighlightFilename) {
      highlightsContentCache[currentHighlightFilename] = text;
      loadHighlightsList();
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

  // Highlights sort selector
  if (highlightsSortEl) {
    highlightsSortEl.addEventListener('change', () => {
      highlightsSortMode = highlightsSortEl.value || 'alpha';
      highlightsBubbleKeyword = null; // clear bubble when user picks a sort
      loadHighlightsList();
    });
  }

  // Highlights render toggle (button)
  if (toggleHighlightsEl) {
    toggleHighlightsEl.addEventListener('click', () => {
      highlightsRenderEnabled = !highlightsRenderEnabled;
      toggleHighlightsEl.textContent = highlightsRenderEnabled ? 'Highlights \u2713' : 'Highlights \u2717';
      toggleHighlightsEl.style.background = highlightsRenderEnabled ? '#e3ecff' : '#f5f5f5';
      toggleHighlightsEl.style.color = highlightsRenderEnabled ? '#2b7cff' : '#888';
      renderPreview();
    });
  }

  // --- Context menu ---

  const contextMenu = $('context-menu');

  function showContextMenu(x, y) {
    contextMenu.style.display = 'block';
    // Ensure menu stays within viewport
    const menuRect = contextMenu.getBoundingClientRect();
    const maxX = window.innerWidth - menuRect.width - 4;
    const maxY = window.innerHeight - menuRect.height - 4;
    contextMenu.style.left = Math.min(x, maxX) + 'px';
    contextMenu.style.top = Math.min(y, maxY) + 'px';
  }

  function hideContextMenu() {
    contextMenu.style.display = 'none';
  }

  editor.addEventListener('contextmenu', (ev) => {
    if (editor.disabled) return; // don't show if no file open
    ev.preventDefault();
    // Enable/disable menu items based on selection
    const hasSelection = editor.selectionStart !== editor.selectionEnd;
    contextMenu.querySelectorAll('li').forEach(li => {
      const action = li.dataset.action;
      if (action === 'insert-table' || action === 'insert-picture') {
        li.classList.toggle('disabled', hasSelection);
      } else if (action === 'insert-link' || action === 'create-highlight') {
        li.classList.toggle('disabled', !hasSelection);
      }
      // insert-keyword is always enabled
    });
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
    const li = ev.target.closest('li');
    if (!li) return;
    if (li.classList.contains('disabled')) return; // don't act on disabled items
    const action = li.dataset.action;
    if (!action) return;
    hideContextMenu();

    if (action === 'insert-table') {
      insertTable();
    } else if (action === 'insert-link') {
      insertLink();
    } else if (action === 'insert-picture') {
      insertPicture();
    } else if (action === 'insert-keyword') {
      insertKeyword();
    } else if (action === 'create-highlight') {
      createHighlightFromSelection();
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

  // --- Insert Keyword ---

  function insertKeyword() {
    const hasSelection = editor.selectionStart !== editor.selectionEnd;

    if (hasSelection) {
      // Insert ‡ before the selected text
      const pos = editor.selectionStart;
      const before = editor.value.substring(0, pos);
      const after = editor.value.substring(pos);
      editor.value = before + '\u2021' + after;

      // Place cursor after the ‡ and before the original selection
      const newPos = pos + 1;
      editor.selectionStart = newPos;
      editor.selectionEnd = newPos + (editor.selectionEnd - editor.selectionStart);
    } else {
      // Ask for text, then insert ‡ + text at cursor
      const keyword = prompt('Keyword text:');
      if (!keyword) return;
      const pos = editor.selectionStart;
      const before = editor.value.substring(0, pos);
      const after = editor.value.substring(pos);
      const insertion = '\u2021' + keyword;
      editor.value = before + insertion + after;

      const newPos = pos + insertion.length;
      editor.selectionStart = newPos;
      editor.selectionEnd = newPos;
    }

    editor.dispatchEvent(new Event('input'));
    editor.focus();
  }

  // --- Create Highlight from selection ---

  async function createHighlightFromSelection() {
    if (!currentStoryId) return;
    const selectedText = editor.value.substring(editor.selectionStart, editor.selectionEnd);
    const name = selectedText.trim() || 'New Highlight';

    try {
      // Create highlight with a sanitized name based on selected text
      const res = await api(`/api/story/${currentStoryId}/highlights`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({})
      });
      if (res && res.filename) {
        // Rename it to the selected text
        const renameRes = await api(`/api/story/${currentStoryId}/highlights/${res.filename}/rename`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name })
        });
        const finalFilename = (renameRes && renameRes.filename) ? renameRes.filename : res.filename;
        await fetchHighlightsList();
        loadHighlightsList();
        openHighlight(finalFilename);
      }
    } catch (e) {
      console.error('create highlight from selection failed', e);
      alert('Failed to create highlight');
    }
  }

  // --- Insert Link ---

  function insertLink() {
    // Use selected text as the link text (read-only — user only provides URL)
    const selectedText = editor.value.substring(editor.selectionStart, editor.selectionEnd);
    const linkText = selectedText || '';
    if (!linkText) return; // should not happen since menu item is disabled without selection
    const linkUrl = prompt(`URL for "${linkText}":`, 'https://');
    if (!linkUrl) return;

    const md = `[${linkText}](${linkUrl})`;
    // Replace selection with the link
    const start = editor.selectionStart;
    const end = editor.selectionEnd;
    const before = editor.value.substring(0, start);
    const after = editor.value.substring(end);
    editor.value = before + md + after;

    const newPos = start + md.length;
    editor.selectionStart = newPos;
    editor.selectionEnd = newPos;

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

  // --- Speech to text ---

  const btnMic = $('btn-mic');
  const speechLangEl = $('speech-lang');
  const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  let speechRecognition = null;
  let speechActive = false;
  let speechGhostStart = null; // cursor position where ghost text starts
  let speechGhostLen = 0; // length of current ghost (interim) text

  // Disable if not supported
  if (!SpeechRecognition) {
    if (btnMic) btnMic.disabled = true;
    if (speechLangEl) speechLangEl.disabled = true;
  }

  function speechInsertText(text, isFinal) {
    if (!editor || editor.disabled) return;

    // Remove previous ghost text if any
    if (speechGhostStart !== null && speechGhostLen > 0) {
      const val = editor.value;
      editor.value = val.substring(0, speechGhostStart) + val.substring(speechGhostStart + speechGhostLen);
      editor.selectionStart = speechGhostStart;
      editor.selectionEnd = speechGhostStart;
      speechGhostLen = 0;
    }

    if (!text) return;

    const pos = speechGhostStart !== null ? speechGhostStart : editor.selectionStart;
    const before = editor.value.substring(0, pos);
    const after = editor.value.substring(pos);
    editor.value = before + text + after;

    if (isFinal) {
      // Move cursor after the inserted text
      const newPos = pos + text.length;
      editor.selectionStart = newPos;
      editor.selectionEnd = newPos;
      speechGhostStart = null;
      speechGhostLen = 0;
      // Trigger input event for autosave/preview
      editor.dispatchEvent(new Event('input'));
    } else {
      // Ghost text: keep track of position and length
      speechGhostStart = pos;
      speechGhostLen = text.length;
      // Place cursor at end of ghost for visual feedback
      editor.selectionStart = pos + text.length;
      editor.selectionEnd = pos + text.length;
    }
  }

  function startSpeech() {
    if (!SpeechRecognition || speechActive) return;
    speechRecognition = new SpeechRecognition();
    speechRecognition.lang = speechLangEl ? speechLangEl.value : 'en-US';
    speechRecognition.continuous = true;
    speechRecognition.interimResults = true;

    // Save cursor position for ghost insertion
    speechGhostStart = editor.selectionStart;
    speechGhostLen = 0;

    speechRecognition.onresult = (event) => {
      let interimTranscript = '';
      let finalTranscript = '';

      for (let i = event.resultIndex; i < event.results.length; i++) {
        const transcript = event.results[i][0].transcript;
        if (event.results[i].isFinal) {
          finalTranscript += transcript;
        } else {
          interimTranscript += transcript;
        }
      }

      if (finalTranscript) {
        speechInsertText(finalTranscript, true);
        // Update ghost start for next phrase
        speechGhostStart = editor.selectionStart;
        speechGhostLen = 0;
      } else if (interimTranscript) {
        speechInsertText(interimTranscript, false);
      }
    };

    speechRecognition.onerror = (event) => {
      console.warn('Speech recognition error', event.error);
      if (event.error === 'not-allowed' || event.error === 'service-not-allowed') {
        stopSpeech();
      }
    };

    speechRecognition.onend = () => {
      // If still active (continuous mode may stop unexpectedly), restart
      if (speechActive) {
        try { speechRecognition.start(); } catch (e) { stopSpeech(); }
      }
    };

    try {
      speechRecognition.start();
      speechActive = true;
      if (btnMic) btnMic.classList.add('active');
    } catch (e) {
      console.error('Failed to start speech recognition', e);
    }
  }

  function stopSpeech() {
    speechActive = false;
    if (speechRecognition) {
      try { speechRecognition.stop(); } catch (e) {}
      speechRecognition = null;
    }
    if (btnMic) btnMic.classList.remove('active');
    // Clear any remaining ghost text
    if (speechGhostStart !== null && speechGhostLen > 0) {
      const val = editor.value;
      editor.value = val.substring(0, speechGhostStart) + val.substring(speechGhostStart + speechGhostLen);
      editor.selectionStart = speechGhostStart;
      editor.selectionEnd = speechGhostStart;
    }
    speechGhostStart = null;
    speechGhostLen = 0;
  }

  if (btnMic && SpeechRecognition) {
    btnMic.addEventListener('click', () => {
      if (speechActive) {
        stopSpeech();
      } else {
        startSpeech();
      }
    });
  }

  // --- Initial load ---
  showStoryList();
  loadList();

  // Expose for debugging
  window._neo = { loadList, openTile, openHighlight, saveCurrent, renderPreview, showBinder, showStoryList };
})();

# Neo Writer

A distraction-free markdown writing tool with story management, tiles, highlights, keywords, and speech-to-text.

## Features

- **Stories & Tiles** — Organize your writing into stories, each containing multiple tiles (chapters/sections) that can be reordered via drag-and-drop
- **Markdown editing** — Full markdown support with live preview (headings, bold/italic, links, images, tables, code blocks, task lists, mermaid diagrams)
- **Highlights** — Create character/concept sheets linked to your story; highlight names appear colored in the rendered text with hover tooltips
- **Keywords** — Tag highlights with `‡keyword` markers; keywords render as colored pills and determine highlight colors in the preview
- **Speech-to-text** — Dictate text using the browser's SpeechRecognition API with real-time ghost preview and multi-language support
- **Context menu** — Right-click to insert tables, links, pictures, keywords, or create highlights from selected text
- **Auto-save** — All changes are saved automatically as you type
- **Arrow replacement** — `-->`, `<--`, `<-->` are rendered as → ← ↔
- **Dialogue formatting** — Lines starting with `- ` are rendered as em-dash dialogue

## Running

The recommended way to run Neo Writer is via Docker Compose:

```bash
docker compose up -d
```

Then open [http://localhost:3007](http://localhost:3007) in your browser.

Data is persisted in the `./data` directory (mounted as a volume).

## Current limitations

- **Local mode only** — Neo Writer currently runs in local/single-user mode. Multi-user hosted mode is on the TODO list.
- **No mobile layout** — The UI is designed for desktop browsers. A responsive mobile mode is planned but not yet implemented.

## Project layout

```
server.js          — Express backend (APIs + static file serving)
public/
  index.html       — Main HTML page
  app.js           — Client-side application logic
  style.css        — Styles
docker-compose.yml — Docker Compose configuration
Dockerfile         — Container build instructions
data/              — Created at runtime; stores stories, tiles, highlights, pictures
```

## Markdown support

Rendering is handled client-side using the [marked](https://github.com/markedjs/marked) library:

- Headings (`#`, `##`, `###`, etc.)
- Emphasis (`*italic*`, `**bold**`, `***bold italic***`)
- Blockquotes (`> quoted text`)
- Lists (unordered, ordered, nested, task lists)
- Code (inline and fenced blocks with language hinting)
- Tables (GitHub-style)
- Links and images
- Horizontal rules
- Mermaid diagrams (fenced `mermaid` code blocks)

## License

See [LICENSE](LICENSE).
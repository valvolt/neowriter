Neo Writer — Supported Markdown Features

Neo Writer is a minimal live markdown editor and renderer. The render pane uses the marked library to convert Markdown to HTML. The following markdown features are supported (via marked):

- Headings: #, ## ###, etc.
- Emphasis: *italic*, **bold**, ***bold italic***
- Blockquotes: > quoted text
- Lists:
  - Unordered lists using -, *, +
  - Ordered lists using 1., 2., 3.
  - Nested lists
- Code:
  - Inline code with backticks:code`
  - Fenced code blocks with language hinting:
    ```js
    console.log("hello");
    ```
- Horizontal rules: --- or- Links: [text](https://example.com)
- Images: ![alt](https://example.com/img.png)
- Tables: basic GitHub-style tables
- Line breaks and paragraphs

Notes and limitations:
- Rendering is handled client-side using the marked library loaded from CDN.
- Syntax highlighting is not bundled by default (can be added later with highlight.js or prism).
- The preview aims to scroll proportionally with the editor, but exact syncing for complex content may vary.
- Files are saved on the server as UTF-8 .md files and metadata is stored in data/metadata.json.

Running locally:
1. cd writer_v2
2. npm install
3. npm start
Then open http://localhost:3000 in your browser.

Project layout:
- server.js — Express backend serving APIs and static files
- public/ — frontend static files (index.html, app.js, style.css)
- data/ — created at runtime; contains UUID.md files and metadata.json
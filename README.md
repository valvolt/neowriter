# Neo Writer

A distraction-free markdown writing tool with story management, tiles, highlights, keywords, and speech-to-text.

## Test it online
Open [https://46.225.219.90.sslip.io/](https://46.225.219.90.sslip.io/) on your browser.

Browse published stories or create your account to add yours.

I will turn off the registration option if I see abuse.

## Features

- **Stories & Tiles** — Organize your writing into stories, each containing multiple tiles (chapters/sections) that can be reordered via drag-and-drop
- **Markdown editing** — Full markdown support with live preview (headings, bold/italic, links, images, tables, code blocks, task lists, mermaid diagrams)
- **Highlights** — Create character/concept sheets linked to your story; highlight names appear colored in the rendered text with hover tooltips
- **Keywords** — Tag highlights with `‡keyword` markers; keywords render as colored pills and determine highlight colors in the preview
- **Story list** — Published stories are sorted to the top with a green indicator; keyword pills from tiles appear next to each story name so you can see at a glance which stories are sci-fi, romance, etc.
- **Speech-to-text** — Dictate text using the browser's SpeechRecognition API with real-time ghost preview and multi-language support
- **Context menu** — Right-click to insert tables, links, pictures, keywords, or create highlights from selected text
- **Content sync** — Double click anywhere on your text to auto-scroll the rendering page to your current location
- **TODO-list** — All ☐ and ☑ spread through story tiles are collected in a single, editable TODO list
- **Auto-save** — All changes are saved automatically as you type
- **Export** — Download any story as a ZIP archive containing tiles, highlights, and pictures
- **Import** — Upload a ZIP to create a new story or append tiles/highlights/pictures into an existing one
- **Publishing** — Make your stories publicly readable via a shareable URL
- **Mobile** — Responsive layout with bottom tab navigation for phones (≤ 600 px)

## Running locally

The recommended way to run Neo Writer is via Docker Compose:

```bash
docker compose up -d
```

Then open [http://localhost:3007](http://localhost:3007) in your browser.

Data is persisted in the `./data` directory (mounted as a volume).

## Hosting it

Neowriter has user management: each user can access their own stories. To host it, you will have to setup an account and a 'regular web application / express' application on https://auth0.com/

Rename .env.template into .env and copy/paste the provided variables there

Then run the application as mentioned in the 'running locally' section

## Deploying with HTTPS

Use the included Caddy reverse proxy configuration, which handles TLS certificates automatically via Let's Encrypt:

```bash
docker compose -f docker-compose.https.yml up -d
```

Edit `Caddyfile` and replace `yourdomain.com` with your actual domain or hostname before starting.

**No domain?** Use [sslip.io](https://sslip.io) — a free DNS service that maps `<ip>.sslip.io` to your IP. If your server is at `1.2.3.4`, set the Caddyfile hostname to `1.2.3.4.sslip.io` and you get a trusted Let's Encrypt certificate with no domain purchase.

> Ports 80 and 443 must be reachable from the internet (needed for Let's Encrypt's HTTP challenge). Also update your Auth0 application's allowed callback and logout URLs to use `https://`.

## Storage quota (HOSTED mode)

In HOSTED mode each user is limited to **50 MB** by default. Three levels of override, from broadest to narrowest:

1. **Server default** — `50 MB`. No configuration needed.
2. **`.env` override** — set `STORAGE_QUOTA_MB=200` to change the default for all users.
3. **Per-user override** — create or edit `data/_quota.json`:

```json
{
  "alice-example.com": 200,
  "bob-example.com": 10
}
```

Keys are the sanitized form of the user's email: `@` becomes `-`, everything is lowercased (e.g. `cedric.hebert@pm.me` → `cedric.hebert-pm.me`). Values are in MB. The file is re-read every 60 seconds — no restart needed. Missing entries fall back to the `.env` default.

The remaining quota is displayed next to the user's name in the header. Writes are blocked with HTTP 413 once the limit is reached.

## Project layout

```
server.js               — Express backend (APIs + static file serving)
public/
  index.html            — Main HTML page
  app.js                — Client-side application logic
  style.css             — Styles
docker-compose.yml      — Docker Compose (HTTP, port 3007)
docker-compose.https.yml — Docker Compose with Caddy (HTTPS)
Caddyfile               — Caddy reverse proxy config
Dockerfile              — Container build instructions
data/                   — Created at runtime; stores stories, tiles, highlights, pictures
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

## Specific rendering

- **Arrow replacement** — `-->`, `<--`, `<-->` are rendered as → ← ↔
- **Arrow replacement** — `==>`, `<==`, `<==>` are rendered as ⇒ ⇐ ⇔
- **Dialogue formatting** — Lines starting with `- ` are rendered as em-dash dialogue
- **Dice symbols**  — `[.]`, `[...]`, `[.....]` are rendered as ⚀ ⚂ ⚄
- **Dinkus**   — `***` is rendered as ✦ ✦ ✦
- **Emojis** — `:smile:` is rendered as 😄

## License

See [LICENSE](LICENSE).
# Features


## Header

The header is always visible. Its controls change depending on whether you are on the story list or inside a story.

**Breadcrumb path** — when a story is open, the left side of the header shows a path: **Story name › Tile name** (or Highlight name). Click the story name to rename the story; click the tile or highlight name to rename it. A prompt appears with the current name pre-filled.

**Filter** — the search bar filters in real time. On the story list it shows only matching stories; inside a story it shows only matching tiles and highlights, with matches highlighted in the panel.

**Publish** — appears when a story is open. Click to make the story publicly readable via a shareable URL (no login required). Click again to unpublish.

**Highlights** — toggles highlight colouring in the preview pane on and off. The button shows ✓ when colouring is active.

**Export ↓** — appears when a story is open. Opens a small dropdown:
* **Export .zip** — downloads all tiles, highlights, and pictures as a ZIP archive (useful as a backup or to move a story to another instance)
* **Export PDF** — opens the browser print dialog; choose "Save as PDF" to get a formatted document

**🌙 / ☀️** — switches between dark and light mode. Your preference is saved and restored automatically.

**🎤** — available in Chrome: click to start dictating into the editor. Interim text appears as ghost text; the transcript is inserted when you pause. Use the language selector next to the button to change the dictation language.

**User name / quota** — on hosted instances, shows your username and storage used (e.g. `1.2 / 50 MB`). The colour turns orange near the limit and red above 90 %. Writes are blocked once the limit is reached; export and delete old stories to free space.


## Left panel — story list

The left panel opens on the story list when you first arrive.

* **New** — creates a new story
* **Import** — creates a new story from a ZIP file exported by Neowriter (or a compatible ZIP with the same folder structure)
* **← Published** — appears on hosted instances; shows all publicly published stories

Each story row shows:
* A green indicator in front of published stories
* Keyword pills for any ‡tags defined in the story's tiles
* Published stories sort to the top; within each group, stories are alphabetical

**Global todo** — the "Todo" row at the top of the panel shows the total number of open checkboxes across all stories. Click it to jump to the first story that has unchecked todos.


## Left panel — binder

Opening a story replaces the story list with the binder.

* **← Back** — returns to the story list
* **Import ↑** — appends tiles and highlights from a ZIP into the current story; pictures are merged, tile order is preserved

**Tiles section**
* Click a tile to open it in the editor
* **+** adds a new tile at the end
* Drag tiles to reorder them
* To rename a tile, open it and click its name in the header breadcrumb

**Highlights section**
* Click a highlight to open it
* **+** adds a new highlight
* The sort dropdown cycles between: alphabetical (A→Z), most occurrences, least occurrences
* Each highlight row shows an occurrence count (how many times its name appears across all tiles)
* Keyword pills (‡tags defined inside the highlight) appear next to its name; click a pill to group all highlights sharing that tag at the top
* To rename a highlight, open it and click its name in the header breadcrumb — every occurrence in every tile is updated automatically

**Todo section**
* Shows unchecked / total checkboxes for the open story
* Click a tile name next to a todo to jump to that tile in the editor
* Click a checkbox directly in the panel to toggle it without opening the tile

**Keyboard navigation between tiles and highlights**

| Keys | Action |
|---|---|
| Alt + ↓ or Ctrl + ] | Next tile or highlight |
| Alt + ↑ or Ctrl + [ | Previous tile or highlight |

Navigation runs in a loop: after the last tile comes the first highlight; after the last highlight comes the first tile (and vice versa going backwards). Highlight order follows the active sort.


## Editor

The editor is a plain-text area in the centre of the screen.

* **Right-click** anywhere in the editor to insert a table, a picture, or a ‡keyword tag
* **Double-click** in the editor to scroll the preview to the same position
* Changes are saved automatically

The right-click menu also inserts pictures inline as markdown image syntax. You can paste an image directly from the clipboard; a dialog asks for a name.


## Preview

The preview on the right renders the current tile as formatted text.

* **Double-click** anywhere in the preview to jump to that tile in the editor
* When highlight colouring is on, every highlight name in the text is marked in its assigned colour; hover over a marked word to see the first lines of that highlight (and its picture, if any)


## Footer

The footer spans the bottom of the screen and always shows stats for the current tile and story.

**Left — word goal**
* Click **✏ Goal: —** to set a target word count; type a number and press Enter
* The label updates to show your total and progress, e.g. `✏ Goal: 5 000 (73 %)`
* A thin colour bar along the very bottom fills as you write: blue → amber (≥ 50 %) → light green (≥ 75 %) → green (≥ 100 %)
* Click the label again to change or clear the goal

**Centre — stats**
* **Words / Chars** — current tile, then total across all tiles
* **Pages** — estimated at 1 page per 300 words (≈ 1 minute read)

**Right** — name of the currently open tile or highlight.


## Mobile

On small screens (≤ 600 px) the layout switches to a bottom tab bar:

| Tab | Shows |
|---|---|
| Files | Left panel (story list or binder) |
| Write | Editor |
| Preview | Preview pane |

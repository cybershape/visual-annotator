# Visual Annotator

Chrome extension to annotate any web page and copy structured markdown — built for AI coding agents.

Annotate elements, capture screenshots, copy browser console logs, and paste everything into your agent of choice. The output is optimized for AI consumption: structured markdown with selectors, bounding boxes, computed styles, and file paths to screenshots.

**One-click console capture** — all `console.log`, `console.warn`, `console.error`, and unhandled exceptions are recorded in the background. Click the terminal icon in the toolbar to copy them as formatted markdown. A red dot on the icon alerts you when errors have occurred.

### Works with

**Markdown + Screenshots** — agents with local file system access can read the saved screenshot files directly:

| Agent | How |
|-------|-----|
| **[Claude Code CLI](https://code.claude.com/docs/en/quickstart)** | Paste markdown + screenshot paths into the CLI prompt |
| **[Claude Code VS Code](https://marketplace.visualstudio.com/items?itemName=anthropic.claude-code)** | Paste into Claude Code chat panel |
| **[Cursor](https://cursor.com)** | Paste into chat or Cmd+K inline edit |
| **[Windsurf](https://windsurf.com)** | Paste into Cascade chat |
| **[Cline](https://cline.bot)** | Paste into chat panel in VS Code |
| **[Aider](https://github.com/Aider-AI/aider)** | Paste into CLI prompt |
| **[GitHub Copilot](https://github.com/features/copilot)** | Paste into Copilot Chat in VS Code |
| **[Pi](https://github.com/badlogic/pi-mono)** | Paste into CLI prompt |
| **[OpenCode](https://github.com/anomalyco/opencode)** | Paste into CLI prompt |
| **[Gemini CLI](https://geminicli.com)** | Paste into CLI prompt |
| **[Google Antigravity](https://antigravity.google)** | Paste into conversation |

**Markdown only** — web-based agents without file system access get the full structured markdown (selectors, styles, bounding boxes), but cannot load the screenshot files:

| Agent | How |
|-------|-----|
| **ChatGPT** | Paste into conversation |
| **[Gemini](https://gemini.google.com)** | Paste into conversation |
| Any other agent | If it reads markdown, it works |

No backend. No framework dependency. Works on every website.

## Demo

https://github.com/user-attachments/assets/c954c6cb-d978-4980-a194-51a8702903c3

## Install

### Mac

1. Download or clone this repository
2. Open Chrome and go to `chrome://extensions`
3. Enable **Developer mode** (toggle in the top right corner)
4. Click **Load unpacked**
5. In the file dialog, navigate to the downloaded `visual-annotator` folder and select it
6. The extension icon appears in your toolbar — click the puzzle piece icon and pin **Visual Annotator** for quick access

### Windows

1. Download or clone this repository
2. Open Chrome and type `chrome://extensions` in the address bar
3. Enable **Developer mode** (toggle in the top right corner)
4. Click **Load unpacked**
5. Browse to the downloaded `visual-annotator` folder and select it
6. The extension icon appears in your toolbar — click the puzzle piece icon and pin **Visual Annotator** for quick access

### Updating

To update after pulling new changes:

1. Go to `chrome://extensions`
2. Find **Visual Annotator** and click the reload icon (circular arrow)

## Usage

1. **Start selecting** — Click the extension icon or press `Cmd+Shift+.` (Mac) / `Ctrl+Shift+.` (Windows/Linux), then click an element on the page
2. **Comment** — Optionally describe the issue or desired change in the annotation popup
3. **Copy & Exit** — Copy the current batch as markdown, clear its page markers, and exit selection mode; use the camera version to include a screenshot
4. **Copy & Next** — Copy the current batch and continue selecting elements; numbered markers let you edit annotations already in the batch
5. **Start a new batch** — After Copy & Next, uncheck **Add to existing annotations** in the next popup to replace the batch, when this option is available
6. **Paste** — Into any AI agent prompt
7. **Exit selecting** — Click the extension icon again, use the shortcut, or press `Escape` when no annotation popup is open

## Extension Icon

The browser extension icon is the entry point; no floating toolbar is added to the page. Pin the extension for quick access.

| Badge | Meaning |
|-------|---------|
| Purple `ON` | Selection mode is active with no annotations |
| Purple number | Selection mode is active; the number is the annotation count |
| Gray number | Selection mode is off; the current batch is retained |
| No badge | Selection mode is off with no annotations |

Hover over the extension icon to see its current state. Badge state is specific to each tab and resets when the page reloads.

## Element Picker

When annotation mode is active:

- **Hover** elements to see a highlight and tooltip with tag, classes, dimensions
- **Alt/Option + Scroll** to cycle through parent elements
- **Click** to select an element and open the comment popup
- **Click a numbered marker** to edit an existing annotation
- **Escape** to exit annotation mode

## Copy Intent

The **Copy** intent lets you grab the full HTML DOM of any element on the page. This is useful when you want an AI agent to understand the exact markup structure — for example to replicate a component, refactor HTML, or debug rendering issues.

When you select "Copy" as the intent, a checkbox appears: **Include full HTML DOM of element** (checked by default). The complete `outerHTML` of the selected element is then included in the markdown output as a fenced code block.

```markdown
## 1. `div.card` [copy · important]

- **Comment:** Replicate this card component
- **HTML:**
```html
<div class="card">
  <h2>Title</h2>
  <p>Content with <a href="#">links</a></p>
</div>
```

---
```

## Markdown Output

The copy button generates markdown like this:

```markdown
# Visual Feedback — My App
**URL:** https://myapp.com/dashboard
**Viewport:** 1440x900
**Date:** 2025-01-15T10:30:00.000Z

---

## 1. `button.btn-primary` [fix · important]

- **Comment:** The button should use the design system blue (#3B82F6), not green.
- **URL:** https://myapp.com/dashboard
- **Element:** `<button class="btn-primary">`
- **Selector:** `main > div > button.btn-primary`
- **Text:** "Submit Form"
- **Bounding Box:** 120x40 at (350, 680)
- **Styles:** display: flex, backgroundColor: rgb(34, 197, 94)
- **Screenshot:** ![screenshot-1](/Users/.../Downloads/visual-annotator/myapp-com-dashboard-1743564000000.png)

---
```

## Console Output

The console button generates markdown like this:

```markdown
# Console Output — My App
**URL:** https://myapp.com/dashboard
**Messages:** 12 (2 errors, 1 warnings)

---

[ERROR] 10:30:15.123
Uncaught TypeError: Cannot read property 'foo' of undefined

[WARN] 10:30:16.456
Deprecation warning: componentWillMount has been renamed

[LOG] 10:30:17.789
App initialized
```

## Keyboard Shortcuts

The extension shortcut toggles selection mode. Popup shortcuts work while annotating.

| Shortcut | Action |
|----------|--------|
| `Cmd/Ctrl+Shift+.` | Start or exit element selection |
| `Cmd/Ctrl+Enter` | Copy and finish from the comment field |
| `Escape` | Close the popup first; press again to exit selection |

> **Tip:** By default the shortcut only works when Chrome is focused. To make it work globally (from any app), go to `chrome://extensions/shortcuts`, find **Visual Annotator** and change the scope from "In Chrome" to "Global".

## Screenshots

Screenshots are saved as PNG files to your Downloads folder under `visual-annotator/`:

- Regular sites: `{domain-and-path}-{timestamp}.png` (e.g. `flow-digitalsprung-de-home-1743564000000.png`)
- Localhost: `localhost-{port}-{path}-{timestamp}.png` (e.g. `localhost-3000-dashboard-1743564000000.png`)

## Privacy

- All data stays in your browser — no network requests, no tracking, no analytics
- Screenshots are captured locally via Chrome's `captureVisibleTab` API and saved to your Downloads folder
- Console logs are captured in-page — nothing is sent to any server

## Development

```bash
# Make changes to content.js, background.js, popup.js, or manifest.json
# Then reload the extension in chrome://extensions
```

No build step required. The extension is plain JavaScript.

## License

MIT

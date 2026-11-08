# Visual Annotator

A Chromium extension for annotating web page elements and sharing structured feedback with AI coding agents. Copy Markdown into your preferred tool, or submit annotations directly to an existing agent in Herdr.

Select an element, describe the change, and optionally capture a screenshot. Feedback includes a CSS selector, text, page URL, bounding box, selected computed styles, and screenshot paths when available. No build step or hosted backend is required.

## Features

- Select elements with a hover highlight and a tooltip showing their tag, classes, and dimensions.
- Use Alt/Option + scroll to move through ancestors, or use **Parent ↑** and **Previous ←** in the annotation popup.
- Annotate elements in native modal dialogs and popovers. The annotation UI uses the browser's top layer and follows modal dialog changes.
- Drag the popup by its header; its initial position tries to avoid covering the selected element.
- Collect multiple annotations in a batch and reopen them through numbered page markers.
- Copy the batch as Markdown, with optional screenshots cropped around the selected element.
- On macOS, send the batch directly to a selected local or remote Herdr agent, including screenshots transferred to that agent's machine.

Start selection from the pinned extension icon or its keyboard shortcut. Annotation controls appear after selecting an element.

## Demo

https://github.com/user-attachments/assets/c954c6cb-d978-4980-a194-51a8702903c3

The video may show an older interface; the controls described below reflect the current implementation.

## Install the extension

Use a Chromium-based browser such as Helium, Chrome, Edge, or Chromium. The extension can be loaded unpacked on macOS, Windows, or Linux; the optional Herdr bridge installer currently supports macOS only.

1. Download or clone this repository and keep it in a stable location.
2. Open your browser's extension management page, such as `chrome://extensions` in Chrome or Helium, or `edge://extensions` in Edge.
3. Enable **Developer mode** and choose **Load unpacked**.
4. Select this repository's directory, which contains `manifest.json`.
5. Pin **Visual Annotator** to the browser toolbar for quick access.

The browser restricts extensions on internal pages, extension stores, and some protected documents. Use a normal web page. For local `file://` pages, enable **Allow access to file URLs** in the extension's details if your browser provides that setting.

### Updating

After pulling changes, reload Visual Annotator from the browser's extension management page, then refresh the web pages you want to annotate. Existing page annotations are held in memory and are lost when a page reloads.

If the repository, Node installation, or Herdr executable paths move, rerun the bridge installer. If the unpacked extension ID changes, uninstall the old bridge registration with its old ID before registering the new one.

## Annotate and copy

1. Click the extension icon or press `Cmd+Shift+.` on macOS / `Ctrl+Shift+.` on Windows or Linux to start selection.
2. Hover over an element to inspect it. Hold Alt/Option while scrolling to cycle through its ancestors.
3. Click to open the annotation popup and enter a comment. **Parent ↑** selects the parent; **Previous ←** returns to the previous target. Switching targets clears the current screenshot so it can be captured for the new element.
4. Choose an action:

   | Action | Result |
   |--------|--------|
   | **Copy & Next** | Copy the current batch and continue selecting; keep the batch and its markers |
   | Camera **Copy & Next** | Capture the current element if needed, then copy and continue |
   | **Copy & Exit** | Copy the batch, clear its markers, and exit selection |
   | Camera **Copy & Exit** | Capture the current element if needed, then copy and exit |
   | **Cancel** or **×** | Close the popup without submitting the current edits |

5. Paste the Markdown into your agent or editor. Agents with access to the saved screenshot files can open those paths. Web chat tools generally need images attached separately.

Click a numbered marker to edit an annotation already in the batch. When the clipboard still contains the last export and annotations are retained, the next popup offers **Add to existing annotations**. Uncheck it to replace the batch on the next copy or send. This option depends on the browser allowing the clipboard read.

Press Escape to close the popup, then again to exit selection. Toggling selection off retains the submitted batch in memory and hides its markers; toggling it on restores them. Successful **Copy & Exit** or **Send & Exit** clears the batch. Reloading or leaving the page discards it.

### Extension badge

| Badge | Meaning |
|-------|---------|
| Purple `ON` | Selection is active, with no submitted annotations |
| Purple number | Selection is active; the number is the batch size |
| Gray number | Selection is off; the batch is retained |
| No badge | Selection is off, with no submitted annotations |

The badge is specific to each browser tab. Hover over the icon for its current state.

### Keyboard and mouse shortcuts

| Shortcut | Action |
|----------|--------|
| `Cmd/Ctrl+Shift+.` | Toggle element selection |
| Alt/Option + scroll | Cycle through the hovered element's ancestors |
| `Cmd/Ctrl+Enter` in the comment field | Run **Send & Exit** when **Send to Herdr** is checked; otherwise **Copy & Exit**, without taking a new screenshot |
| Escape | Close the popup first; otherwise exit selection |
| Drag popup header | Move the annotation popup |

Browser shortcuts can be reassigned from the browser's extension shortcut settings. The comment-field shortcut follows the current exit action.

## Send directly to Herdr

This optional integration submits the batch to an existing agent and presses Enter. It uses a local Native Messaging bridge, not the clipboard or whichever terminal happens to have focus. It does not create agents or change Herdr layouts.

### Set up the macOS bridge

Requires Node.js 18 or newer, `herdr-app`, and `hc` on your shell's `PATH`. The integration was developed against herdr-app 0.1.13 and hc 0.1.18, with `terminal.put` and `terminal.send` support. There are no npm dependencies to install.

1. Load the extension in your chosen browser and copy its actual **ID** from the extension management page.
2. From this repository, register that browser's bridge. For Helium:

   ```sh
   node native/install.cjs --browser helium --extension-id YOUR_EXTENSION_ID
   ```

3. Reload the extension and refresh the web page. A browser restart is normally unnecessary; if the host is still not found, fully quit and reopen the browser.
4. Keep Herdr running with an existing agent, open an annotation, and expand **Herdr Agents**.

Choose the browser explicitly with `--browser`:

| Value | macOS registration directory under `~/Library/Application Support/` |
|-------|------------------------------------------------------------------|
| `helium` | `net.imput.helium/NativeMessagingHosts/` |
| `chrome` (default) | `Google/Chrome/NativeMessagingHosts/` |
| `edge` | `Microsoft Edge/NativeMessagingHosts/` |
| `chromium` | `Chromium/NativeMessagingHosts/` |

The installer registers `com.visual_annotator.herdr` for exactly the supplied extension ID and records absolute Node, hc, and herdr-app paths. Each browser has its own launcher and configuration under `~/Library/Application Support/com.visual_annotator.herdr/<browser>/`. Installing or uninstalling one browser leaves the others in place. No administrator privileges or background HTTP service are required.

The browser launches the bridge on demand. The extension disconnects an idle connection after one minute. Keep the repository in place because the launcher references its `native/host.cjs`.

To uninstall, use the same browser and extension ID used for installation:

```sh
node native/install.cjs --browser helium --extension-id YOUR_EXTENSION_ID --uninstall
```

### Select an agent and send

1. Each annotation popup checks for Herdr agents. When agents are found, **Herdr Agents** expands and its **Send to Herdr** checkbox is selected by default. Without agents or a connected bridge, the popup keeps Copy mode. Use **Refresh** to update the list.
2. Choose a target. Entries show the machine, space, tab, agent program, working directory, status, and terminal address where available. The agent currently displayed in Herdr is selected by default when available. The last successfully used target is remembered as a fallback; refreshing preserves a target you already selected in the popup.
3. The **Send to Herdr** checkbox sits at the right of the **Herdr Agents** header. While **Send to Herdr** is checked, the two **Copy & Exit** buttons become **Send & Exit**: the camera version captures the current element if needed; the plain version does not take a new screenshot. Both send the batch and exit selection. Uncheck the checkbox to restore Copy. **Copy & Next** continues to copy. Screenshots already in the batch are included with either send button. Attachments upload first, then the batch is submitted once to the selected agent.

The list includes live agents associated with the connected Herdr window, including remote agents. Plain shells and exited terminals are excluded. Blocked agents cannot be selected, and the bridge checks the target again before upload and submission. It does not force input into a blocked agent or interrupt a working one.

For remote agents, screenshots are uploaded through herdr-core and the Markdown references paths on the target machine. Each image is limited to 8 MiB of decoded data. Uploaded files have the target terminal's lifetime; they are not permanent screenshot storage.

A successful response means the content was submitted to the terminal, not that the agent completed the task. A successful send clears the batch and exits selection.

### Connection and failure handling

- **Host not found or access denied:** check the browser parameter and its extension ID, then rerun the installer. Registrations are browser-specific.
- **Missing dependency:** make Node, hc, and herdr-app available on `PATH` when running the installer; it does not install them for you.
- **Empty agent list:** open an agent in Herdr and refresh. The bridge uses its inherited/default Herdr window and core session context; there is no window or session picker.
- **Target disappeared, blocked, or remote machine unavailable:** refresh the list or resolve the target's state, then retry.
- **Screenshot upload or submission failed:** comments, annotations, and screenshots remain available for retry or Copy.
- **Send result unknown:** inspect the selected agent before manually sending again. The current popup disables another Herdr send, and no submission is automatically retried. Request deduplication is limited to the current bridge process and does not guarantee exactly-once delivery across restarts.

## Markdown output

Both delivery methods use the same structured format. A single annotation omits a numbered heading; multiple annotations receive numbered headings. The output includes page title, URL, viewport and export time, followed by CSS selector, text, document coordinates, selected computed styles, optional screenshot path and user request. Shopify section metadata is included when detected.

Example for a single annotation:

```markdown
# Visual Feedback — My App
**URL:** http://localhost:3000/dashboard
**Viewport:** 1440×900
**Date:** 2026-11-08T10:30:00.000Z

---

- **Selector:** `#submit`
- **Text:** "Submit"
- **Bounding Box:** 120×40 at (350, 680)
- **Styles:** display: flex, backgroundColor: rgb(34, 197, 94)
- **Screenshot:** ![screenshot-1](/path/to/screenshot.png)
- **User Request:** Use the design system blue for this button.
```

Screenshot paths in Copy exports refer to locally downloaded files when available. Herdr exports substitute the paths returned by the target machine. Markdown is text; it does not embed image bytes.

## Screenshots

Screenshots capture the visible browser tab, then crop around the selected element with padding, bounded by the viewport. They do not capture the full scrollable page or portions of an element outside the viewport. Annotation highlights and markers are hidden during capture, and the popup is temporarily hidden.

- **Copy with screenshot:** saves a PNG under the browser's Downloads directory in `visual-annotator/`, using a sanitized site/path and timestamp. The resolved file path is included when available.
- **Send to Herdr:** uploads the image to the selected agent's machine without requiring a Downloads file. Previously captured screenshots in the batch can also be sent.
- Screenshots remain associated with their annotation and are reused unless the selected target changes or a new annotation is created.

## Privacy and permissions

There is no tracking, analytics, or hosted application backend.

- Annotations, comments, and screenshot data stay in page memory until exported, sent, or the page is unloaded. They are not restored after a reload.
- Copy uses the system clipboard; screenshot copies can also save local files. The popup may read clipboard text to decide whether to offer **Add to existing annotations**.
- **Send to Herdr** explicitly transfers the current batch and screenshots through the local bridge to the selected agent. Remote transfers use herdr-core's configured machine connection.
- The last successfully used Herdr terminal address is stored in browser extension local storage.

| Permission | Purpose |
|------------|---------|
| `activeTab`, `scripting` | Activate/inject the picker and capture the selected tab |
| `<all_urls>` host access | Make the content script available on supported web pages |
| `downloads` | Save screenshots used by Copy exports |
| `nativeMessaging` | Connect to the optional local Herdr bridge |
| `storage` | Remember the last successful Herdr target |

Only install a bridge from a source you trust: it runs locally with your user's access and communicates with Herdr. The provided host exposes fixed annotation operations rather than arbitrary shell commands.

## Development and verification

The extension is plain JavaScript with no build step. Main components:

| File | Responsibility |
|------|----------------|
| `content.js` | Element selection, top-layer UI, annotation batches, screenshot cropping, Markdown and Herdr panel |
| `background.js` | Browser action/badge, screenshot capture/download, Native Messaging connection and message validation |
| `manifest.json` | Extension entry points, permissions and selection shortcut |
| `native/host.cjs` | Native Messaging framing, agent discovery, attachment upload and core submission |
| `native/install.cjs` | Browser-specific macOS registration and scoped uninstall |

Run automated checks with Node.js 18 or newer:

```sh
node --test background.test.cjs native/host.test.cjs
node --check content.js
node --check background.js
node --check native/host.cjs
node --check native/install.cjs
git diff --check
```

Tests cover Native Messaging framing, core RPC via mock subprocesses, target validation, attachment limits, request caching, unknown submission results, background connection handling, and per-browser installation/uninstallation in temporary directories.

Runtime verification to date includes real hc handshake/health/agent discovery and browser UI tests with a simulated bridge, including native dialogs/popovers and screenshot path substitution. Actual browser-to-agent submission and remote screenshot delivery still require end-to-end verification; installer tests alone do not establish browser compatibility.

After code changes, reload the extension and refresh the target page. For manual checks, cover ordinary pages, native dialogs/popovers, batch editing, Copy, screenshot files, agent selection, failed sends and a test agent's receipt of submitted Markdown and readable attachments.

## License

MIT

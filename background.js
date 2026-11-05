/**
 * Visual Annotator — Background Service Worker
 *
 * Handles:
 * - Extension icon click → toggle element selection in active tab
 * - Keyboard shortcut → toggle element selection
 * - Screenshot capture requests from content script
 */

function isRestrictedUrl(url) {
  if (!url) return true;
  return /^(chrome|chrome-extension|edge|about|devtools|view-source):/.test(url);
}

async function toggleAnnotations(tab) {
  if (!tab?.id || isRestrictedUrl(tab.url)) {
    return;
  }

  // Ensure content script is injected
  try {
    await chrome.tabs.sendMessage(tab.id, { type: "PING" });
  } catch {
    try {
      await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        files: ["content.js"],
      });
      await new Promise((r) => setTimeout(r, 150));
    } catch (err) {
      console.error("[visual-annotator] Injection failed:", err.message);
      return;
    }
  }

  await chrome.tabs.sendMessage(tab.id, { type: "TOGGLE_ANNOTATING" }).catch(() => {});
}

async function updateActionState(tabId, active, count) {
  const text = count > 0 ? (count > 99 ? "99+" : String(count)) : (active ? "ON" : "");
  const state = active ? "Selecting elements — click to exit" : "Click to select an element";
  const title = `Visual Annotator — ${state}${count > 0 ? ` (${count} annotations)` : ""}`;
  await Promise.all([
    chrome.action.setBadgeText({ tabId, text }),
    chrome.action.setBadgeBackgroundColor({ tabId, color: active ? "#6366f1" : "#71717a" }),
    chrome.action.setBadgeTextColor({ tabId, color: "#ffffff" }),
    chrome.action.setTitle({ tabId, title }),
  ]).catch(() => {});
}

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status === "loading") updateActionState(tabId, false, 0);
});

// Extension icon click
chrome.action.onClicked.addListener((tab) => {
  toggleAnnotations(tab);
});

// Keyboard shortcut
chrome.commands.onCommand.addListener(async (command) => {
  if (command === "toggle-toolbar") {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab) toggleAnnotations(tab);
  }
});

// Messages from content script
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === "ANNOTATION_STATE" && sender.tab?.id && sender.frameId === 0) {
    updateActionState(sender.tab.id, msg.active === true, Math.max(0, Math.floor(Number(msg.count) || 0)));
    return;
  }

  if (msg.type === "SAVE_SCREENSHOT") {
    chrome.downloads.download({
      url: msg.dataUrl,
      filename: msg.filename,
      conflictAction: "uniquify",
      saveAs: false,
    }, (downloadId) => {
      if (chrome.runtime.lastError || !downloadId) {
        sendResponse({ error: chrome.runtime.lastError?.message || "Download failed" });
        return;
      }
      // Data-URL downloads complete near-instantly; fetch resolved absolute path
      chrome.downloads.search({ id: downloadId }, (results) => {
        const item = results?.[0];
        if (item?.state === "complete") {
          sendResponse({ path: item.filename });
        } else {
          // Rare: still in progress — poll once
          const onChanged = (delta) => {
            if (delta.id !== downloadId || !delta.state) return;
            chrome.downloads.onChanged.removeListener(onChanged);
            chrome.downloads.search({ id: downloadId }, (r) => {
              sendResponse({ path: r[0]?.filename || msg.filename });
            });
          };
          chrome.downloads.onChanged.addListener(onChanged);
        }
      });
    });
    return true;
  }

  if (msg.type === "CAPTURE_SCREENSHOT") {
    if (!sender.tab?.windowId) {
      sendResponse({ error: "No window ID" });
      return true;
    }
    chrome.tabs.captureVisibleTab(sender.tab.windowId, { format: "png" }, (dataUrl) => {
      if (chrome.runtime.lastError) {
        sendResponse({ error: chrome.runtime.lastError.message });
      } else {
        sendResponse({ dataUrl });
      }
    });
    return true;
  }
});


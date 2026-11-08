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

let herdrPort = null;
let herdrIdleTimer = null;
const herdrRequests = new Map();

function herdrError(code, message) {
  return Object.assign(new Error(message), { code });
}

function scheduleHerdrDisconnect() {
  clearTimeout(herdrIdleTimer);
  if (herdrRequests.size) return;
  herdrIdleTimer = setTimeout(() => {
    const port = herdrPort;
    herdrPort = null;
    port?.disconnect();
  }, 60000);
}

function requestHerdr(operation, args = {}) {
  clearTimeout(herdrIdleTimer);
  return new Promise((resolve, reject) => {
    try {
      if (!herdrPort) {
        const port = chrome.runtime.connectNative("com.visual_annotator.herdr");
        herdrPort = port;
        port.onMessage.addListener((message) => {
          const pending = herdrRequests.get(message.requestId);
          if (!pending || message.version !== 1) return;
          clearTimeout(pending.timer);
          herdrRequests.delete(message.requestId);
          if (message.error) pending.reject(herdrError(message.error.code, message.error.message));
          else pending.resolve(message.result);
          scheduleHerdrDisconnect();
        });
        port.onDisconnect.addListener(() => {
          const reason = chrome.runtime.lastError?.message || "Herdr bridge disconnected.";
          if (herdrPort !== port) return;
          herdrPort = null;
          for (const pending of herdrRequests.values()) {
            clearTimeout(pending.timer);
            pending.reject(herdrError(pending.operation === "sendAnnotation" ? "SEND_UNKNOWN" : "BRIDGE_DISCONNECTED", reason));
          }
          herdrRequests.clear();
        });
      }
      const requestId = crypto.randomUUID();
      const timer = setTimeout(() => {
        herdrRequests.delete(requestId);
        reject(herdrError(operation === "sendAnnotation" ? "SEND_UNKNOWN" : "BRIDGE_TIMEOUT", "Herdr bridge timed out."));
        scheduleHerdrDisconnect();
      }, 120000);
      herdrRequests.set(requestId, { resolve, reject, timer, operation });
      try {
        herdrPort.postMessage({ version: 1, requestId, operation, ...args });
      } catch (error) {
        clearTimeout(timer);
        herdrRequests.delete(requestId);
        reject(herdrError("BRIDGE_UNAVAILABLE", error.message));
        scheduleHerdrDisconnect();
      }
    } catch (error) {
      reject(herdrError("BRIDGE_UNAVAILABLE", error.message));
    }
  });
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.type !== "HERDR_REQUEST") return;
  if (sender.id !== chrome.runtime.id || !sender.tab?.id || sender.frameId !== 0) {
    sendResponse({ error: { code: "INVALID_SOURCE", message: "Only the page annotation panel can use Herdr." } });
    return;
  }
  const run = async () => {
    if (msg.operation === "listAgents") {
      const result = await requestHerdr("listAgents");
      const saved = await chrome.storage.local.get("herdrTarget");
      return { ...result, selected: result.selected || saved.herdrTarget || null };
    }
    if (typeof msg.terminal !== "string" || !/^(?:[\w.-]+\/)?t[a-z0-9]+$/.test(msg.terminal)) {
      throw herdrError("INVALID_TARGET", "Select a valid Herdr agent.");
    }
    if (msg.operation === "uploadAttachment") {
      if (typeof msg.dataUrl !== "string" || msg.dataUrl.length > 12 * 1024 * 1024 ||
          !msg.dataUrl.startsWith("data:image/png;base64,") || typeof msg.attachmentId !== "string" || msg.attachmentId.length > 100) {
        throw herdrError("INVALID_ATTACHMENT", "Invalid PNG screenshot or screenshot exceeds 8 MB.");
      }
      return requestHerdr("uploadAttachment", { terminal: msg.terminal, attachmentId: msg.attachmentId, dataUrl: msg.dataUrl });
    }
    if (msg.operation === "sendAnnotation") {
      if (typeof msg.markdown !== "string" || !msg.markdown.trim() || msg.markdown.length > 1024 * 1024) {
        throw herdrError("INVALID_ANNOTATION", "Annotation is empty or exceeds 1 MB.");
      }
      const result = await requestHerdr("sendAnnotation", { terminal: msg.terminal, markdown: msg.markdown });
      await chrome.storage.local.set({ herdrTarget: msg.terminal }).catch(() => {});
      return result;
    }
    throw herdrError("INVALID_OPERATION", "Unknown Herdr operation.");
  };
  run().then((result) => sendResponse({ result }), (error) => sendResponse({ error: { code: error.code || "BRIDGE_ERROR", message: error.message } }));
  return true;
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


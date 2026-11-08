/**
 * Visual Annotator — Content Script (v1.0.0)
 *
 * Universal element annotation for any web page.
 * Click elements, add comments, copy as structured markdown.
 * Paste into any AI coding agent.
 *
 * No backend required — everything runs client-side.
 */

(() => {
  const LOADED_KEY = "__visualAnnotator_" + chrome.runtime.id;
  if (window[LOADED_KEY]) return;
  window[LOADED_KEY] = true;

  // ─── Constants ───────────────────────────────────────────────────────

  const IS_MAC = /Mac|iPhone|iPad/.test(navigator.platform);
  const TEXT_MAX = 200;
  const Z_HIGHLIGHT = 2147483644;
  const Z_MARKERS = 2147483645;
  const Z_POPUP = 2147483647;

  function esc(s) {
    if (s == null) return "";
    return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }

  function isOurs(el) {
    if (!el) return false;
    if (el.closest?.("[data-va]")) return true;
    return false;
  }

  // ─── State ───────────────────────────────────────────────────────────

  let isAnnotating = false;
  let annotations = [];
  let nextId = 1;

  // Element picker
  let hoverStack = [];
  let stackIdx = 0;

  // DOM refs
  let highlightEl = null;
  let tooltipEl = null;
  let markersContainer = null;
  let popupHost = null;
  let globalStyleEl = null;
  let overlayRoot = null;
  let layerSyncFrame = null;
  const modalOrder = [];

  function syncOverlayLayer(raise = false) {
    if (!overlayRoot) return;
    const modals = Array.from(document.querySelectorAll("dialog:modal"));
    for (let i = modalOrder.length - 1; i >= 0; i--) {
      if (!modals.includes(modalOrder[i])) modalOrder.splice(i, 1);
    }
    modals.forEach((modal) => {
      if (!modalOrder.includes(modal)) modalOrder.push(modal);
    });
    const parent = modalOrder[modalOrder.length - 1] || document.body;
    const moved = overlayRoot.parentElement !== parent;
    if (moved) parent.appendChild(overlayRoot);
    if (typeof overlayRoot.showPopover === "function") {
      if (raise && overlayRoot.matches(":popover-open")) overlayRoot.hidePopover();
      if (!overlayRoot.matches(":popover-open")) overlayRoot.showPopover();
    }
    if (moved) {
      scheduleSyncMarkers();
      popupHost?.shadowRoot?.querySelector("#comment")?.focus({ preventScroll: true });
    }
  }

  function ensureOverlayRoot() {
    if (!overlayRoot) {
      overlayRoot = document.createElement("div");
      overlayRoot.setAttribute("data-va", "overlay");
      overlayRoot.setAttribute("popover", "manual");
      overlayRoot.style.cssText = `all:initial !important; position:fixed !important; inset:0 auto auto 0 !important; width:0 !important; height:0 !important; margin:0 !important; padding:0 !important; border:0 !important; overflow:visible !important; pointer-events:none !important; z-index:${Z_POPUP} !important;`;
    }
    syncOverlayLayer();
    return overlayRoot;
  }

  function onPageLayerChange(e) {
    if (isOurs(e.target)) return;
    if (e.target.matches?.("dialog:modal")) {
      const index = modalOrder.indexOf(e.target);
      if (index !== -1) modalOrder.splice(index, 1);
      modalOrder.push(e.target);
    }
    if (!overlayRoot?.isConnected || layerSyncFrame !== null) return;
    layerSyncFrame = requestAnimationFrame(() => {
      layerSyncFrame = null;
      if (overlayRoot?.isConnected) syncOverlayLayer(true);
    });
  }

  document.addEventListener("beforetoggle", onPageLayerChange, true);
  document.addEventListener("toggle", onPageLayerChange, true);
  document.addEventListener("close", onPageLayerChange, true);
  new MutationObserver((records) => {
    if (records.some((record) => record.target.matches?.("dialog") ||
      Array.from(record.removedNodes).some((node) => node.nodeType === 1 &&
        (node.matches("dialog") || node.querySelector("dialog"))))) {
      onPageLayerChange({ target: document });
    }
  }).observe(document.documentElement, { subtree: true, childList: true, attributes: true, attributeFilter: ["open"] });

  const POPUP_CSS = `
:host {
  all: initial;
  display: block;
  position: fixed;
  z-index: ${Z_POPUP};
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
}
* { box-sizing: border-box; }

:host {
  --bg: #1c1c1e; --bg2: #2c2c2e; --border: #3a3a3c;
  --text: #f4f4f5; --muted: #a1a1aa;
  --accent: #6366f1; --accent-h: #4f46e5;
  --shadow: 0 4px 24px rgba(0,0,0,.5);
}
@media (prefers-color-scheme: light) {
  :host {
    --bg: #ffffff; --bg2: #f8f8f8; --border: #e4e4e7;
    --text: #18181b; --muted: #71717a;
    --shadow: 0 4px 24px rgba(0,0,0,.12);
  }
}

.popup {
  width: 600px; max-width:calc(100vw - 16px); max-height:calc(100vh - 16px); overflow:auto;
  background: var(--bg); border: 1px solid var(--border);
  border-radius: 12px; box-shadow: var(--shadow); padding: 16px;
  font-size: 13px; color: var(--text);
  animation: pop .12s ease;
}
@keyframes pop {
  from { opacity:0; transform: scale(.95) translateY(4px); }
  to   { opacity:1; transform: scale(1) translateY(0); }
}

.header { display:flex; align-items:center; justify-content:space-between; margin-bottom:6px; cursor:grab; user-select:none; touch-action:none; }
.header:active { cursor:grabbing; }
.parent-row { margin-bottom:10px; }
.parent-btn {
  font-size:11px; padding:2px 10px; border-radius:10px;
  border:1px solid var(--border); background:transparent; color:var(--muted);
  font-family:inherit; cursor:pointer;
}
.parent-btn:hover:not(:disabled) { border-color:var(--accent); color:var(--accent); }
.parent-btn:disabled { opacity:.4; cursor:default; }
.parent-row { display:flex; gap:6px; }
.el-tag {
  font-size:11px; font-family:ui-monospace,monospace; color:var(--muted);
  background:var(--bg2); border-radius:4px; padding:2px 8px;
  max-width:260px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;
}
.close-btn {
  background:none; border:none; color:var(--muted); cursor:pointer;
  font-size:18px; line-height:1; padding:2px 4px; border-radius: 4px;
}
.close-btn:hover { color: #ef4444; background: var(--bg2); }

textarea {
  width:100%; min-height:80px; resize:vertical;
  border:1px solid var(--border); border-radius:8px;
  background:var(--bg2); color:var(--text);
  font-family:inherit; font-size:13px; padding:10px 12px;
  outline:none; transition:border-color .15s; margin-bottom:10px;
}
textarea:focus { border-color:var(--accent); }
textarea::placeholder { color:var(--muted); }

.actions { display:flex; justify-content:flex-end; gap:6px; flex-wrap:wrap; }

.btn-secondary {
  padding:7px 12px; border-radius:6px; border:1px solid var(--border);
  background:transparent; color:var(--muted); font-size:12px;
  font-family:inherit; cursor:pointer; white-space:nowrap;
}
.btn-secondary:hover { border-color:var(--muted); color:var(--text); }

.btn-primary {
  padding:7px 16px; border-radius:6px; border:none;
  background:var(--accent); color:#fff;
  font-size:12px; font-weight:600; font-family:inherit; cursor:pointer;
}
.btn-primary:hover { background:var(--accent-h); }
.btn-primary:disabled { opacity:.5; cursor:not-allowed; }
  `;

  const GLOBAL_CSS = `
body.va-annotating, body.va-annotating * { cursor: crosshair !important; }
.va-marker {
  position: absolute; z-index: ${Z_MARKERS};
  width: 24px; height: 24px; border-radius: 50%;
  background: #6366f1; color: #fff;
  font: 700 11px -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
  display: flex; align-items: center; justify-content: center;
  cursor: pointer; box-shadow: 0 2px 8px rgba(99,102,241,.4);
  transition: transform .15s; pointer-events: all; user-select: none;
}
.va-marker:hover { transform: scale(1.15); }
.va-marker.has-screenshot { background: #22c55e; box-shadow: 0 2px 8px rgba(34,197,94,.4); }
`;

  // ─── Icons ───────────────────────────────────────────────────────────

  const ICONS = {
    camera: `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"/><circle cx="12" cy="13" r="4"/></svg>`,
  };

  // ─── Message Handling ────────────────────────────────────────────────

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg.type === "TOGGLE_ANNOTATING") {
      if (isAnnotating) stopAnnotating(); else startAnnotating();
    }
    if (msg.type === "PING") sendResponse("PONG");
  });

  function startAnnotating() {
    ensureOverlayRoot();

    // Global styles
    if (!globalStyleEl) {
      globalStyleEl = document.createElement("style");
      globalStyleEl.id = "va-global";
      globalStyleEl.textContent = GLOBAL_CSS;
      document.head.appendChild(globalStyleEl);
    }

    // Highlight overlay
    if (!highlightEl) {
      highlightEl = document.createElement("div");
      highlightEl.setAttribute("data-va", "highlight");
      Object.assign(highlightEl.style, {
        position: "fixed", pointerEvents: "none", zIndex: Z_HIGHLIGHT,
        border: "2px solid rgba(99,102,241,0.7)", background: "rgba(99,102,241,0.08)",
        borderRadius: "3px", transition: "all 0.06s ease", display: "none",
      });
      overlayRoot.appendChild(highlightEl);
    }

    // Tooltip
    if (!tooltipEl) {
      tooltipEl = document.createElement("div");
      tooltipEl.setAttribute("data-va", "tooltip");
      Object.assign(tooltipEl.style, {
        position: "fixed", pointerEvents: "none", zIndex: Z_POPUP,
        background: "#1c1c1e", color: "#f4f4f5", padding: "5px 10px",
        borderRadius: "6px", font: "12px ui-monospace, monospace",
        boxShadow: "0 2px 8px rgba(0,0,0,.5)", display: "none", maxWidth: "400px",
      });
      overlayRoot.appendChild(tooltipEl);
    }

    // Markers
    if (!markersContainer) {
      markersContainer = document.createElement("div");
      markersContainer.setAttribute("data-va", "markers");
      Object.assign(markersContainer.style, {
        position: "fixed", top: "0", left: "0", width: "0", height: "0",
        overflow: "visible", pointerEvents: "none", zIndex: Z_MARKERS,
      });
      overlayRoot.appendChild(markersContainer);
    }

    if (markersContainer) markersContainer.style.display = "";
    syncMarkers();
    setAnnotating(true);
  }

  function stopAnnotating() {
    setAnnotating(false);
    if (markersContainer) markersContainer.style.display = "none";
    closePopup();
    overlayRoot?.remove();
  }

  function updateActionState() {
    chrome.runtime.sendMessage({
      type: "ANNOTATION_STATE",
      active: isAnnotating,
      count: annotations.length,
    }).catch(() => {});
  }

  // ─── Annotate Mode ──────────────────────────────────────────────────

  function setAnnotating(active) {
    if (isAnnotating === active) return;
    isAnnotating = active;
    hoverStack = [];
    stackIdx = 0;
    updateActionState();
    document.body.classList.toggle("va-annotating", isAnnotating);

    if (isAnnotating) {
      document.addEventListener("mousemove", onMouseMove, true);
      document.addEventListener("click", onClick, true);
      document.addEventListener("wheel", onWheel, { passive: false, capture: true });
      document.addEventListener("keydown", onAnnotateKeyDown, true);
    } else {
      document.removeEventListener("mousemove", onMouseMove, true);
      document.removeEventListener("click", onClick, true);
      document.removeEventListener("wheel", onWheel, { capture: true });
      document.removeEventListener("keydown", onAnnotateKeyDown, true);
      hideHighlight();
      hideTooltip();
    }
  }

  function onMouseMove(e) {
    if (popupHost) return;
    syncOverlayLayer();
    if (isOurs(e.target)) { hideHighlight(); hideTooltip(); return; }

    highlightEl.style.display = "none";
    const el = document.elementFromPoint(e.clientX, e.clientY);
    highlightEl.style.display = "";

    if (!el || el === document.body || el === document.documentElement || isOurs(el)) {
      hideHighlight(); hideTooltip(); return;
    }

    hoverStack = [];
    let cur = el;
    while (cur && cur !== document.body && cur !== document.documentElement) {
      if (!isOurs(cur)) hoverStack.push(cur);
      cur = cur.parentElement;
    }
    stackIdx = 0;

    showHighlight(hoverStack[0]);
    showTooltip(hoverStack[0], e.clientX, e.clientY);
  }

  function onWheel(e) {
    if (popupHost || !hoverStack.length || isOurs(e.target)) return;
    if (!e.altKey) return;
    e.preventDefault(); e.stopPropagation();
    stackIdx = e.deltaY > 0
      ? Math.min(stackIdx + 1, hoverStack.length - 1)
      : Math.max(stackIdx - 1, 0);
    showHighlight(hoverStack[stackIdx]);
    showTooltip(hoverStack[stackIdx], e.clientX, e.clientY);
  }

  function onClick(e) {
    if (isOurs(e.target) || popupHost) return;
    e.preventDefault(); e.stopPropagation();

    const el = hoverStack[stackIdx];
    if (!el) return;

    hideHighlight(); hideTooltip();
    const existing = annotations.find((a) => a.element === el);
    showPopup(el, existing || null);
  }

  function onAnnotateKeyDown(e) {
    if (e.key === "Escape") {
      if (popupHost) { closePopup(); } else { stopAnnotating(); }
      e.preventDefault();
      e.stopPropagation();
    }
  }

  // ─── Highlight & Tooltip ─────────────────────────────────────────────

  function showHighlight(el) {
    if (!el || !highlightEl) return;
    const r = el.getBoundingClientRect();
    Object.assign(highlightEl.style, {
      display: "block", left: `${r.left}px`, top: `${r.top}px`,
      width: `${r.width}px`, height: `${r.height}px`,
    });
  }
  function hideHighlight() { if (highlightEl) highlightEl.style.display = "none"; }

  function showTooltip(el, mx, my) {
    if (!el || !tooltipEl) return;
    const r = el.getBoundingClientRect();
    const tag = el.tagName.toLowerCase();
    const id = el.id ? `<span style="color:#f0c674">#${esc(el.id)}</span>` : "";
    const cls = el.classList.length
      ? `<span style="color:#5f87ff">.${esc(Array.from(el.classList).slice(0, 3).join("."))}</span>` : "";
    const size = `<span style="color:#666;margin-left:8px">${Math.round(r.width)}×${Math.round(r.height)}</span>`;
    const hint = hoverStack.length > 1
      ? `<span style="color:#6366f1;font-size:11px;display:block;margin-top:3px">${IS_MAC ? "⌥" : "Alt"}+scroll ${stackIdx + 1}/${hoverStack.length}</span>` : "";
    tooltipEl.innerHTML = `<span style="color:#cc6666">${tag}</span>${id}${cls}${size}${hint}`;
    tooltipEl.style.display = "";

    let tx = mx + 15, ty = my + 15;
    const tr = tooltipEl.getBoundingClientRect();
    if (tx + tr.width > window.innerWidth - 10) tx = mx - tr.width - 10;
    if (ty + tr.height > window.innerHeight - 10) ty = my - tr.height - 10;
    tooltipEl.style.left = tx + "px"; tooltipEl.style.top = ty + "px";
  }
  function hideTooltip() { if (tooltipEl) tooltipEl.style.display = "none"; }

  // ─── Annotation Popup ───────────────────────────────────────────────

  let currentScreenshot = null;   // base64 for popup preview
  let currentScreenshotPath = null; // saved file path
  let lastCopiedMd = null;          // markdown from previous copy action
  let popupHighlightFrame = null;

  async function showPopup(el, existing) {
    closePopup();
    const host = document.createElement("div");
    popupHost = host;
    currentScreenshot = existing?.screenshot || null;
    currentScreenshotPath = existing?.screenshotPath || null;

    // Detect if clipboard still holds the last copied export
    let clipboardHasLastCopy = false;
    if (lastCopiedMd && annotations.length) {
      try {
        const clip = await navigator.clipboard.readText();
        clipboardHasLastCopy = clip === lastCopiedMd;
      } catch { clipboardHasLastCopy = false; }
    }

    if (popupHost !== host || !isAnnotating) return;
    popupHost.setAttribute("data-va", "popup");
    const shadow = popupHost.attachShadow({ mode: "open" });

    const style = document.createElement("style");
    style.textContent = POPUP_CSS;
    shadow.appendChild(style);

    let currentEl = el;
    const elHistory = [];

    function elLabel(target) {
      const tag = target.tagName.toLowerCase();
      const idAttr = target.id ? `#${target.id}` : "";
      const clsAttr = target.classList.length ? `.${Array.from(target.classList).slice(0, 2).join(".")}` : "";
      return `<${tag}${idAttr}${clsAttr}>`;
    }

    const comment = existing?.comment || "";

    const popup = document.createElement("div");
    popup.className = "popup";
    popup.innerHTML = `
      <div class="header">
        <span class="el-tag">${esc(elLabel(currentEl))}</span>
        <button class="close-btn" id="close">×</button>
      </div>
      <div class="parent-row"><button class="parent-btn" id="parent">Parent ↑</button><button class="parent-btn" id="previous">Previous ←</button></div>
      <textarea id="comment" placeholder="Describe the issue or desired change...">${esc(comment)}</textarea>
      ${clipboardHasLastCopy ? `
      <div style="margin-bottom:10px;">
        <label style="display:flex;align-items:center;gap:6px;font-size:12px;color:var(--muted);cursor:pointer;">
          <input type="checkbox" id="append-existing" checked style="accent-color:var(--accent);">
          Add to existing annotations
        </label>
      </div>` : ""}
      <div class="actions">
        <button class="btn-secondary" id="cancel">Cancel</button>
        <button class="btn-secondary" id="copy-ss-next" style="display:flex;align-items:center;gap:5px;">${ICONS.camera}Copy & Next</button>
        <button class="btn-secondary" id="copy-next">Copy & Next</button>
        <button class="btn-secondary" id="copy-ss" style="display:flex;align-items:center;gap:5px;">${ICONS.camera}Copy & Exit</button>
        <button class="btn-primary" id="copy">Copy & Exit</button>
      </div>
    `;
    shadow.appendChild(popup);
    setupPopupDrag(popup.querySelector(".header"), host);

    const q = (s) => shadow.querySelector(s);

    function refreshTarget() {
      const parent = currentEl.parentElement;
      q("#parent").disabled = !parent || parent === document.documentElement || parent === document.body || isOurs(parent);
      q("#previous").disabled = elHistory.length === 0;
      q(".el-tag").textContent = elLabel(currentEl);
    }

    function switchTarget(nextEl) {
      currentEl = nextEl;
      hoverStack = [nextEl];
      stackIdx = 0;
      currentScreenshot = null;
      currentScreenshotPath = null;
      refreshTarget();
      positionPopup(host, popup, currentEl);
      q("#comment")?.focus({ preventScroll: true });
    }

    q("#parent").addEventListener("click", () => {
      const parent = currentEl.parentElement;
      if (!parent || parent === document.documentElement || parent === document.body || isOurs(parent)) return;
      elHistory.push(currentEl);
      switchTarget(parent);
    });

    q("#previous").addEventListener("click", () => {
      const prev = elHistory.pop();
      if (!prev) return;
      switchTarget(prev);
    });
    refreshTarget();

    let submitting = false;
    async function submitAndCopy(withScreenshot, keepAnnotating) {
      if (submitting || popupHost !== host) return;
      submitting = true;
      const buttons = popup.querySelectorAll(".actions button");
      buttons.forEach((button) => { button.disabled = true; });
      try {
        if (withScreenshot && !currentScreenshot) {
          host.style.visibility = "hidden";
          const dataUrl = await captureScreenshot(currentEl);
          if (popupHost !== host) return;
          host.style.visibility = "";
          if (!dataUrl) {
            alert("Screenshot failed. Please try again.");
            return;
          }
          currentScreenshot = dataUrl;
          const path = await saveScreenshotFile(dataUrl);
          if (popupHost !== host) return;
          currentScreenshotPath = path;
        }
        submitAnnotation(currentEl, annotations.find((a) => a.element === currentEl) || null, false);
        const copied = await copyMarkdown();
        if (popupHost !== host || !copied) return;
        closePopup();
        if (!keepAnnotating) {
          annotations = [];
          syncMarkers(); updateActionState();
          stopAnnotating();
        }
      } finally {
        submitting = false;
        buttons.forEach((button) => { button.disabled = false; });
      }
    }

    // Wire events
    q("#close").addEventListener("click", closePopup);
    q("#cancel").addEventListener("click", closePopup);
    q("#copy").addEventListener("click", () => submitAndCopy(false, false));
    q("#copy-ss").addEventListener("click", () => submitAndCopy(true, false));
    q("#copy-next").addEventListener("click", () => submitAndCopy(false, true));
    q("#copy-ss-next").addEventListener("click", () => submitAndCopy(true, true));

    popup.addEventListener("keydown", (e) => {
      if (e.target === q("#comment") && e.key === "Enter" && (IS_MAC ? e.metaKey : e.ctrlKey) && !e.isComposing && !e.repeat) {
        e.preventDefault();
        q("#copy").click();
      }
      if (e.key === "Escape") { closePopup(); e.stopPropagation(); }
      e.stopPropagation();
    });

    Object.assign(host.style, { position: "fixed", pointerEvents: "auto", zIndex: Z_POPUP, left: "0", top: "0", visibility: "hidden" });
    ensureOverlayRoot().appendChild(host);
    syncOverlayLayer(true);
    positionPopup(host, popup, currentEl);
    host.style.visibility = "";
    const trackHighlight = () => {
      if (popupHost !== host) return;
      if (isAnnotating && host.style.visibility !== "hidden" && document.contains(currentEl)) {
        showHighlight(currentEl);
      } else {
        hideHighlight();
      }
      popupHighlightFrame = requestAnimationFrame(trackHighlight);
    };
    trackHighlight();
    setTimeout(() => { if (popupHost === host) q("#comment")?.focus({ preventScroll: true }); }, 50);
  }

  function positionPopup(host, popup, el) {
    const rect = el.getBoundingClientRect();
    const width = popup.offsetWidth, height = popup.offsetHeight;
    const margin = 8, gap = 12;
    const maxX = Math.max(margin, window.innerWidth - width - margin);
    const maxY = Math.max(margin, window.innerHeight - height - margin);
    const clampX = (x) => Math.max(margin, Math.min(x, maxX));
    const clampY = (y) => Math.max(margin, Math.min(y, maxY));
    const candidates = [
      { x: rect.right + gap, y: rect.top },
      { x: rect.left - width - gap, y: rect.top },
      { x: rect.left, y: rect.bottom + gap },
      { x: rect.left, y: rect.top - height - gap },
      { x: margin, y: margin },
      { x: maxX, y: margin },
      { x: margin, y: maxY },
      { x: maxX, y: maxY },
    ];
    let best = null;
    for (const candidate of candidates) {
      const x = clampX(candidate.x), y = clampY(candidate.y);
      const overlapWidth = Math.max(0, Math.min(x + width, rect.right) - Math.max(x, rect.left));
      const overlapHeight = Math.max(0, Math.min(y + height, rect.bottom) - Math.max(y, rect.top));
      const overlap = overlapWidth * overlapHeight;
      if (!best || overlap < best.overlap) best = { x, y, overlap };
      if (overlap === 0) break;
    }
    Object.assign(host.style, { left: `${best.x}px`, top: `${best.y}px` });
  }

  function setupPopupDrag(header, host) {
    let drag = null;
    header.addEventListener("pointerdown", (e) => {
      if (e.button !== 0 || e.target.closest("button")) return;
      const rect = host.getBoundingClientRect();
      drag = { id: e.pointerId, x: e.clientX - rect.left, y: e.clientY - rect.top };
      header.setPointerCapture(e.pointerId);
      e.preventDefault();
    });
    header.addEventListener("pointermove", (e) => {
      if (!drag || e.pointerId !== drag.id) return;
      const rect = host.getBoundingClientRect();
      const left = Math.max(0, Math.min(e.clientX - drag.x, window.innerWidth - rect.width));
      const top = Math.max(0, Math.min(e.clientY - drag.y, window.innerHeight - header.offsetHeight));
      Object.assign(host.style, { left: `${left}px`, top: `${top}px` });
    });
    const stop = () => { drag = null; };
    header.addEventListener("pointerup", stop);
    header.addEventListener("pointercancel", stop);
    header.addEventListener("lostpointercapture", stop);
  }

  function closePopup() {
    if (popupHighlightFrame !== null) cancelAnimationFrame(popupHighlightFrame);
    popupHighlightFrame = null;
    hideHighlight();
    popupHost?.remove();
    popupHost = null;
    currentScreenshot = null;
    currentScreenshotPath = null;
  }

  function submitAnnotation(el, existing, dismiss = true) {
    if (!popupHost) return;
    const shadow = popupHost.shadowRoot;
    const comment = shadow.querySelector("#comment").value.trim();
    const appendExisting = shadow.querySelector("#append-existing");
    if (appendExisting && !appendExisting.checked) {
      annotations = [];
      nextId = 1;
    }

    const rect = el.getBoundingClientRect();

    if (existing && !annotations.includes(existing)) existing = null;

    if (existing) {
      existing.comment = comment;
      existing.screenshot = currentScreenshot;
      existing.screenshotPath = currentScreenshotPath;
    } else {
      annotations.push({
        id: nextId++,
        element: el,
        selector: genSelector(el),
        tag: el.tagName.toLowerCase(),
        idAttr: el.id || null,
        classes: Array.from(el.classList),
        text: (el.textContent || "").slice(0, TEXT_MAX).trim().replace(/\s+/g, " "),
        rect: {
          x: Math.round(rect.x + window.scrollX),
          y: Math.round(rect.y + window.scrollY),
          width: Math.round(rect.width),
          height: Math.round(rect.height),
        },
        url: window.location.href,
        comment,
        screenshot: currentScreenshot,
        screenshotPath: currentScreenshotPath,
        shopifySection: detectShopifySection(el),
        keyStyles: getKeyStyles(el),
      });
    }

    if (dismiss) closePopup();
    syncMarkers();
    updateActionState();
  }

  // ─── Markers ─────────────────────────────────────────────────────────

  function syncMarkers() {
    if (!markersContainer) return;
    markersContainer.innerHTML = "";

    annotations.forEach((a, i) => {
      if (!a.element || !document.contains(a.element)) return;
      const r = a.element.getBoundingClientRect();
      const marker = document.createElement("div");
      marker.className = `va-marker${a.screenshot ? " has-screenshot" : ""}`;
      marker.textContent = String(i + 1);
      marker.style.left = `${r.right - 12}px`;
      marker.style.top = `${r.top - 12}px`;
      marker.addEventListener("click", (e) => { e.stopPropagation(); showPopup(a.element, a); });
      markersContainer.appendChild(marker);
    });
  }

  let syncTimer = null;
  function scheduleSyncMarkers() {
    if (syncTimer) return;
    syncTimer = requestAnimationFrame(() => { syncTimer = null; if (isAnnotating) syncMarkers(); });
  }
  window.addEventListener("scroll", scheduleSyncMarkers, true);
  window.addEventListener("resize", scheduleSyncMarkers);

  // ─── Shopify Section Detection ───────────────────────────────────────

  function detectShopifySection(el) {
    let cur = el;
    while (cur && cur !== document.documentElement) {
      if (cur.classList?.contains("shopify-section")) {
        const sectionClass = Array.from(cur.classList).find((c) => c.startsWith("shopify-section--"));
        const sectionName = sectionClass ? sectionClass.replace("shopify-section--", "") : null;
        return {
          id: cur.id || null,
          name: sectionName,
          file: sectionName ? `sections/${sectionName}.liquid` : null,
        };
      }
      cur = cur.parentElement;
    }
    return null;
  }

  // ─── Selector Generation ────────────────────────────────────────────

  function genSelector(el) {
    if (el.id && /^[a-zA-Z][\w-]*$/.test(el.id)) return `#${el.id}`;
    if (el.classList.length) {
      const cls = Array.from(el.classList).filter((c) => /^[a-zA-Z][\w-]*$/.test(c));
      if (cls.length) {
        const sel = el.tagName.toLowerCase() + "." + cls.join(".");
        try { if (document.querySelectorAll(sel).length === 1) return sel; } catch {}
      }
    }
    const path = [];
    let cur = el;
    while (cur && cur !== document.body) {
      let part = cur.tagName.toLowerCase();
      if (cur.id && /^[a-zA-Z][\w-]*$/.test(cur.id)) { path.unshift(`#${cur.id}`); break; }
      const parent = cur.parentElement;
      if (parent) {
        const sibs = Array.from(parent.children).filter((c) => c.tagName === cur.tagName);
        if (sibs.length > 1) part += `:nth-of-type(${sibs.indexOf(cur) + 1})`;
      }
      path.unshift(part);
      cur = parent;
    }
    return path.join(" > ");
  }

  // ─── Key Styles ──────────────────────────────────────────────────────

  const STYLE_DEFAULTS = {
    position: new Set(["static"]),
    overflow: new Set(["visible"]),
    zIndex: new Set(["auto"]),
    opacity: new Set(["1"]),
    backgroundColor: new Set(["rgba(0, 0, 0, 0)", "transparent"]),
    fontSize: new Set(["16px"]),
    fontWeight: new Set(["400", "normal"]),
  };

  function getKeyStyles(el) {
    const cs = window.getComputedStyle(el);
    const s = {};
    if (cs.display) s.display = cs.display;
    for (const [k, defs] of Object.entries(STYLE_DEFAULTS)) {
      const v = cs[k];
      if (v && !defs.has(v)) s[k] = v;
    }
    return s;
  }

  // ─── Screenshot ──────────────────────────────────────────────────────

  function isContextValid() {
    try { return !!chrome.runtime?.id; } catch { return false; }
  }

  async function captureScreenshot(el) {
    if (!isContextValid()) {
      alert("Visual Annotator was updated. Please reload the page.");
      return null;
    }
    try {
      if (highlightEl) highlightEl.style.display = "none";
      if (tooltipEl) tooltipEl.style.display = "none";
      if (markersContainer) markersContainer.style.display = "none";

      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));

      const resp = await chrome.runtime.sendMessage({ type: "CAPTURE_SCREENSHOT" });
      if (!resp?.dataUrl) throw new Error("No screenshot");

      const cropped = await cropToElement(resp.dataUrl, el);

      return cropped;
    } catch (err) {
      console.error("[visual-annotator] Screenshot failed:", err);
      return null;
    } finally {
      if (markersContainer) markersContainer.style.display = isAnnotating ? "" : "none";
    }
  }

  function cropToElement(dataUrl, el) {
    return new Promise((resolve) => {
      const img = new Image();
      img.onload = () => {
        const dpr = window.devicePixelRatio || 1;
        const r = el.getBoundingClientRect();
        const pad = 20;
        const x1 = Math.max(0, r.left - pad), y1 = Math.max(0, r.top - pad);
        const x2 = Math.min(window.innerWidth, r.right + pad);
        const y2 = Math.min(window.innerHeight, r.bottom + pad);
        const w = Math.max(1, (x2 - x1) * dpr), h = Math.max(1, (y2 - y1) * dpr);
        const canvas = document.createElement("canvas");
        canvas.width = w; canvas.height = h;
        const ctx = canvas.getContext("2d");
        if (!ctx) { resolve(dataUrl); return; }
        ctx.drawImage(img, x1 * dpr, y1 * dpr, w, h, 0, 0, w, h);
        resolve(canvas.toDataURL("image/png"));
      };
      img.onerror = () => resolve(dataUrl);
      img.src = dataUrl;
    });
  }

  // ─── Save Screenshot File ────────────────────────────────────────────

  function saveScreenshotFile(dataUrl) {
    if (!isContextValid()) return Promise.resolve(null);
    const loc = window.location;
    const isLocalhost = /^localhost$|^127\.|^\[::1\]/.test(loc.hostname);
    let slug;
    if (isLocalhost) {
      slug = (loc.host + loc.pathname).replace(/[^a-z0-9]+/gi, "-").replace(/^-|-$/g, "").toLowerCase();
    } else {
      slug = (loc.hostname + loc.pathname).replace(/[^a-z0-9]+/gi, "-").replace(/^-|-$/g, "").toLowerCase();
    }
    slug = slug.slice(0, 60);
    const filename = `visual-annotator/${slug}-${Date.now()}.png`;
    return new Promise((resolve) => {
      chrome.runtime.sendMessage({ type: "SAVE_SCREENSHOT", dataUrl, filename }, (resp) => {
        resolve(resp?.path || null);
      });
    });
  }

  // ─── Copy Markdown ──────────────────────────────────────────────────

  function exportMarkdown() {
    const url = window.location.href;
    const vw = window.innerWidth, vh = window.innerHeight;
    const now = new Date().toISOString();

    let md = `# Visual Feedback — ${document.title}\n`;
    md += `**URL:** ${url}\n`;
    md += `**Viewport:** ${vw}×${vh}\n`;
    md += `**Date:** ${now}\n\n`;

    if (!annotations.length) { md += "*No annotations*\n"; return md; }

    md += `---\n\n`;

    const single = annotations.length === 1;
    annotations.forEach((a, i) => {
      const label = a.idAttr ? `#${a.idAttr}` : `${a.tag}${a.classes[0] ? "." + a.classes[0] : ""}`;
      if (!single) md += `## ${i + 1}. \`${label}\`\n\n`;
      if (a.shopifySection?.file) md += `- **Shopify Section:** \`${a.shopifySection.file}\`\n`;
      if (a.url && a.url !== url) md += `- **URL:** ${a.url}\n`;
      md += `- **Selector:** \`${a.selector}\`\n`;
      if (a.text) md += `- **Text:** "${a.text.slice(0, 100)}${a.text.length > 100 ? "..." : ""}"\n`;
      md += `- **Bounding Box:** ${a.rect.width}×${a.rect.height} at (${a.rect.x}, ${a.rect.y})\n`;
      if (a.keyStyles && Object.keys(a.keyStyles).length) {
        md += `- **Styles:** ${Object.entries(a.keyStyles).map(([k, v]) => `${k}: ${v}`).join(", ")}\n`;
      }
      if (a.screenshotPath) md += `- **Screenshot:** ![screenshot-${i + 1}](${a.screenshotPath})\n`;
      else if (a.screenshot) md += `- **Screenshot:** [image attached]\n`;
      if (a.comment) md += `- **User Request:** ${a.comment}\n`;
      if (i < annotations.length - 1) md += `\n---\n\n`;
    });

    return md;
  }

  async function copyMarkdown() {
    const md = exportMarkdown();
    try {
      await navigator.clipboard.writeText(md);
    } catch {
      const ta = document.createElement("textarea");
      ta.value = md; ta.style.cssText = "position:fixed;left:-9999px;top:-9999px";
      let copied = false;
      try {
        (popupHost || ensureOverlayRoot()).appendChild(ta);
        ta.select();
        copied = document.execCommand("copy");
      } catch {
        copied = false;
      } finally {
        ta.remove();
      }
      if (!copied) {
        alert("Copy failed. Your annotations have been kept. Please try again.");
        return false;
      }
    }
    lastCopiedMd = md;
    return true;
  }

  window.addEventListener("pageshow", updateActionState);
  updateActionState();

})();

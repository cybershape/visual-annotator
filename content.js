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
  all:initial; display:block; position:fixed; z-index:${Z_POPUP};
  font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;
  --bg:#202124; --bg2:#28292d; --hover:#323338; --border:#3b3d43;
  --text:#f2f3f5; --muted:#adb0b9; --accent:#818cf8; --accent-h:#6366f1;
  --focus:rgba(129,140,248,.22); --shadow:0 16px 48px rgba(0,0,0,.32),0 2px 8px rgba(0,0,0,.2);
  color-scheme:dark;
}
* { box-sizing:border-box; }
@media (prefers-color-scheme:light) {
  :host {
    --bg:#fff; --bg2:#f7f8fa; --hover:#eef0f4; --border:#e2e4e9;
    --text:#23252b; --muted:#656b77; --accent:#4f46e5; --accent-h:#4338ca;
    --focus:rgba(79,70,229,.14); --shadow:0 16px 48px rgba(22,27,45,.12),0 2px 8px rgba(22,27,45,.08);
    color-scheme:light;
  }
}
.popup {
  width:640px; max-width:calc(100vw - 16px); max-height:calc(100dvh - 16px); overflow:auto;
  background:var(--bg); border:1px solid var(--border); border-radius:16px;
  box-shadow:var(--shadow); padding:20px; font-size:14px; line-height:1.5; color:var(--text);
  scrollbar-width:thin; animation:pop .12s ease-out;
}
@keyframes pop { from { opacity:0; } to { opacity:1; } }
button,select,textarea,input { font:inherit; }
button { transition:background .12s,border-color .12s,box-shadow .12s; }
button:focus-visible,select:focus-visible,summary:focus-visible,input:focus-visible {
  outline:2px solid var(--accent); outline-offset:3px;
}
button:disabled { opacity:.4; cursor:not-allowed; }
.header { display:flex; align-items:center; gap:12px; cursor:grab; user-select:none; touch-action:none; }
.header:active { cursor:grabbing; }
.el-tag {
  min-width:0; max-width:calc(100% - 44px); overflow:hidden; text-overflow:ellipsis; white-space:nowrap;
  font:500 14px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace;
  color:var(--text); background:var(--bg2); border:1px solid var(--border); border-radius:6px; padding:4px 9px;
}
.close-btn {
  display:grid; place-items:center; flex:none; margin-left:auto; width:30px; height:30px;
  background:transparent; border:0; color:var(--muted); cursor:pointer; font-size:18px; line-height:1; border-radius:7px;
}
.close-btn:hover { background:var(--hover); color:var(--text); }
.parent-row { display:flex; gap:8px; margin-top:12px; }
.parent-btn {
  min-height:30px; padding:3px 10px; border-radius:6px; border:1px solid var(--border);
  background:transparent; color:var(--muted); font-size:14px; cursor:pointer;
}
.parent-btn:hover:not(:disabled) { background:var(--hover); color:var(--text); }
.section-divider { border:0; border-top:1px solid var(--border); margin:16px 0; }
textarea {
  display:block; width:100%; min-height:160px; resize:vertical; padding:12px 14px;
  border:1px solid var(--border); border-radius:10px; background:var(--bg2); color:var(--text);
  font-size:14px; line-height:1.65; outline:none; transition:border-color .12s,box-shadow .12s;
}
textarea:focus { border-color:var(--accent); box-shadow:0 0 0 3px var(--focus); }
textarea::placeholder { color:var(--muted); }
input[type=checkbox] { width:16px; height:16px; margin:0; accent-color:var(--accent); cursor:pointer; flex:none; }
#herdr-panel { margin:0 !important; }
#herdr-panel > summary { display:flex; align-items:center; gap:8px; min-height:28px; list-style:none; color:var(--text) !important; }
#herdr-panel > summary::-webkit-details-marker { display:none; }
#herdr-panel > summary > span { font-weight:600; }
#herdr-panel > summary > label { color:var(--muted); font-weight:400; }
.herdr-chevron { flex:none; color:var(--muted); transition:transform .15s; }
#herdr-panel[open] .herdr-chevron { transform:rotate(90deg); }
.herdr-target-row { display:flex; align-items:center; gap:8px; margin-top:12px; }
#herdr-agent { appearance:none; font-size:14px; line-height:1.5; height:38px; min-height:38px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
#herdr-agent selectedcontent { display:block; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
#herdr-agent option { font-size:14px; padding:10px 12px; overflow-wrap:anywhere; }
#herdr-agent option:checked { font-weight:600; }
#herdr-agent option:hover { background:var(--hover); }
#herdr-status:empty { display:none; }
#herdr-status { padding:10px 12px; border-radius:8px; background:var(--bg2); border:1px solid var(--border); }
@supports (appearance:base-select) {
  #herdr-agent,#herdr-agent::picker(select) { appearance:base-select; }
  #herdr-agent::picker-icon { display:none; }
  #herdr-agent::picker(select) {
    font-family:inherit; font-size:14px; color:var(--text); background:var(--bg);
    border:1px solid var(--border); border-radius:10px; box-shadow:var(--shadow); padding:4px;
    margin:6px 0; max-height:280px; max-width:calc(100vw - 24px); overflow:auto;
    position-area:block-end span-inline-end; position-try-fallbacks:flip-block;
  }
}
.actions { display:flex; align-items:center; gap:10px; }
.action-groups { display:flex; flex-wrap:wrap; justify-content:flex-end; gap:10px; margin-left:auto; }
.action-group { display:flex; align-items:stretch; }
.action-group > button { border-radius:0; }
.action-group > button:first-child { border-radius:8px 0 0 8px; padding:9px 10px; border-right:0; }
.action-group > button:last-child { border-radius:0 8px 8px 0; }
.action-group > button + button { border-left:1px solid var(--border); }
.btn-secondary,.btn-primary {
  display:inline-flex; align-items:center; justify-content:center; gap:6px; min-height:38px;
  padding:8px 12px; border-radius:8px; border:1px solid var(--border); font-size:14px; cursor:pointer; white-space:nowrap;
}
.btn-secondary { background:var(--bg); color:var(--text); }
.btn-secondary:hover:not(:disabled) { background:var(--hover); }
.btn-primary { background:var(--accent-h); border-color:var(--accent-h); color:#fff; font-weight:500; }
.btn-primary:hover:not(:disabled) { filter:brightness(1.1); }
.action-group-exit > button + button { border-left-color:rgba(255,255,255,.24); }
#cancel { color:var(--muted); background:transparent; border-color:transparent; padding-left:0; }
#cancel:hover { color:var(--text); }
@media (max-width:480px) {
  .popup { padding:16px; border-radius:12px; }
  .actions { align-items:flex-start; }
  .action-groups { gap:8px; }
  .action-group { flex:1; justify-content:flex-end; }
  .action-group > button:last-child { flex:1; }
  #herdr-panel > summary { flex-wrap:wrap; }
}
@media (prefers-reduced-motion:reduce) {
  .popup { animation:none; }
  *,*::before,*::after { transition:none !important; }
}
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
    popup.setAttribute("role", "dialog");
    popup.setAttribute("aria-label", "Annotate element");
    popup.innerHTML = `
      <div class="header">
        <span class="el-tag">${esc(elLabel(currentEl))}</span>
        <button class="close-btn" id="close" aria-label="Close annotation">×</button>
      </div>
      <div class="parent-row"><button class="parent-btn" id="parent">Parent ↑</button><button class="parent-btn" id="previous">Previous ←</button></div>
      <hr class="section-divider">
      <textarea id="comment" aria-label="Annotation comment" placeholder="Describe the issue or desired change...">${esc(comment)}</textarea>
      <hr class="section-divider">
      ${clipboardHasLastCopy ? `
      <div style="margin-bottom:10px;">
        <label style="display:flex;align-items:center;gap:6px;font-size:14px;color:var(--muted);cursor:pointer;">
          <input type="checkbox" id="append-existing" checked style="accent-color:var(--accent);">
          Add to existing annotations
        </label>
      </div>` : ""}
      <details id="herdr-panel" style="margin-bottom:12px;">
        <summary style="cursor:pointer;color:var(--muted);">
          <svg class="herdr-chevron" aria-hidden="true" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m9 6 6 6-6 6"/></svg>
          <span>Herdr Agents</span>
          <label style="margin-left:auto;display:inline-flex;align-items:center;gap:6px;cursor:pointer;"><input type="checkbox" id="herdr-enabled"> Send to Herdr</label>
        </summary>
        <div class="herdr-target-row">
          <select id="herdr-agent" aria-label="Herdr agent" style="flex:1;min-width:0;background:var(--bg2);color:var(--text);border:1px solid var(--border);border-radius:6px;padding:7px 32px 7px 10px;background-image:url('data:image/svg+xml,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22 width=%2212%22 height=%2212%22 viewBox=%220 0 12 12%22%3E%3Cpath d=%22m3 4.5 3 3 3-3%22 fill=%22none%22 stroke=%22%23888888%22 stroke-width=%221.5%22 stroke-linecap=%22round%22 stroke-linejoin=%22round%22/%3E%3C/svg%3E');background-repeat:no-repeat;background-position:right 10px center;"><option value="">Select an agent</option></select>
          <button class="btn-secondary" id="herdr-refresh">Refresh</button>
        </div>
        <div id="herdr-status" role="status" style="margin-top:8px;color:var(--muted);white-space:pre-wrap;overflow-wrap:anywhere;"></div>
      </details>
      <hr class="section-divider">
      <div class="actions">
        <button class="btn-secondary" id="cancel">Cancel</button>
        <div class="action-groups">
          <div class="action-group">
            <button class="btn-secondary" id="copy-ss-next" aria-label="Copy with screenshot and continue" title="Copy with screenshot & Next">${ICONS.camera}</button>
            <button class="btn-secondary" id="copy-next">Copy & Next</button>
          </div>
          <div class="action-group action-group-exit">
            <button class="btn-primary" id="copy-ss" aria-label="Copy with screenshot and exit" title="Copy with screenshot & Exit">${ICONS.camera}</button>
            <button class="btn-primary" id="copy">Copy & Exit</button>
          </div>
        </div>
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
    let herdrLoaded = false;
    let herdrLoading = false;
    let sendUnknown = false;
    let herdrDefaultApplied = false;
    const uploadedScreenshots = new Map();

    async function herdrRequest(operation, args = {}) {
      let response;
      try {
        response = await chrome.runtime.sendMessage({ type: "HERDR_REQUEST", operation, ...args });
      } catch (error) {
        throw Object.assign(error, { code: operation === "sendAnnotation" ? "SEND_UNKNOWN" : "BRIDGE_UNAVAILABLE" });
      }
      if (!response || response.error) {
        const error = response?.error || { code: operation === "sendAnnotation" ? "SEND_UNKNOWN" : "BRIDGE_UNAVAILABLE", message: "Herdr bridge did not respond." };
        throw Object.assign(new Error(error.message), { code: error.code });
      }
      return response.result;
    }

    function updateExitActions() {
      const send = q("#herdr-enabled").checked;
      const label = send ? "Send & Exit" : "Copy & Exit";
      q("#copy").textContent = label;
      q("#copy-ss").setAttribute("aria-label", `${send ? "Send to Herdr" : "Copy"} with screenshot and exit`);
      q("#copy-ss").title = `${send ? "Send" : "Copy"} with screenshot & Exit`;
      const disabled = submitting || (send && (herdrLoading || sendUnknown || !q("#herdr-agent").value));
      q("#copy").disabled = disabled;
      q("#copy-ss").disabled = disabled;
    }

    q("#herdr-enabled").closest("label").addEventListener("click", (e) => e.stopPropagation());
    q("#herdr-enabled").addEventListener("change", updateExitActions);

    async function loadHerdrAgents() {
      if (herdrLoading || submitting) return;
      herdrLoading = true;
      updateExitActions();
      q("#herdr-refresh").disabled = true;
      q("#herdr-status").textContent = "Connecting to Herdr…";
      try {
        const previous = q("#herdr-agent").value;
        const { agents, selected } = await herdrRequest("listAgents");
        if (popupHost !== host) return;
        q("#herdr-agent").replaceChildren(new Option("Select an agent", ""));
        agents.forEach((agent) => {
          const label = [agent.machine || "local", agent.space, agent.tab, agent.app, agent.cwd, agent.status, agent.address].filter(Boolean).join(" · ");
          const option = new Option(label, agent.address);
          option.disabled = agent.status === "blocked";
          q("#herdr-agent").appendChild(option);
        });
        const preferred = previous || selected;
        if (agents.some((agent) => agent.address === preferred && agent.status !== "blocked")) q("#herdr-agent").value = preferred;
        herdrLoaded = true;
        if (!herdrDefaultApplied && agents.length) {
          herdrDefaultApplied = true;
          q("#herdr-panel").open = true;
          q("#herdr-enabled").checked = true;
        }
        q("#herdr-status").textContent = agents.length ? "" : "No live agents found in Herdr. Open an agent and refresh.";
      } catch (error) {
        q("#herdr-status").textContent = `${error.message}\nInstall the Native Messaging bridge using native/install.cjs and this extension's ID, then refresh.`;
      } finally {
        herdrLoading = false;
        q("#herdr-refresh").disabled = false;
        updateExitActions();
        if (popupHost === host) positionPopup(host, popup, currentEl);
      }
    }

    q("#herdr-panel").addEventListener("toggle", () => {
      if (q("#herdr-panel").open && !herdrLoaded) loadHerdrAgents();
      positionPopup(host, popup, currentEl);
    });
    q("#herdr-refresh").addEventListener("click", loadHerdrAgents);
    q("#herdr-agent").addEventListener("change", () => {
      updateExitActions();
    });
    async function submitToHerdr(withScreenshot, keepAnnotating) {
      if (submitting || sendUnknown || !q("#herdr-agent").value) return;
      submitting = true;
      const terminal = q("#herdr-agent").value;
      const controls = Array.from(popup.querySelectorAll("button, select, input, textarea"));
      const disabled = controls.map((control) => control.disabled);
      controls.forEach((control) => { control.disabled = true; });
      try {
        if (withScreenshot && !currentScreenshot) {
          q("#herdr-status").textContent = "Capturing screenshot…";
          host.style.visibility = "hidden";
          try { currentScreenshot = await captureScreenshot(currentEl); }
          finally { host.style.visibility = ""; }
          if (popupHost !== host) return;
          if (!currentScreenshot) throw new Error("Screenshot failed. Please try again.");
        }
        submitAnnotation(currentEl, annotations.find((a) => a.element === currentEl) || null, false);
        const batch = annotations.map((annotation) => ({ ...annotation }));
        const paths = new Map();
        for (const annotation of batch) {
          if (!annotation.screenshot) continue;
          if ((annotation.screenshot.length - "data:image/png;base64,".length) * 3 / 4 > 8 * 1024 * 1024 + 2) {
            throw new Error("A screenshot exceeds 8 MB. Use Copy or capture a smaller element.");
          }
          q("#herdr-status").textContent = `Uploading screenshot for annotation ${annotation.id}…`;
          const cacheKey = `${terminal}:${annotation.id}`;
          let uploaded = uploadedScreenshots.get(cacheKey);
          if (!uploaded || uploaded.dataUrl !== annotation.screenshot) {
            const result = await herdrRequest("uploadAttachment", { terminal, attachmentId: Array.from(crypto.getRandomValues(new Uint8Array(16)), (byte) => byte.toString(16).padStart(2, "0")).join(""), dataUrl: annotation.screenshot });
            uploaded = { dataUrl: annotation.screenshot, path: result.path };
            uploadedScreenshots.set(cacheKey, uploaded);
          }
          paths.set(annotation.id, uploaded.path);
          if (popupHost !== host) return;
        }
        q("#herdr-status").textContent = `Submitting to ${terminal}…`;
        await herdrRequest("sendAnnotation", { terminal, markdown: exportMarkdown(batch, paths) });
        if (popupHost !== host) return;
        closePopup();
        if (!keepAnnotating) {
          annotations = [];
          syncMarkers(); updateActionState();
          stopAnnotating();
        }
      } catch (error) {
        if (error.code === "SEND_UNKNOWN") {
          sendUnknown = true;
          q("#herdr-status").textContent = "Send result unknown. Check the selected agent before sending again. Annotations have been kept.";
        } else {
          q("#herdr-status").textContent = `${error.message}\nAnnotations have been kept. You can retry or use Copy.`;
        }
      } finally {
        submitting = false;
        controls.forEach((control, i) => { control.disabled = disabled[i]; });
        updateExitActions();
      }
    }

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
    q("#copy").addEventListener("click", () => q("#herdr-enabled").checked ? submitToHerdr(false, false) : submitAndCopy(false, false));
    q("#copy-ss").addEventListener("click", () => q("#herdr-enabled").checked ? submitToHerdr(true, false) : submitAndCopy(true, false));
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
    loadHerdrAgents();
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

  function exportMarkdown(batch = annotations, screenshotPaths = null) {
    const url = window.location.href;
    const vw = window.innerWidth, vh = window.innerHeight;
    const now = new Date().toISOString();

    let md = `# Visual Feedback — ${document.title}\n`;
    md += `**URL:** ${url}\n`;
    md += `**Viewport:** ${vw}×${vh}\n`;
    md += `**Date:** ${now}\n\n`;

    if (!batch.length) { md += "*No annotations*\n"; return md; }

    md += `---\n\n`;

    const single = batch.length === 1;
    batch.forEach((a, i) => {
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
      const screenshotPath = screenshotPaths ? screenshotPaths.get(a.id) : a.screenshotPath;
      if (screenshotPath) md += `- **Screenshot:** ![screenshot-${i + 1}](${screenshotPath.replace(/ /g, "%20").replace(/\(/g, "%28").replace(/\)/g, "%29")})\n`;
      else if (a.screenshot) md += `- **Screenshot:** [image attached]\n`;
      if (a.comment) md += `- **User Request:** ${a.comment}\n`;
      if (i < batch.length - 1) md += `\n---\n\n`;
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

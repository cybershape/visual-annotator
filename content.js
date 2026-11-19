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
  const IS_TOP = window === window.top;
  const XHTML_NS = "http://www.w3.org/1999/xhtml";
  const TEXT_MAX = 200;
  const Z_HIGHLIGHT = 2147483644;
  const Z_MARKERS = 2147483645;
  const Z_POPUP = 2147483647;

  function esc(s) {
    if (s == null) return "";
    return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }

  function createHtmlEl(tag) {
    return document.createElementNS ? document.createElementNS(XHTML_NS, tag) : document.createElement(tag);
  }

  function isOurs(el) {
    if (!el) return false;
    if (el.closest?.("[data-va]")) return true;
    return false;
  }

  function isOursEvent(e) {
    if (isOurs(e.target)) return true;
    const path = typeof e.composedPath === "function" ? e.composedPath() : null;
    return Array.isArray(path) && path.some((node) => node instanceof Element && node.hasAttribute?.("data-va"));
  }

  // ─── State ───────────────────────────────────────────────────────────

  let isAnnotating = false;
  let remotePopupOpen = false;
  let hasExplicitState = false;
  let hasExplicitPopupState = false;
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
  let popupTarget = null;
  let globalStyleEl = null;
  let overlayRoot = null;
  let layerSyncFrame = null;
  const modalOrder = [];

  function isPopupOpen() {
    return !!(popupHost || remotePopupOpen);
  }

  function collectModalDialogs(deep = false) {
    if (!deep) return Array.from(document.querySelectorAll("dialog:modal"));
    const modals = [];
    const roots = [document];
    while (roots.length) {
      const root = roots.pop();
      modals.push(...root.querySelectorAll("dialog:modal"));
      for (const node of root.querySelectorAll("*")) {
        if (node.shadowRoot && !isOurs(node)) roots.push(node.shadowRoot);
      }
    }
    return modals;
  }

  function syncOverlayLayer(raise = false, deep = false) {
    if (!overlayRoot) return;
    const modals = collectModalDialogs(deep);
    for (let i = modalOrder.length - 1; i >= 0; i--) {
      const modal = modalOrder[i];
      if (!modal.isConnected || !modal.matches?.("dialog:modal")) {
        modalOrder.splice(i, 1);
      }
    }
    modals.forEach((modal) => {
      if (!modalOrder.includes(modal)) modalOrder.push(modal);
    });
    const parent = modalOrder[modalOrder.length - 1] || document.body || document.documentElement;
    if (!parent) return;
    const moved = overlayRoot.parentElement !== parent;
    if (moved) parent.appendChild(overlayRoot);
    if (typeof overlayRoot.showPopover === "function") {
      try {
        if (raise && overlayRoot.matches(":popover-open")) overlayRoot.hidePopover();
        if (!overlayRoot.matches(":popover-open")) overlayRoot.showPopover();
      } catch {}
    }
    if (moved) {
      if (IS_TOP) scheduleSyncMarkers();
      popupHost?.shadowRoot?.querySelector("#comment")?.focus({ preventScroll: true });
    }
  }

  function ensureOverlayRoot() {
    if (!overlayRoot) {
      overlayRoot = createHtmlEl("va-overlay");
      overlayRoot.setAttribute("data-va", "overlay");
      overlayRoot.setAttribute("popover", "manual");
      overlayRoot.style.cssText = `all:initial !important; display:block !important; position:fixed !important; inset:0 auto auto 0 !important; width:0 !important; height:0 !important; margin:0 !important; padding:0 !important; border:0 !important; overflow:visible !important; pointer-events:none !important; visibility:visible !important; opacity:1 !important; z-index:${Z_POPUP} !important;`;
    }
    syncOverlayLayer(false, true);
    return overlayRoot;
  }

  function onPageLayerChange(e) {
    if (isOursEvent(e)) return;
    const target = e.composedPath?.()?.[0] || e.target;
    if (target?.matches?.("dialog:modal")) {
      const index = modalOrder.indexOf(target);
      if (index !== -1) modalOrder.splice(index, 1);
      modalOrder.push(target);
    }
    if (!overlayRoot || (!isAnnotating && !popupHost) || layerSyncFrame !== null) return;
    layerSyncFrame = requestAnimationFrame(() => {
      layerSyncFrame = null;
      if (overlayRoot && (isAnnotating || popupHost)) syncOverlayLayer(true, true);
    });
  }

  document.addEventListener("beforetoggle", onPageLayerChange, true);
  document.addEventListener("toggle", onPageLayerChange, true);
  document.addEventListener("close", onPageLayerChange, true);
  if (document.documentElement) {
    new MutationObserver((records) => {
      if ((overlayRoot && !overlayRoot.isConnected && (isAnnotating || popupHost)) ||
        records.some((record) => record.target?.matches?.("dialog") ||
          Array.from(record.removedNodes).some((node) => node.nodeType === 1 &&
            (node.matches("dialog") || node.querySelector("dialog"))))) {
        onPageLayerChange({ target: document });
      }
    }).observe(document.documentElement, { subtree: true, childList: true, attributes: true, attributeFilter: ["open"] });
  }

  const POPUP_CSS = `
:host {
  all:initial; display:block; position:fixed; z-index:${Z_POPUP};
}
* { box-sizing:border-box; }
.popup {
  font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;
  --bg:#202124; --bg2:#28292d; --hover:#323338; --border:#3b3d43;
  --text:#f2f3f5; --muted:#adb0b9; --accent:#818cf8; --accent-h:#6366f1;
  --focus:rgba(129,140,248,.22); --shadow:0 16px 48px rgba(0,0,0,.32),0 2px 8px rgba(0,0,0,.2);
  color-scheme:dark;
  width:640px; max-width:calc(100vw - 16px); max-height:calc(100dvh - 16px); overflow:auto;
  background:var(--bg); border:1px solid var(--border); border-radius:16px;
  box-shadow:var(--shadow); padding:20px; font-size:14px; line-height:1.5; color:var(--text);
  scrollbar-width:thin; animation:pop .12s ease-out;
}
@media (prefers-color-scheme:light) {
  .popup {
    --bg:#fff; --bg2:#f7f8fa; --hover:#eef0f4; --border:#e2e4e9;
    --text:#23252b; --muted:#656b77; --accent:#4f46e5; --accent-h:#4338ca;
    --focus:rgba(79,70,229,.14); --shadow:0 16px 48px rgba(22,27,45,.12),0 2px 8px rgba(22,27,45,.08);
    color-scheme:light;
  }
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
html.va-annotating, html.va-annotating *, body.va-annotating, body.va-annotating * { cursor: crosshair !important; }
va-marker.va-marker {
  all: initial;
  position: fixed !important; z-index: ${Z_MARKERS} !important;
  width: 24px !important; height: 24px !important; border-radius: 50% !important;
  background: #6366f1 !important; color: #fff !important;
  font: 700 11px/24px -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif !important;
  display: flex !important; align-items: center !important; justify-content: center !important;
  cursor: pointer !important; box-shadow: 0 2px 8px rgba(99,102,241,.4) !important;
  transition: transform .15s !important; pointer-events: all !important; user-select: none !important;
  box-sizing: border-box !important;
}
va-marker.va-marker:hover { transform: scale(1.15) !important; }
va-marker.va-marker.has-screenshot { background: #22c55e !important; box-shadow: 0 2px 8px rgba(34,197,94,.4) !important; }
`;

  // ─── Icons ───────────────────────────────────────────────────────────

  const ICONS = {
    camera: `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"/><circle cx="12" cy="13" r="4"/></svg>`,
  };

  // ─── Cross-Frame Offset Resolution ───────────────────────────────────

  const pendingProjections = new Map();
  const embeddingFrames = new WeakMap();
  const frameElementIds = new WeakMap();
  const frameElements = new Map();
  const releaseFrameElement = new FinalizationRegistry((id) => frameElements.delete(id));
  let nextFrameElementId = 1;
  let nextMeasurement = 1;

  function findFrameElement(win) {
    const cached = embeddingFrames.get(win);
    if (cached?.isConnected && cached.contentWindow === win) return cached;
    const roots = [document];
    while (roots.length) {
      const root = roots.pop();
      for (const frame of root.querySelectorAll("iframe, frame")) {
        if (frame.contentWindow === win) {
          embeddingFrames.set(win, frame);
          return frame;
        }
      }
      for (const node of root.querySelectorAll("*")) {
        if (node.shadowRoot) roots.push(node.shadowRoot);
      }
    }
    return null;
  }

  function rectFromEdges(left, top, right, bottom) {
    return { left, top, right, bottom, width: right - left, height: bottom - top };
  }

  function intersectRects(a, b) {
    if (!a || !b) return null;
    const rect = rectFromEdges(Math.max(a.left, b.left), Math.max(a.top, b.top),
      Math.min(a.right, b.right), Math.min(a.bottom, b.bottom));
    return rect.width > 0 && rect.height > 0 ? rect : null;
  }

  function viewportRect() {
    return rectFromEdges(0, 0, window.innerWidth, window.innerHeight);
  }

  function frameContentGeometry(frame) {
    const bounds = frame.getBoundingClientRect();
    const style = getComputedStyle(frame);
    const pixels = (value) => parseFloat(value) || 0;
    const left = pixels(style.borderLeftWidth) + pixels(style.paddingLeft);
    const right = pixels(style.borderRightWidth) + pixels(style.paddingRight);
    const top = pixels(style.borderTopWidth) + pixels(style.paddingTop);
    const bottom = pixels(style.borderBottomWidth) + pixels(style.paddingBottom);
    const width = pixels(style.width) + (style.boxSizing === "border-box" ? 0 : left + right);
    const height = pixels(style.height) + (style.boxSizing === "border-box" ? 0 : top + bottom);
    const scaleX = width > 0 ? bounds.width / width : 0;
    const scaleY = height > 0 ? bounds.height / height : 0;
    const content = rectFromEdges(bounds.left + left * scaleX, bounds.top + top * scaleY,
      bounds.right - right * scaleX, bounds.bottom - bottom * scaleY);
    return { content, scaleX, scaleY };
  }

  function projectRect(rect, { left, top, scaleX, scaleY }) {
    if (!rect) return null;
    return rectFromEdges(left + rect.left * scaleX, top + rect.top * scaleY,
      left + rect.right * scaleX, top + rect.bottom * scaleY);
  }

  window.addEventListener("message", (e) => {
    const data = e.data;
    if (!isAnnotating || !e.isTrusted || data?.type !== "__va_project_frame" || typeof data.requestId !== "string" || !e.source || e.source === window) return;
    const frame = findFrameElement(e.source);
    if (!frame) return;
    const { content, scaleX, scaleY } = frameContentGeometry(frame);
    const origin = { left: content.left, top: content.top, scaleX, scaleY };
    const frameClip = intersectRects(content, viewportRect());
    const nested = data.projection;
    const projection = nested ? {
      left: origin.left + nested.left * scaleX,
      top: origin.top + nested.top * scaleY,
      scaleX: scaleX * nested.scaleX,
      scaleY: scaleY * nested.scaleY,
      clip: intersectRects(projectRect(nested.clip, origin), frameClip),
    } : { ...origin, clip: frameClip };
    if (IS_TOP) {
      pendingProjections.get(data.requestId)?.(projection);
    } else {
      window.parent.postMessage({ type: "__va_project_frame", requestId: data.requestId, projection }, "*");
    }
  });

  function localFrameRect(id) {
    const element = frameElements.get(id)?.deref();
    if (!element?.isConnected) return null;
    const { left, top, right, bottom } = element.getBoundingClientRect();
    return rectFromEdges(left, top, right, bottom);
  }

  function serializeFrameChain(chain) {
    return chain.map((node) => {
      let elementId = frameElementIds.get(node);
      if (!elementId) {
        elementId = nextFrameElementId++;
        frameElementIds.set(node, elementId);
        frameElements.set(elementId, new WeakRef(node));
        releaseFrameElement.register(node, elementId);
      }
      const tag = node.tagName.toLowerCase();
      const idAttr = node.id || null;
      const classes = Array.from(node.classList);
      return {
        elementId,
        label: `<${tag}${idAttr ? `#${idAttr}` : ""}${classes.length ? `.${classes.slice(0, 2).join(".")}` : ""}>`,
        selector: genSelector(node),
        tag,
        idAttr,
        classes,
        text: (node.textContent || "").slice(0, TEXT_MAX).trim().replace(/\s+/g, " "),
        url: window.location.href,
        shopifySection: detectShopifySection(node),
        keyStyles: getKeyStyles(node),
      };
    });
  }

  async function measureFrameTargets(targets) {
    const frame = targets[0];
    const revision = nextMeasurement++;
    const requestId = Array.from(crypto.getRandomValues(new Uint32Array(4))).join("-");
    targets.forEach((target) => { target.measurement = revision; });
    const projection = new Promise((resolve) => pendingProjections.set(requestId, resolve));
    const response = chrome.runtime.sendMessage({
      type: "REQUEST_FRAME_GEOMETRY",
      frameId: frame.frameId,
      documentId: frame.documentId,
      elementIds: targets.map((target) => target.elementId),
      requestId,
    }).then((result) => result?.rects ? Promise.all([projection, result.rects]) : null, () => null);
    let timer;
    const timeout = new Promise((resolve) => { timer = setTimeout(() => resolve(null), 250); });
    const measurement = await Promise.race([response, timeout]);
    clearTimeout(timer);
    pendingProjections.delete(requestId);
    targets.forEach((target, index) => {
      if (target.measurement !== revision) return;
      target.viewportRect = measurement ? projectRect(measurement[1][index], measurement[0]) : null;
      target.frameClip = measurement?.[0].clip || null;
    });
    return measurement ? {
      rect: projectRect(measurement[1][0], measurement[0]),
      clip: measurement[0].clip,
    } : null;
  }

  function sameFrameTarget(a, b) {
    return a?.frameId === b.frameId && a?.documentId === b.documentId && a?.elementId === b.elementId;
  }

  // ─── Message Handling ────────────────────────────────────────────────

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg.type === "TOGGLE_ANNOTATING") {
      hasExplicitState = true;
      if (isAnnotating) stopAnnotating(false); else startAnnotating();
    }
    if (msg.type === "SET_ANNOTATING") {
      hasExplicitState = true;
      if (msg.active) startAnnotating(); else stopAnnotating(false);
    }
    if (msg.type === "REMOTE_POPUP_STATE" && !IS_TOP) {
      hasExplicitPopupState = true;
      remotePopupOpen = msg.open === true;
      if (remotePopupOpen) {
        hideHighlight();
        hideTooltip();
      }
    }
    if (msg.type === "CLOSE_POPUP" && IS_TOP && popupHost) {
      closePopup();
    }
    if (msg.type === "READ_FRAME_GEOMETRY" && !IS_TOP && isAnnotating) {
      const rects = msg.elementIds.map(localFrameRect);
      window.parent.postMessage({ type: "__va_project_frame", requestId: msg.requestId }, "*");
      sendResponse({ rects });
    }
    if (msg.type === "OPEN_FRAME_POPUP" && IS_TOP && isAnnotating && !popupHost && msg.payload?.items?.length) {
      const items = msg.payload.items.map((item) => ({
        ...item, isRemote: true, frameId: msg.frameId, documentId: msg.documentId,
      }));
      for (let i = 0; i < items.length; i++) {
        items[i].parentTarget = items[i + 1] || null;
      }
      const target = items[0];
      const existing = annotations.find((annotation) => sameFrameTarget(annotation.remoteTarget, target));
      measureFrameTargets([target]).then(() => {
        if (isAnnotating && !popupHost && target.viewportRect) showPopup(target, existing || null);
      });
    }
    if (msg.type === "PING") sendResponse({ pong: true, active: isAnnotating, popupOpen: !!popupHost });
  });

  function startAnnotating() {
    ensureOverlayRoot();

    // Global styles
    if (!globalStyleEl) {
      globalStyleEl = createHtmlEl("style");
      globalStyleEl.id = "va-global";
      globalStyleEl.textContent = GLOBAL_CSS;
      (document.head || document.documentElement)?.appendChild(globalStyleEl);
    }

    // Highlight overlay
    if (!highlightEl) {
      highlightEl = createHtmlEl("va-highlight");
      highlightEl.setAttribute("data-va", "highlight");
      highlightEl.style.cssText = `all:initial !important; display:none !important; position:fixed !important; pointer-events:none !important; z-index:${Z_HIGHLIGHT} !important; border:2px solid rgba(99,102,241,0.7) !important; background:rgba(99,102,241,0.08) !important; border-radius:3px !important; transition:all 0.06s ease !important; box-sizing:border-box !important;`;
      overlayRoot.appendChild(highlightEl);
    }

    // Tooltip
    if (!tooltipEl) {
      tooltipEl = createHtmlEl("va-tooltip");
      tooltipEl.setAttribute("data-va", "tooltip");
      tooltipEl.style.cssText = `all:initial !important; display:none !important; position:fixed !important; pointer-events:none !important; z-index:${Z_POPUP} !important; background:#1c1c1e !important; color:#f4f4f5 !important; padding:5px 10px !important; border-radius:6px !important; font:12px ui-monospace, monospace !important; box-shadow:0 2px 8px rgba(0,0,0,.5) !important; max-width:400px !important; box-sizing:border-box !important;`;
      overlayRoot.appendChild(tooltipEl);
    }

    // Markers (top frame only)
    if (IS_TOP && !markersContainer) {
      markersContainer = createHtmlEl("va-markers");
      markersContainer.setAttribute("data-va", "markers");
      markersContainer.style.cssText = `all:initial !important; display:block !important; position:fixed !important; top:0 !important; left:0 !important; width:0 !important; height:0 !important; overflow:visible !important; pointer-events:none !important; z-index:${Z_MARKERS} !important;`;
      overlayRoot.appendChild(markersContainer);
    }

    if (IS_TOP && markersContainer) {
      markersContainer.style.setProperty("display", "block", "important");
      syncMarkers();
    }
    setAnnotating(true);
    if (IS_TOP) scheduleFrameGeometry();
  }

  function stopAnnotating(broadcast = IS_TOP) {
    setAnnotating(false);
    clearTimeout(frameGeometryTimer);
    frameGeometryTimer = null;
    remotePopupOpen = false;
    if (markersContainer) markersContainer.style.setProperty("display", "none", "important");
    closePopup();
    try {
      if (typeof overlayRoot?.hidePopover === "function" && overlayRoot.matches(":popover-open")) {
        overlayRoot.hidePopover();
      }
    } catch {}
    overlayRoot?.remove();
    if (IS_TOP && broadcast) {
      chrome.runtime.sendMessage({ type: "SET_ANNOTATING_ALL", active: false }).catch(() => {});
    }
  }

  function updateActionState() {
    if (!IS_TOP) return;
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
    document.documentElement?.classList.toggle("va-annotating", isAnnotating);
    document.body?.classList.toggle("va-annotating", isAnnotating);

    if (isAnnotating) {
      window.addEventListener("mousemove", onMouseMove, true);
      window.addEventListener("pointerdown", onPointerBlock, true);
      window.addEventListener("mousedown", onPointerBlock, true);
      window.addEventListener("pointerup", onPointerBlock, true);
      window.addEventListener("mouseup", onPointerBlock, true);
      window.addEventListener("click", onClick, true);
      window.addEventListener("wheel", onWheel, { passive: false, capture: true });
      window.addEventListener("keydown", onAnnotateKeyDown, true);
      window.addEventListener("mouseout", onWindowMouseOut, true);
    } else {
      window.removeEventListener("mousemove", onMouseMove, true);
      window.removeEventListener("pointerdown", onPointerBlock, true);
      window.removeEventListener("mousedown", onPointerBlock, true);
      window.removeEventListener("pointerup", onPointerBlock, true);
      window.removeEventListener("mouseup", onPointerBlock, true);
      window.removeEventListener("click", onClick, true);
      window.removeEventListener("wheel", onWheel, { capture: true });
      window.removeEventListener("keydown", onAnnotateKeyDown, true);
      window.removeEventListener("mouseout", onWindowMouseOut, true);
      hideHighlight();
      hideTooltip();
    }
  }

  function onPointerBlock(e) {
    if (isOursEvent(e) || isPopupOpen()) return;
    e.preventDefault();
    e.stopImmediatePropagation();
  }

  function onWindowMouseOut(e) {
    if (!e.relatedTarget && !isPopupOpen()) {
      hoverStack = [];
      stackIdx = 0;
      hideHighlight();
      hideTooltip();
    }
  }

  function buildHoverStack(el) {
    const stack = [];
    let cur = el;
    while (cur && cur !== document.body && cur !== document.documentElement) {
      if (!isOurs(cur)) stack.push(cur);
      cur = cur.parentElement;
    }
    return stack;
  }

  function resolveStackAtPoint(x, y, fallbackTarget = null) {
    if (highlightEl) highlightEl.style.setProperty("display", "none", "important");
    let el = (typeof x === "number" && typeof y === "number" && (x !== 0 || y !== 0))
      ? document.elementFromPoint(x, y)
      : null;
    if (!el && fallbackTarget instanceof Element) el = fallbackTarget;
    if (!el || el === document.body || el === document.documentElement || isOurs(el)) {
      return [];
    }
    return buildHoverStack(el);
  }

  function onMouseMove(e) {
    if (isPopupOpen()) return;
    syncOverlayLayer(false, false);
    if (isOursEvent(e)) { hoverStack = []; stackIdx = 0; hideHighlight(); hideTooltip(); return; }

    const stack = resolveStackAtPoint(e.clientX, e.clientY);
    if (!stack.length) {
      hoverStack = [];
      stackIdx = 0;
      hideHighlight();
      hideTooltip();
      return;
    }

    hoverStack = stack;
    stackIdx = 0;

    showHighlight(hoverStack[0]);
    showTooltip(hoverStack[0], e.clientX, e.clientY);
  }

  function onWheel(e) {
    if (isPopupOpen() || !hoverStack.length || isOursEvent(e)) return;
    if (!e.altKey) return;
    e.preventDefault(); e.stopImmediatePropagation();
    stackIdx = e.deltaY > 0
      ? Math.min(stackIdx + 1, hoverStack.length - 1)
      : Math.max(stackIdx - 1, 0);
    showHighlight(hoverStack[stackIdx]);
    showTooltip(hoverStack[stackIdx], e.clientX, e.clientY);
  }

  function onClick(e) {
    if (isOursEvent(e) || isPopupOpen()) return;
    e.preventDefault();
    e.stopImmediatePropagation();

    let el = hoverStack[stackIdx];
    if (!el || !document.contains(el)) {
      const isKeyboardClick = e.detail === 0 && e.clientX === 0 && e.clientY === 0;
      const fallback = isKeyboardClick && e.target instanceof Element ? e.target : null;
      const stack = fallback
        ? (!isOurs(fallback) && fallback !== document.body && fallback !== document.documentElement ? buildHoverStack(fallback) : [])
        : resolveStackAtPoint(e.clientX, e.clientY, e.target instanceof Element ? e.target : null);
      hoverStack = stack;
      stackIdx = 0;
      el = hoverStack[0];
    }
    if (!el) return;

    hideHighlight();
    hideTooltip();

    if (IS_TOP) {
      const existing = annotations.find((a) => a.element === el);
      showPopup(el, existing || null);
      return;
    }

    const chain = hoverStack.slice(Math.max(0, stackIdx));
    chrome.runtime.sendMessage({
      type: "FRAME_ELEMENT_CLICKED",
      payload: { items: serializeFrameChain(chain) },
    }).catch(() => {});
  }

  function onAnnotateKeyDown(e) {
    if (e.key === "Escape") {
      if (popupHost) {
        closePopup();
      } else if (IS_TOP) {
        stopAnnotating(true);
      } else if (remotePopupOpen) {
        chrome.runtime.sendMessage({ type: "CLOSE_POPUP" }).catch(() => {});
      } else {
        chrome.runtime.sendMessage({ type: "SET_ANNOTATING_ALL", active: false }).catch(() => {});
      }
      e.preventDefault();
      e.stopImmediatePropagation();
    }
  }

  // ─── Highlight & Tooltip ─────────────────────────────────────────────

  function getTargetRect(target) {
    if (!target) return null;
    return target.isRemote ? target.viewportRect : target.getBoundingClientRect();
  }

  function showHighlight(el) {
    const rect = getTargetRect(el);
    if (rect) setHighlightRect(rect);
  }

  function setHighlightRect(r) {
    if (!highlightEl) return;
    highlightEl.style.setProperty("display", "block", "important");
    highlightEl.style.setProperty("left", `${r.left}px`, "important");
    highlightEl.style.setProperty("top", `${r.top}px`, "important");
    highlightEl.style.setProperty("width", `${r.width}px`, "important");
    highlightEl.style.setProperty("height", `${r.height}px`, "important");
  }
  function hideHighlight() { if (highlightEl) highlightEl.style.setProperty("display", "none", "important"); }

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
    tooltipEl.style.setProperty("display", "block", "important");

    let tx = mx + 15, ty = my + 15;
    const tr = tooltipEl.getBoundingClientRect();
    if (tx + tr.width > window.innerWidth - 10) tx = mx - tr.width - 10;
    if (ty + tr.height > window.innerHeight - 10) ty = my - tr.height - 10;
    tooltipEl.style.setProperty("left", `${tx}px`, "important");
    tooltipEl.style.setProperty("top", `${ty}px`, "important");
  }
  function hideTooltip() { if (tooltipEl) tooltipEl.style.setProperty("display", "none", "important"); }

  // ─── Annotation Popup ───────────────────────────────────────────────

  let currentScreenshot = null;   // base64 for popup preview
  let currentScreenshotPath = null; // saved file path
  let lastCopiedMd = null;          // markdown from previous copy action
  let popupHighlightFrame = null;

  function showPopup(el, existing) {
    closePopup();
    if (!isAnnotating) return;
    const host = createHtmlEl("va-popup");
    try {
      popupHost = host;
      let activeExisting = existing || null;
      currentScreenshot = activeExisting?.screenshot || null;
      currentScreenshotPath = activeExisting?.screenshotPath || null;

      popupHost.setAttribute("data-va", "popup");
      const shadow = popupHost.attachShadow({ mode: "open" });

      const style = createHtmlEl("style");
      style.textContent = POPUP_CSS;
      shadow.appendChild(style);

      let currentEl = el;
      popupTarget = el;
      const elHistory = [];

      function elLabel(target) {
        if (target?.isRemote) return target.label;
        const tag = target.tagName.toLowerCase();
        const idAttr = target.id ? `#${target.id}` : "";
        const clsAttr = target.classList.length ? `.${Array.from(target.classList).slice(0, 2).join(".")}` : "";
        return `<${tag}${idAttr}${clsAttr}>`;
      }

      const comment = activeExisting?.comment || "";

      const popup = createHtmlEl("div");
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
      <div id="append-existing-slot"></div>
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

      function getParentTarget(target) {
        if (!target) return null;
        if (target.isRemote) return target.parentTarget || null;
        const parent = target.parentElement;
        if (!parent || parent === document.documentElement || parent === document.body || isOurs(parent)) return null;
        return parent;
      }

      function refreshTarget() {
        q("#parent").disabled = !getParentTarget(currentEl);
        q("#previous").disabled = elHistory.length === 0;
        q(".el-tag").textContent = elLabel(currentEl);
      }

      function findExisting(target) {
        return annotations.find((a) => target.isRemote ? sameFrameTarget(a.remoteTarget, target) : a.element === target) || null;
      }

      function switchTarget(nextEl) {
        currentEl = nextEl;
        popupTarget = nextEl;
        activeExisting = findExisting(currentEl);
        hoverStack = currentEl.isRemote ? [] : [nextEl];
        stackIdx = 0;
        currentScreenshot = null;
        currentScreenshotPath = null;
        refreshTarget();
        if (nextEl.isRemote) {
          hideHighlight();
          measureFrameTargets([nextEl]).then(() => {
            if (popupHost === host && currentEl === nextEl) positionPopup(host, popup, nextEl);
          });
        } else {
          positionPopup(host, popup, nextEl);
        }
        q("#comment")?.focus({ preventScroll: true });
      }

      q("#parent").addEventListener("click", () => {
        const parent = getParentTarget(currentEl);
        if (!parent) return;
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
            host.style.setProperty("visibility", "hidden", "important");
            try { currentScreenshot = await captureScreenshot(currentEl); }
            finally { host.style.setProperty("visibility", "visible", "important"); }
            if (popupHost !== host) return;
            if (!currentScreenshot) throw new Error("Screenshot failed. Please try again.");
          }
          const geometry = currentEl.isRemote ? await measureFrameTargets([currentEl]) : null;
          if (popupHost !== host) return;
          const rect = currentEl.isRemote ? geometry?.rect : getTargetRect(currentEl);
          if (!submitAnnotation(currentEl, activeExisting || findExisting(currentEl), rect)) {
            throw new Error("The selected element is no longer available.");
          }
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
        const controls = Array.from(popup.querySelectorAll("button, select, input, textarea"));
        const disabled = controls.map((control) => control.disabled);
        controls.forEach((control) => { control.disabled = true; });
        try {
          if (withScreenshot && !currentScreenshot) {
            host.style.setProperty("visibility", "hidden", "important");
            let dataUrl = null;
            try { dataUrl = await captureScreenshot(currentEl); }
            finally { if (popupHost === host) host.style.setProperty("visibility", "visible", "important"); }
            if (popupHost !== host) return;
            if (!dataUrl) {
              alert("Screenshot failed. Please try again.");
              return;
            }
            currentScreenshot = dataUrl;
            const path = await saveScreenshotFile(dataUrl);
            if (popupHost !== host) return;
            currentScreenshotPath = path;
          }
          const geometry = currentEl.isRemote ? await measureFrameTargets([currentEl]) : null;
          if (popupHost !== host) return;
          const rect = currentEl.isRemote ? geometry?.rect : getTargetRect(currentEl);
          if (!submitAnnotation(currentEl, activeExisting || findExisting(currentEl), rect)) {
            alert("The selected element is no longer available.");
            return;
          }
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
          controls.forEach((control, i) => { control.disabled = disabled[i]; });
          updateExitActions();
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

      host.style.cssText = `all:initial !important; display:block !important; position:fixed !important; left:0px !important; top:0px !important; width:auto !important; height:auto !important; margin:0 !important; padding:0 !important; border:0 !important; background:transparent !important; opacity:1 !important; visibility:hidden !important; pointer-events:auto !important; transform:none !important; clip-path:none !important; z-index:${Z_POPUP} !important;`;
      ensureOverlayRoot().appendChild(host);
      syncOverlayLayer(true, true);
      positionPopup(host, popup, currentEl);
      host.style.setProperty("visibility", "visible", "important");
      if (IS_TOP) {
        chrome.runtime.sendMessage({ type: "POPUP_STATE", open: true }).catch(() => {});
      }
      if (el.isRemote) scheduleFrameGeometry();
      if (lastCopiedMd && annotations.length && navigator.clipboard?.readText) {
        navigator.clipboard.readText().then((clip) => {
          if (popupHost !== host || clip !== lastCopiedMd) return;
          const slot = q("#append-existing-slot");
          if (!slot || slot.childElementCount) return;
          slot.innerHTML = `<div style="margin-bottom:10px;"><label style="display:flex;align-items:center;gap:6px;font-size:14px;color:var(--muted);cursor:pointer;"><input type="checkbox" id="append-existing" checked style="accent-color:var(--accent);">Add to existing annotations</label></div>`;
          positionPopup(host, popup, currentEl);
        }).catch(() => {});
      }
      loadHerdrAgents();
      const trackHighlight = () => {
        if (popupHost !== host) return;
        const rect = currentEl.isRemote
          ? intersectRects(getTargetRect(currentEl), currentEl.frameClip)
          : (currentEl.isConnected ? getTargetRect(currentEl) : null);
        if (isAnnotating && host.style.visibility !== "hidden" && rect) {
          setHighlightRect(rect);
        } else {
          hideHighlight();
        }
        popupHighlightFrame = requestAnimationFrame(trackHighlight);
      };
      trackHighlight();
      setTimeout(() => { if (popupHost === host) q("#comment")?.focus({ preventScroll: true }); }, 50);
    } catch (err) {
      closePopup();
      console.error("[visual-annotator] Popup failed:", err);
    }
  }

  function positionPopup(host, popup, el) {
    const rect = getTargetRect(el);
    if (!rect) return;
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
    host.style.setProperty("left", `${best.x}px`, "important");
    host.style.setProperty("top", `${best.y}px`, "important");
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
      host.style.setProperty("left", `${left}px`, "important");
      host.style.setProperty("top", `${top}px`, "important");
    });
    const stop = () => { drag = null; };
    header.addEventListener("pointerup", stop);
    header.addEventListener("pointercancel", stop);
    header.addEventListener("lostpointercapture", stop);
  }

  function closePopup() {
    const wasOpen = !!popupHost;
    if (popupHighlightFrame !== null) cancelAnimationFrame(popupHighlightFrame);
    popupHighlightFrame = null;
    hideHighlight();
    popupHost?.remove();
    popupHost = null;
    popupTarget = null;
    currentScreenshot = null;
    currentScreenshotPath = null;
    hoverStack = [];
    stackIdx = 0;
    if (wasOpen && IS_TOP) {
      chrome.runtime.sendMessage({ type: "POPUP_STATE", open: false }).catch(() => {});
    }
  }

  function submitAnnotation(el, existing, rect) {
    if (!popupHost || !rect) return false;
    const shadow = popupHost.shadowRoot;
    const comment = shadow.querySelector("#comment").value.trim();
    const pageRect = {
      x: Math.round(rect.left + window.scrollX),
      y: Math.round(rect.top + window.scrollY),
      width: Math.round(rect.width),
      height: Math.round(rect.height),
    };
    const appendExisting = shadow.querySelector("#append-existing");
    if (appendExisting && !appendExisting.checked) {
      annotations = [];
      nextId = 1;
    }

    if (existing && !annotations.includes(existing)) existing = null;

    if (existing) {
      existing.comment = comment;
      existing.screenshot = currentScreenshot;
      existing.screenshotPath = currentScreenshotPath;
      if (el.isRemote) {
        existing.remoteTarget = el;
        existing.rect = pageRect;
      }
    } else if (el.isRemote) {
      annotations.push({
        id: nextId++,
        element: null,
        remoteTarget: el,
        selector: el.selector,
        tag: el.tag,
        idAttr: el.idAttr,
        classes: el.classes,
        text: el.text,
        rect: pageRect,
        url: el.url,
        comment,
        screenshot: currentScreenshot,
        screenshotPath: currentScreenshotPath,
        shopifySection: el.shopifySection,
        keyStyles: el.keyStyles,
      });
    } else {
      annotations.push({
        id: nextId++,
        element: el,
        selector: genSelector(el),
        tag: el.tagName.toLowerCase(),
        idAttr: el.id || null,
        classes: Array.from(el.classList),
        text: (el.textContent || "").slice(0, TEXT_MAX).trim().replace(/\s+/g, " "),
        rect: pageRect,
        url: window.location.href,
        comment,
        screenshot: currentScreenshot,
        screenshotPath: currentScreenshotPath,
        shopifySection: detectShopifySection(el),
        keyStyles: getKeyStyles(el),
      });
    }

    syncMarkers();
    if (el.isRemote) scheduleFrameGeometry();
    updateActionState();
    return true;
  }

  // ─── Markers ─────────────────────────────────────────────────────────

  const markers = new Map();

  function syncMarkers() {
    if (!markersContainer) return;
    const visible = new Set();
    annotations.forEach((a, i) => {
      const target = a.element || a.remoteTarget;
      if (a.element && !a.element.isConnected) return;
      const rect = getTargetRect(target);
      const r = a.remoteTarget ? intersectRects(rect, target.frameClip) : rect;
      if (!r) return;
      visible.add(a);
      let marker = markers.get(a);
      if (!marker) {
        marker = createHtmlEl("va-marker");
        marker.className = "va-marker";
        marker.addEventListener("click", (e) => {
          e.stopPropagation();
          showPopup(a.element || a.remoteTarget, a);
        });
        markers.set(a, marker);
        markersContainer.appendChild(marker);
      }
      marker.classList.toggle("has-screenshot", !!a.screenshot);
      if (marker.textContent !== String(i + 1)) marker.textContent = String(i + 1);
      marker.style.setProperty("left", `${r.right - 12}px`, "important");
      marker.style.setProperty("top", `${r.top - 12}px`, "important");
    });
    for (const [annotation, marker] of markers) {
      if (visible.has(annotation)) continue;
      marker.remove();
      markers.delete(annotation);
    }
  }

  let frameGeometryTimer = null;
  function scheduleFrameGeometry() {
    if (!isAnnotating || frameGeometryTimer !== null) return;
    if (!popupTarget?.isRemote && !annotations.some((a) => a.remoteTarget)) return;
    frameGeometryTimer = setTimeout(async () => {
      const targetsByDocument = new Map();
      const targets = new Set(annotations.map((a) => a.remoteTarget));
      if (popupTarget?.isRemote) targets.add(popupTarget);
      targets.delete(undefined);
      for (const target of targets) {
        const key = target.documentId ?? target.frameId;
        if (!targetsByDocument.has(key)) targetsByDocument.set(key, []);
        targetsByDocument.get(key).push(target);
      }
      const timer = frameGeometryTimer;
      await Promise.all(Array.from(targetsByDocument.values(), measureFrameTargets));
      if (frameGeometryTimer !== timer) return;
      frameGeometryTimer = null;
      if (isAnnotating) {
        scheduleSyncMarkers();
        scheduleFrameGeometry();
      }
    }, 80);
  }

  let syncTimer = null;
  function scheduleSyncMarkers() {
    if (syncTimer) return;
    syncTimer = requestAnimationFrame(() => { syncTimer = null; if (isAnnotating) syncMarkers(); });
  }
  if (IS_TOP) {
    window.addEventListener("scroll", scheduleSyncMarkers, true);
    window.addEventListener("resize", scheduleSyncMarkers);
  }

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
      if (highlightEl) highlightEl.style.setProperty("display", "none", "important");
      if (tooltipEl) tooltipEl.style.setProperty("display", "none", "important");
      if (markersContainer) markersContainer.style.setProperty("display", "none", "important");

      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));

      const geometry = el.isRemote ? await measureFrameTargets([el]) : { rect: getTargetRect(el), clip: viewportRect() };
      const visible = geometry && intersectRects(geometry.rect, geometry.clip);
      if (!visible) return null;
      const pad = 20;
      const crop = intersectRects(rectFromEdges(visible.left - pad, visible.top - pad,
        visible.right + pad, visible.bottom + pad), geometry.clip);

      const resp = await chrome.runtime.sendMessage({ type: "CAPTURE_SCREENSHOT" });
      if (!resp?.dataUrl) throw new Error("No screenshot");
      return await cropToElement(resp.dataUrl, crop);
    } catch (err) {
      console.error("[visual-annotator] Screenshot failed:", err);
      return null;
    } finally {
      if (markersContainer) markersContainer.style.setProperty("display", isAnnotating ? "block" : "none", "important");
    }
  }

  function cropToElement(dataUrl, rect) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => {
        try {
          const scaleX = img.width / window.innerWidth;
          const scaleY = img.height / window.innerHeight;
          const left = Math.ceil(rect.left * scaleX);
          const top = Math.ceil(rect.top * scaleY);
          const width = Math.floor(rect.right * scaleX) - left;
          const height = Math.floor(rect.bottom * scaleY) - top;
          if (width < 1 || height < 1) { resolve(null); return; }
          const canvas = createHtmlEl("canvas");
          canvas.width = width;
          canvas.height = height;
          const ctx = canvas.getContext("2d");
          if (!ctx) { resolve(null); return; }
          ctx.drawImage(img, left, top, width, height, 0, 0, width, height);
          resolve(canvas.toDataURL("image/png"));
        } catch (error) {
          reject(error);
        }
      };
      img.onerror = () => resolve(null);
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
      const ta = createHtmlEl("textarea");
      ta.value = md; ta.style.cssText = "position:fixed;left:-9999px;top:-9999px";
      let copied = false;
      try {
        (popupHost?.shadowRoot || ensureOverlayRoot()).appendChild(ta);
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

  if (IS_TOP) {
    window.addEventListener("pageshow", updateActionState);
    updateActionState();
  } else {
    chrome.runtime.sendMessage({ type: "SYNC_CHILD_STATE" })
      .then((resp) => {
        if (!hasExplicitPopupState && resp?.popupOpen) remotePopupOpen = true;
        if (!hasExplicitState && resp?.active) startAnnotating();
      })
      .catch(() => {});
  }

})();

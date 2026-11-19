const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const { randomUUID } = require('node:crypto');

function setup(overrides = {}) {
  const listeners = [];
  const ports = [];
  const timers = new Map();
  const sentTabMessages = [];
  const executedScripts = [];
  let onClicked = null;
  let onCommand = null;
  let nextTimer = 0;
  const event = () => ({ addListener() {} });
  const runtime = {
    id: 'extension',
    onMessage: { addListener(fn) { listeners.push(fn); } },
    connectNative(name) {
      assert.equal(name, 'com.visual_annotator.herdr');
      const port = { onMessage: { addListener(fn) { port.reply = fn; } }, onDisconnect: { addListener(fn) { port.disconnect = fn; } }, postMessage(message) { port.sent.push(message); }, sent: [] };
      ports.push(port);
      return port;
    },
  };
  const chrome = {
    runtime,
    tabs: {
      onUpdated: event(),
      async sendMessage(tabId, message, options) {
        sentTabMessages.push({ tabId, message, options });
        if (overrides.onTabSendMessage) return overrides.onTabSendMessage(tabId, message, options);
        return {};
      },
      async query(queryInfo) {
        if (overrides.onTabsQuery) return overrides.onTabsQuery(queryInfo);
        return [];
      },
    },
    scripting: {
      async executeScript(details) {
        executedScripts.push(details);
      },
    },
    action: {
      onClicked: { addListener(fn) { onClicked = fn; } },
      setBadgeText: async () => {},
      setBadgeBackgroundColor: async () => {},
      setBadgeTextColor: async () => {},
      setTitle: async () => {},
    },
    commands: {
      onCommand: { addListener(fn) { onCommand = fn; } },
    },
    storage: { local: { get: async () => ({ herdrTarget: 't1' }), set: async () => {} } },
  };
  vm.runInNewContext(fs.readFileSync(`${__dirname}/background.js`, 'utf8'), { chrome, crypto: { randomUUID }, setTimeout(fn, ms) { const id = ++nextTimer; timers.set(id, fn); if (ms <= 200) queueMicrotask(fn); return id; }, clearTimeout(id) { timers.delete(id); }, console });
  const send = (message, sender = { id: 'extension', tab: { id: 1 }, frameId: 0 }) => new Promise(resolve => listeners[0]({ type: 'HERDR_REQUEST', ...message }, sender, resolve));
  const sendContent = (message, sender = { id: 'extension', tab: { id: 1 }, frameId: 0 }) => new Promise(resolve => {
    const handled = listeners[1](message, sender, resolve);
    if (!handled) resolve(undefined);
  });
  const flush = () => new Promise(resolve => setImmediate(resolve));
  return { send, sendContent, flush, ports, runtime, timers, sentTabMessages, executedScripts, triggerAction: (tab) => onClicked(tab), triggerCommand: (cmd) => onCommand(cmd) };
}

test('rejects other sources and unsupported operations before starting a host', async () => {
  const env = setup();
  const wrongSource = await env.send({ operation: 'listAgents' }, { id: 'other' });
  assert.equal(wrongSource.error.code, 'INVALID_SOURCE');
  const invalid = await env.send({ operation: 'execute', terminal: 't1' });
  assert.equal(invalid.error.code, 'INVALID_OPERATION');
  assert.equal(env.ports.length, 0);
});

test('lists agents and restores target through one native connection', async () => {
  const env = setup();
  const pending = env.send({ operation: 'listAgents' });
  const port = env.ports[0];
  const request = port.sent[0];
  port.reply({ version: 1, requestId: request.requestId, result: { agents: [{ address: 't1' }] } });
  const response = await pending;
  assert.equal(response.result.selected, 't1');
  assert.equal(response.result.agents[0].address, 't1');
  assert.equal(request.operation, 'listAgents');
});

test('current Herdr agent takes precedence over the remembered target', async () => {
  const env = setup();
  const pending = env.send({ operation: 'listAgents' });
  const port = env.ports[0];
  port.reply({ version: 1, requestId: port.sent[0].requestId, result: { agents: [{ address: 't2' }], selected: 't2' } });
  assert.equal((await pending).result.selected, 't2');
});

test('disconnect after submission is unknown and never retried', async () => {
  const env = setup();
  const pending = env.send({ operation: 'sendAnnotation', terminal: 'remote/t1', markdown: '中文\nannotation' });
  const port = env.ports[0];
  env.runtime.lastError = { message: 'Disconnected' };
  port.disconnect();
  const response = await pending;
  assert.equal(response.error.code, 'SEND_UNKNOWN');
  assert.equal(port.sent.length, 1);
  assert.equal(env.ports.length, 1);
});

test('an old idle connection cannot reject a new connection request', async () => {
  const env = setup();
  const first = env.send({ operation: 'listAgents' });
  const oldPort = env.ports[0];
  oldPort.reply({ version: 1, requestId: oldPort.sent[0].requestId, result: { agents: [] } });
  await first;
  let delayedDisconnect;
  const onOldDisconnect = oldPort.disconnect;
  oldPort.disconnect = () => { delayedDisconnect = true; };
  const idle = [...env.timers.values()][0];
  idle();
  assert.equal(delayedDisconnect, true);
  const second = env.send({ operation: 'listAgents' });
  const newPort = env.ports[1];
  onOldDisconnect();
  newPort.reply({ version: 1, requestId: newPort.sent[0].requestId, result: { agents: [{ address: 't2' }] } });
  assert.equal((await second).result.agents[0].address, 't2');
});

test('oversized attachments never reach native host', async () => {
  const env = setup();
  const response = await env.send({ operation: 'uploadAttachment', terminal: 't1', attachmentId: 'image', dataUrl: 'data:image/png;base64,' + 'a'.repeat(12 * 1024 * 1024) });
  assert.equal(response.error.code, 'INVALID_ATTACHMENT');
  assert.equal(env.ports.length, 0);
});

test('toggleAnnotations injects allFrames on missing content script and toggles based on top frame state', async () => {
  let injected = false;
  const env = setup({
    async onTabSendMessage(_tabId, message, options) {
      if (message.type === 'PING' && options?.frameId === 0) {
        if (!injected) throw new Error('Receiving end does not exist');
        return { pong: true, active: true };
      }
      return {};
    },
  });
  env.triggerAction({ id: 7, url: 'https://example.com' });
  await env.flush();
  injected = true;
  assert.equal(env.executedScripts.length, 1);
  assert.equal(env.executedScripts[0].target.tabId, 7);
  assert.equal(env.executedScripts[0].target.allFrames, true);
  assert.equal(env.sentTabMessages.at(-1).tabId, 7);
  assert.equal(env.sentTabMessages.at(-1).message.type, 'SET_ANNOTATING');
  assert.equal(env.sentTabMessages.at(-1).message.active, true);

  env.triggerAction({ id: 7, url: 'https://example.com' });
  await env.flush();
  assert.equal(env.sentTabMessages.at(-1).message.type, 'SET_ANNOTATING');
  assert.equal(env.sentTabMessages.at(-1).message.active, false);
});

test('serializes simultaneous toggles for the same tab', async () => {
  let active = false;
  const env = setup({
    async onTabSendMessage(_tabId, message) {
      if (message.type === 'PING') return { active };
      if (message.type === 'SET_ANNOTATING') active = message.active;
      return {};
    },
    async onTabsQuery() {
      return [{ id: 7, url: 'https://example.com' }];
    },
  });
  env.triggerAction({ id: 7, url: 'https://example.com' });
  await env.triggerCommand('toggle-toolbar');
  await env.flush();
  assert.deepEqual(env.sentTabMessages.flatMap(({ message }) => message.type === 'SET_ANNOTATING' ? [message.active] : []), [true, false]);
  assert.equal(active, false);
});

test('routes child frame state sync, element clicks, and popup state across frames', async () => {
  const env = setup({
    async onTabSendMessage(_tabId, message, options) {
      if (message.type === 'PING' && options?.frameId === 0) return { pong: true, active: true, popupOpen: true };
      if (message.type === 'READ_FRAME_GEOMETRY') return { rects: [{ left: 12, top: 34 }] };
      return {};
    },
    async onTabsQuery(q) {
      return q.lastFocusedWindow ? [{ id: 9, url: 'https://example.com' }] : [];
    },
  });
  const sync = await env.sendContent({ type: 'SYNC_CHILD_STATE' }, { id: 'extension', tab: { id: 3 }, frameId: 5 });
  assert.equal(sync.active, true);
  assert.equal(sync.popupOpen, true);

  const fwd = await env.sendContent({ type: 'FRAME_ELEMENT_CLICKED', payload: { items: [{ label: '<button>' }] } }, { id: 'extension', tab: { id: 3 }, frameId: 5, documentId: 'frame-document' });
  assert.equal(fwd.ok, true);
  assert.equal(env.sentTabMessages.at(-1).tabId, 3);
  assert.equal(env.sentTabMessages.at(-1).message.type, 'OPEN_FRAME_POPUP');
  assert.equal(env.sentTabMessages.at(-1).message.frameId, 5);
  assert.equal(env.sentTabMessages.at(-1).message.documentId, 'frame-document');
  assert.equal(env.sentTabMessages.at(-1).options.frameId, 0);

  const geometry = await env.sendContent({ type: 'REQUEST_FRAME_GEOMETRY', frameId: 5, documentId: 'frame-document', elementIds: [1], requestId: 'geometry-1' }, { id: 'extension', tab: { id: 3 }, frameId: 0 });
  assert.deepEqual(geometry.rects, [{ left: 12, top: 34 }]);
  assert.equal(env.sentTabMessages.at(-1).message.type, 'READ_FRAME_GEOMETRY');
  assert.equal(env.sentTabMessages.at(-1).options.frameId, 5);
  assert.equal(env.sentTabMessages.at(-1).options.documentId, 'frame-document');

  await env.sendContent({ type: 'POPUP_STATE', open: true }, { id: 'extension', tab: { id: 3 }, frameId: 0 });
  assert.equal(env.sentTabMessages.at(-1).tabId, 3);
  assert.equal(env.sentTabMessages.at(-1).message.type, 'REMOTE_POPUP_STATE');
  assert.equal(env.sentTabMessages.at(-1).message.open, true);

  await env.sendContent({ type: 'CLOSE_POPUP' }, { id: 'extension', tab: { id: 3 }, frameId: 5 });
  assert.equal(env.sentTabMessages.at(-1).tabId, 3);
  assert.equal(env.sentTabMessages.at(-1).message.type, 'CLOSE_POPUP');
  assert.equal(env.sentTabMessages.at(-1).options.frameId, 0);

  await env.sendContent({ type: 'SET_ANNOTATING_ALL', active: false }, { id: 'extension', tab: { id: 3 }, frameId: 5 });
  assert.equal(env.sentTabMessages.at(-1).tabId, 3);
  assert.equal(env.sentTabMessages.at(-1).message.type, 'SET_ANNOTATING');
  assert.equal(env.sentTabMessages.at(-1).message.active, false);
  assert.equal(env.sentTabMessages.at(-1).options, undefined);

  await env.triggerCommand('toggle-toolbar');
  await env.flush();
  assert.equal(env.sentTabMessages.at(-1).tabId, 9);
  assert.equal(env.sentTabMessages.at(-1).message.type, 'SET_ANNOTATING');
  assert.equal(env.sentTabMessages.at(-1).message.active, false);
});

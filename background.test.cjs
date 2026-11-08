const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const { randomUUID } = require('node:crypto');

function setup() {
  const listeners = [];
  const ports = [];
  const timers = new Map();
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
  const chrome = { runtime, tabs: { onUpdated: event() }, action: { onClicked: event() }, commands: { onCommand: event() }, storage: { local: { get: async () => ({ herdrTarget: 't1' }), set: async () => {} } } };
  vm.runInNewContext(fs.readFileSync(`${__dirname}/background.js`, 'utf8'), { chrome, crypto: { randomUUID }, setTimeout(fn) { const id = ++nextTimer; timers.set(id, fn); return id; }, clearTimeout(id) { timers.delete(id); } });
  const send = (message, sender = { id: 'extension', tab: { id: 1 }, frameId: 0 }) => new Promise(resolve => listeners[0]({ type: 'HERDR_REQUEST', ...message }, sender, resolve));
  return { send, ports, runtime, timers };
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

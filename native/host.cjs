'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { createHash } = require('node:crypto');
const { TextDecoder } = require('node:util');
const MAX_ATTACHMENT = 8 * 1024 * 1024;
const MAX_INPUT = 12 * 1024 * 1024;
const MAX_OUTPUT = 1024 * 1024 - 1;
const MAX_RPC = 16 * 1024 * 1024;
const TIMEOUT = 30000;
const fail = (code, message) => Object.assign(new Error(message), { code });
const hash = value => createHash('sha256').update(value).digest('hex');
const text = (value, max = 512) => typeof value === 'string' && value.length > 0 && value.length <= max;

function command(executable, args, timeout = TIMEOUT) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    const output = [];
    let size = 0, settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true; clearTimeout(timer);
      if (error) { child.kill(); reject(error); } else resolve(value);
    };
    const timer = setTimeout(() => finish(fail('DEPENDENCY_TIMEOUT', 'Dependency timed out')), timeout);
    child.on('error', () => finish(fail('DEPENDENCY_MISSING', 'Cannot start dependency')));
    child.stdout.on('data', chunk => {
      size += chunk.length;
      if (size > MAX_RPC) return finish(fail('DEPENDENCY_OUTPUT', 'Dependency output exceeds limit'));
      output.push(chunk);
    });
    child.stderr.resume();
    child.on('close', code => {
      if (code !== 0) return finish(fail('DEPENDENCY_FAILED', `Dependency exited with ${code}`));
      try { finish(null, JSON.parse(Buffer.concat(output).toString('utf8'))); } catch { finish(fail('DEPENDENCY_OUTPUT', 'Dependency returned invalid JSON')); }
    });
  });
}

function rpc(executable, method, params, timeout = TIMEOUT) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, ['connect'], { stdio: ['pipe', 'pipe', 'pipe'] });
    let buffer = Buffer.alloc(0), submitted = false, settled = false, ready = false;
    const uncertain = message => fail(submitted && method === 'terminal.send' ? 'SEND_UNKNOWN' : 'RPC_FAILED', message);
    const finish = (error, value) => {
      if (settled) return;
      settled = true; clearTimeout(timer); child.stdin.destroy(); child.kill();
      if (error) reject(error); else resolve(value);
    };
    const timer = setTimeout(() => finish(uncertain('Core response timed out')), timeout);
    child.on('error', () => finish(uncertain('Cannot start hc connect')));
    child.on('close', () => finish(uncertain('hc connect closed before a response')));
    child.stdin.on('error', () => finish(uncertain('hc connect input closed')));
    child.stderr.resume();
    const write = (id, name, values) => child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method: name, params: values }) + '\n');
    child.stdout.on('data', chunk => {
      if (settled) return;
      if (buffer.length + chunk.length > MAX_RPC) return finish(uncertain('Core response exceeds limit'));
      buffer = Buffer.concat([buffer, chunk]);
      let end;
      while (!settled && (end = buffer.indexOf(10)) !== -1) {
        const line = buffer.subarray(0, end); buffer = buffer.subarray(end + 1);
        let message;
        try { message = JSON.parse(line.toString('utf8')); } catch { return finish(uncertain('Invalid core response')); }
        if (message.jsonrpc !== '2.0') return finish(uncertain('Invalid JSON-RPC envelope'));
        if (message.id !== (ready ? 2 : 1)) continue;
        if (message.error) {
          const kind = message.error.data?.kind;
          const knownRejection = ['not_found', 'machine_unknown', 'finished', 'unavailable', 'blocked', 'status_mismatch', 'invalid_params', 'config'].includes(kind);
          return finish(fail(submitted && method === 'terminal.send' && !knownRejection ? 'SEND_UNKNOWN' : `CORE_${String(kind || 'ERROR').toUpperCase()}`, String(message.error.message || 'Core rejected request')));
        }
        if (!Object.hasOwn(message, 'result')) return finish(uncertain('Missing core result'));
        if (!ready) {
          const hello = message.result;
          if (hello?.generation !== 1 || hello.framed !== false || !hello.methods?.includes(method)) return finish(fail('PROTOCOL_UNSUPPORTED', 'Core protocol or method is unsupported'));
          ready = true;
          submitted = true;
          write(2, method, params);
        } else {
          if (method === 'terminal.send' && (!message.result || !Number.isSafeInteger(message.result.turn))) return finish(uncertain('Invalid send result'));
          finish(null, message.result);
        }
      }
    });
    write(1, 'hello', { generation: 1 });
  });
}

class BoundedCache {
  constructor(limit, bytes) { this.limit = limit; this.bytes = bytes; this.used = 0; this.items = new Map(); }
  get(key) { return this.items.get(key)?.value; }
  set(key, value) {
    const size = Buffer.byteLength(JSON.stringify(value));
    if (size > this.bytes) return;
    if (this.items.has(key)) { this.used -= this.items.get(key).size; this.items.delete(key); }
    while (this.items.size >= this.limit || this.used + size > this.bytes) {
      const oldest = this.items.keys().next().value;
      this.used -= this.items.get(oldest).size; this.items.delete(oldest);
    }
    this.items.set(key, { value, size }); this.used += size;
  }
}

function createHost(config, dependencies = {}) {
  for (const key of ['node', 'hc', 'herdr']) if (!path.isAbsolute(config[key] || '')) throw fail('CONFIG_INVALID', `Absolute ${key} path required`);
  const run = dependencies.command || command;
  const call = dependencies.rpc || rpc;
  const requests = new BoundedCache(128, 4 * 1024 * 1024);
  const attachments = new BoundedCache(128, 256 * 1024);
  async function agents() {
    const [layout, core] = await Promise.all([run(config.herdr, ['ls']), run(config.hc, ['ls', '--json'])]);
    if (!Array.isArray(layout.spaces) || !Array.isArray(core.terminals)) throw fail('DEPENDENCY_OUTPUT', 'Invalid terminal list');
    const live = new Map(core.terminals.map(t => [t.address, t]));
    const found = new Map();
    for (const space of layout.spaces) for (const tab of space.tabs || []) for (const pane of tab.terminals || []) {
      const address = pane.terminal;
      const t = live.get(address);
      if (!t || t.state !== 'live' || !text(t.agent) || !text(t.status) || /^(?:.*[\\/])?(?:ba|z|fi|da|k|c|tc)?sh(?:\.exe)?$|^(?:pwsh|powershell|cmd|nu)(?:\.exe)?$/i.test(t.agent)) continue;
      found.set(address, { address, space: space.name || '', tab: tab.name || '', app: t.agent, cwd: t.cwd || '', status: t.status, machine: address.includes('/') ? address.slice(0, address.lastIndexOf('/')) : null });
    }
    return { agents: [...found.values()] };
  }
  async function target(terminal) {
    if (!text(terminal, 256)) throw fail('INVALID_REQUEST', 'terminal must be an explicit address');
    const selected = (await agents()).agents.find(t => t.address === terminal);
    if (!selected) throw fail('TARGET_UNAVAILABLE', 'Target is no longer a live agent in this Herdr context');
    if (selected.status === 'blocked') throw fail('TARGET_BLOCKED', 'Target is blocked');
    return selected;
  }
  async function execute(request) {
    switch (request.operation) {
      case 'health': {
        const hello = await call(config.hc, 'server.status', {});
        await run(config.herdr, ['ls']);
        return { host: 'com.visual_annotator.herdr', protocolVersion: 1, core: hello, context: { HERDR_APP_HOME: process.env.HERDR_APP_HOME || null, HC_SESSION: process.env.HC_SESSION || null } };
      }
      case 'listAgents': {
        const [result, status] = await Promise.all([agents(), run(config.herdr, ['status'])]);
        const selected = result.agents.find(agent => agent.address === status.agent && agent.status !== 'blocked')?.address || null;
        return { ...result, selected };
      }
      case 'uploadAttachment': {
        if (!text(request.attachmentId, 128) || !/^[a-zA-Z0-9_-]+$/.test(request.attachmentId)) throw fail('INVALID_REQUEST', 'Invalid attachmentId');
        if (!text(request.dataUrl, MAX_INPUT)) throw fail('INVALID_ATTACHMENT', 'Expected image data URL');
        const match = /^data:image\/(png|jpeg|webp|gif);base64,([A-Za-z0-9+/]*={0,2})$/.exec(request.dataUrl);
        if (!match || !match[2] || match[2].length % 4 !== 0) throw fail('INVALID_ATTACHMENT', 'Expected canonical base64 image (png/jpeg/webp/gif)');
        const data = match[2];
        const bytes = data.length / 4 * 3 - (data.endsWith('==') ? 2 : data.endsWith('=') ? 1 : 0);
        if (bytes > MAX_ATTACHMENT) throw fail('ATTACHMENT_TOO_LARGE', 'Attachment exceeds 8 MiB');
        if (Buffer.from(data, 'base64').toString('base64') !== data) throw fail('INVALID_ATTACHMENT', 'Noncanonical base64');
        await target(request.terminal);
        const key = JSON.stringify([request.terminal, request.attachmentId]);
        const digest = hash(request.dataUrl);
        const cached = attachments.get(key);
        if (cached) {
          if (cached.digest !== digest) throw fail('ATTACHMENT_CONFLICT', 'attachmentId already contains different data');
          return cached.result;
        }
        const uploaded = await call(config.hc, 'terminal.put', { terminal: request.terminal, name: `${request.attachmentId}.${match[1] === 'jpeg' ? 'jpg' : match[1]}`, data });
        if (!text(uploaded?.path, 16384)) throw fail('RPC_FAILED', 'Core returned no attachment path');
        const result = { attachmentId: request.attachmentId, path: uploaded.path };
        attachments.set(key, { digest, result });
        return result;
      }
      case 'sendAnnotation':
        if (!text(request.markdown, 1024 * 1024)) throw fail('INVALID_REQUEST', 'markdown must contain 1–1048576 characters');
        await target(request.terminal);
        return call(config.hc, 'terminal.send', { terminal: request.terminal, text: request.markdown });
      default: throw fail('INVALID_OPERATION', 'Unsupported operation');
    }
  }
  return async request => {
    const requestId = text(request?.requestId, 128) ? request.requestId : null;
    const envelope = value => ({ version: 1, requestId, ...value });
    if (!request || Array.isArray(request) || request.version !== 1 || requestId === null || !text(request.operation, 64)) return envelope({ error: { code: 'INVALID_REQUEST', message: 'Expected version:1, requestId (1–128 characters), operation and top-level parameters' } });
    const digest = hash(JSON.stringify(request));
    const cached = requests.get(requestId);
    if (cached) return cached.digest === digest ? cached.response : envelope({ error: { code: 'REQUEST_ID_CONFLICT', message: 'requestId reused for a different request' } });
    let response;
    try { response = envelope({ result: await execute(request) }); }
    catch (error) { response = envelope({ error: { code: typeof error.code === 'string' ? error.code : 'HOST_ERROR', message: error.message || 'Host failed' } }); }
    if (Buffer.byteLength(JSON.stringify(response)) > MAX_OUTPUT) response = envelope({ error: { code: request.operation === 'sendAnnotation' ? 'SEND_UNKNOWN' : 'RESPONSE_TOO_LARGE', message: 'Response exceeds native messaging limit' } });
    requests.set(requestId, { digest, response });
    return response;
  };
}

async function serve(input, output, handle) {
  let header = Buffer.alloc(4), headerBytes = 0, body = null, bodyBytes = 0;
  for await (const chunk of input) {
    let offset = 0;
    while (offset < chunk.length) {
      if (body === null) {
        const count = Math.min(4 - headerBytes, chunk.length - offset);
        chunk.copy(header, headerBytes, offset, offset + count); offset += count; headerBytes += count;
        if (headerBytes !== 4) continue;
        const size = header.readUInt32LE(0);
        if (!size || size > MAX_INPUT) throw fail('INVALID_FRAME', 'Invalid native message length');
        body = Buffer.allocUnsafe(size); bodyBytes = 0;
      }
      const count = Math.min(body.length - bodyBytes, chunk.length - offset);
      chunk.copy(body, bodyBytes, offset, offset + count); offset += count; bodyBytes += count;
      if (bodyBytes !== body.length) continue;
      let request;
      try { request = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(body)); }
      catch { throw fail('INVALID_FRAME', 'Invalid UTF-8 JSON'); }
      body = null; headerBytes = 0;
      const response = Buffer.from(JSON.stringify(await handle(request)));
      if (response.length > MAX_OUTPUT) throw fail('RESPONSE_TOO_LARGE', 'Response exceeds native messaging limit');
      const length = Buffer.alloc(4); length.writeUInt32LE(response.length);
      await new Promise((resolve, reject) => output.write(Buffer.concat([length, response]), error => error ? reject(error) : resolve()));
    }
  }
  if (headerBytes || body !== null) throw fail('INVALID_FRAME', 'Truncated native message');
}

if (require.main === module) {
  (async () => {
    const config = JSON.parse(fs.readFileSync(process.argv[2] || path.join(__dirname, 'config.json'), 'utf8'));
    await serve(process.stdin, process.stdout, createHost(config));
  })().catch(error => { process.stderr.write(`visual-annotator: ${error.code || 'HOST_ERROR'}: ${error.message}\n`); process.exitCode = 1; process.stdin.destroy(); });
}
module.exports = { createHost, serve, rpc, command, BoundedCache, MAX_INPUT, MAX_OUTPUT, MAX_ATTACHMENT };

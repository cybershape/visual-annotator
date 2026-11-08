'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Readable, Writable } = require('node:stream');
const { createHost, serve, rpc, command, BoundedCache, MAX_INPUT, MAX_ATTACHMENT } = require('./host.cjs');
const { install, options, NAME } = require('./install.cjs');
const config = { node: process.execPath, hc: '/mock/hc', herdr: '/mock/herdr-app' };
const request = (operation, extra = {}) => ({ version: 1, requestId: 'r1', operation, ...extra });
const layout = { spaces: [{ name: '项目', machine: 'remote', tabs: [{ name: 'one', terminals: [{ terminal: 'remote/t1', app: 'old' }, { terminal: 't2', app: 'maki' }, { terminal: 't3' }] }] }] };
const terminals = [{ address: 'remote/t1', agent: 'maki', state: 'live', status: 'working', cwd: '/work' }, { address: 't2', agent: 'zsh', state: 'live', status: 'done' }, { address: 't3', agent: 'maki', state: 'finished', status: 'done' }];
function setup(overrides = {}) {
  const calls = [];
  const host = createHost(config, {
    command: async (exe, args) => { calls.push([exe, args]); return exe === config.herdr ? (args[0] === 'status' ? { agent: 'remote/t1' } : layout) : { terminals }; },
    rpc: async (exe, method, params) => { calls.push([method, params]); return method === 'terminal.put' ? { path: '/remote/a.png' } : { turn: 9, status: 'working', started: false }; },
    ...overrides,
  });
  return { host, calls };
}
function frame(value) { const body = Buffer.from(JSON.stringify(value)); const prefix = Buffer.alloc(4); prefix.writeUInt32LE(body.length); return Buffer.concat([prefix, body]); }
async function framed(chunks, handle) {
  const output = [];
  await serve(Readable.from(chunks), new Writable({ write(chunk, encoding, done) { output.push(Buffer.from(chunk)); done(); } }), handle);
  const buffer = Buffer.concat(output), results = [];
  for (let offset = 0; offset < buffer.length;) { const size = buffer.readUInt32LE(offset); offset += 4; results.push(JSON.parse(buffer.subarray(offset, offset + size))); offset += size; }
  return results;
}

test('live agents use exact remote addresses and core state, never cached app', async () => {
  const { host } = setup();
  assert.deepEqual((await host(request('listAgents'))).result, { agents: [{ address: 'remote/t1', space: '项目', tab: 'one', app: 'maki', cwd: '/work', status: 'working', machine: 'remote' }], selected: 'remote/t1' });
});
test('version, IDs, operations and explicit target validation', async () => {
  const { host } = setup();
  assert.equal((await host({ version: 2 })).error.code, 'INVALID_REQUEST');
  assert.equal((await host(request('other'))).error.code, 'INVALID_OPERATION');
  assert.equal((await host(request('sendAnnotation', { requestId: 'r2', terminal: 't2', markdown: 'hello' }))).error.code, 'TARGET_UNAVAILABLE');
});
test('send revalidates, preserves core result, has no force and deduplicates', async () => {
  const { host, calls } = setup();
  const req = request('sendAnnotation', { terminal: 'remote/t1', markdown: '多行\n`hello` $(literal)' });
  const first = await host(req);
  assert.deepEqual(first.result, { turn: 9, status: 'working', started: false });
  assert.deepEqual(await host(req), first);
  assert.deepEqual(calls.filter(c => c[0] === 'terminal.send'), [['terminal.send', { terminal: 'remote/t1', text: req.markdown }]]);
  assert.equal((await host({ ...req, markdown: 'different' })).error.code, 'REQUEST_ID_CONFLICT');
  await host({ ...req, requestId: 'next' });
  assert.equal(calls.filter(c => c[0] === config.hc).length, 2);
});
test('blocked targets and missing dependencies stop before send', async () => {
  const blocked = setup({ command: async exe => exe === config.herdr ? layout : { terminals: [{ ...terminals[0], status: 'blocked' }] } });
  assert.equal((await blocked.host(request('sendAnnotation', { terminal: 'remote/t1', markdown: 'x' }))).error.code, 'TARGET_BLOCKED');
  const broken = setup({ command: async () => { throw Object.assign(new Error('offline'), { code: 'DEPENDENCY_FAILED' }); } });
  assert.equal((await broken.host(request('listAgents'))).error.code, 'DEPENDENCY_FAILED');
});
test('upload uses put, bounds raw bytes, caches metadata and detects conflicts', async () => {
  const { host, calls } = setup();
  const req = request('uploadAttachment', { terminal: 'remote/t1', attachmentId: 'shot_1', dataUrl: 'data:image/png;base64,YQ==' });
  assert.deepEqual((await host(req)).result, { attachmentId: 'shot_1', path: '/remote/a.png' });
  assert.deepEqual((await host({ ...req, requestId: 'next' })).result, { attachmentId: 'shot_1', path: '/remote/a.png' });
  assert.equal(calls.filter(c => c[0] === 'terminal.put').length, 1);
  assert.deepEqual(calls.find(c => c[0] === 'terminal.put')[1], { terminal: 'remote/t1', name: 'shot_1.png', data: 'YQ==' });
  assert.equal((await host({ ...req, requestId: 'conflict', dataUrl: 'data:image/png;base64,Yg==' })).error.code, 'ATTACHMENT_CONFLICT');
  assert.equal((await host({ ...req, requestId: 'invalid', dataUrl: 'data:image/png;base64,Y===' })).error.code, 'INVALID_ATTACHMENT');
  assert.equal((await host({ ...req, requestId: 'large', dataUrl: 'data:image/png;base64,' + Buffer.alloc(MAX_ATTACHMENT + 1).toString('base64') })).error.code, 'ATTACHMENT_TOO_LARGE');
});
test('native frames handle split headers, split unicode, multiple messages and malformed input', async () => {
  const { host } = setup();
  const buffer = Buffer.concat([frame(request('listAgents')), frame(request('listAgents', { requestId: 'r2' }))]);
  const results = await framed([buffer.subarray(0, 1), buffer.subarray(1, 7), buffer.subarray(7)], host);
  assert.equal(results.length, 2); assert.equal(results[0].result.agents[0].space, '项目');
  for (const size of [0, MAX_INPUT + 1]) { const header = Buffer.alloc(4); header.writeUInt32LE(size); await assert.rejects(framed([header], host), { code: 'INVALID_FRAME' }); }
  await assert.rejects(framed([buffer.subarray(0, 6)], host), { code: 'INVALID_FRAME' });
  await assert.rejects(framed([Buffer.from([1, 0, 0, 0, 255])], host), { code: 'INVALID_FRAME' });
});
test('bounded cache evicts oldest entries', () => {
  const cache = new BoundedCache(2, 50); cache.set('a', 1); cache.set('b', 2); cache.set('c', 3);
  assert.equal(cache.get('a'), undefined); assert.equal(cache.items.size, 2);
});

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'va-native-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const script = path.join(dir, 'hc');
  fs.writeFileSync(script, `#!${process.execPath}\n'use strict';
if(process.argv.includes('--version')) { console.log('mock 1'); process.exit(0); }
if(process.argv[2]!=='connect'||process.argv.length!==3) process.exit(4);
let buffer='';process.stdin.on('data',chunk=>{buffer+=chunk;let n;while((n=buffer.indexOf('\\n'))>=0){const r=JSON.parse(buffer.slice(0,n));buffer=buffer.slice(n+1);if(r.method==='hello'){process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:r.id,result:{generation:1,framed:false,methods:['terminal.send','terminal.put','server.status']}})+'\\n');}else if(r.params.text==='disconnect'){process.exit(0);}else if(r.params.text==='hang'){}else if(r.params.text==='blocked'){process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:r.id,error:{code:-32000,message:'blocked',data:{kind:'blocked'}}})+'\\n');}else{process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:999,result:{ignored:true}})+'\\n');const result=r.method==='terminal.put'?{path:'/remote/file.png',bytes:1}:{turn:4,status:'working',started:false};const line=JSON.stringify({jsonrpc:'2.0',id:r.id,result})+'\\n';process.stdout.write(line.slice(0,8));setTimeout(()=>process.stdout.write(line.slice(8)),2);}}});\n`, { mode: 0o700 });
  return { dir, script };
}
test('actual mock subprocess JSON-RPC hello, multiline content, remote upload, disconnect and timeout', async t => {
  const { script } = fixture(t);
  assert.deepEqual(await rpc(script, 'terminal.send', { terminal: 'remote/t1', text: '中文\nhello' }), { turn: 4, status: 'working', started: false });
  assert.equal((await rpc(script, 'terminal.put', { terminal: 'remote/t1', data: 'YQ==', name: 'x.png' })).path, '/remote/file.png');
  await assert.rejects(rpc(script, 'terminal.send', { text: 'disconnect' }), { code: 'SEND_UNKNOWN' });
  await assert.rejects(rpc(script, 'terminal.send', { text: 'hang' }, 250), { code: 'SEND_UNKNOWN' });
  await assert.rejects(rpc(script, 'terminal.send', { text: 'blocked' }), { code: 'CORE_BLOCKED' });
  await assert.rejects(command('/nonexistent/va-missing', []), { code: 'DEPENDENCY_MISSING' });
  await assert.rejects(command(script, ['bad']), { code: 'DEPENDENCY_FAILED' });
});
test('unknown sends are cached and never retried', async () => {
  let sends = 0;
  const { host } = setup({ rpc: async () => { sends++; throw Object.assign(new Error('disconnected'), { code: 'SEND_UNKNOWN' }); } });
  const req = request('sendAnnotation', { terminal: 'remote/t1', markdown: 'x' });
  assert.equal((await host(req)).error.code, 'SEND_UNKNOWN');
  assert.equal((await host(req)).error.code, 'SEND_UNKNOWN'); assert.equal(sends, 1);
});
test('installer exact origins, fixed executable paths and scoped uninstall for all browsers', t => {
  const { dir, script } = fixture(t);
  fs.copyFileSync(script, path.join(dir, 'herdr-app'));
  const id = 'abcdefghijklmnopabcdefghijklmnop';
  assert.throws(() => options(['--extension-id', '*']));
  assert.throws(() => options(['--extension-id', id, '--browser', 'safari']));
  const browserDirectories = { chrome: 'Google/Chrome', edge: 'Microsoft Edge', chromium: 'Chromium', helium: 'net.imput.helium' };
  for (const [browser, directory] of Object.entries(browserDirectories)) {
    const settings = options(['--extension-id', id, '--browser', browser]);
    const result = install(settings, { platform: 'darwin', home: dir, envPath: dir });
    assert.equal(result.manifestPath, path.join(dir, 'Library/Application Support', directory, 'NativeMessagingHosts', `${NAME}.json`));
    const manifest = JSON.parse(fs.readFileSync(result.manifestPath));
    assert.equal(manifest.name, NAME); assert.deepEqual(manifest.allowed_origins, [`chrome-extension://${id}/`]);
    const config = JSON.parse(fs.readFileSync(path.join(path.dirname(manifest.path), 'config.json')));
    assert.equal(config.node, fs.realpathSync(process.execPath)); assert.equal(config.hc, fs.realpathSync(script));
    assert.match(fs.readFileSync(manifest.path, 'utf8'), /^#!\/bin\/sh\nexec '/);
    assert.throws(() => install({ ...settings, extensionId: 'a'.repeat(32), uninstall: true }, { platform: 'darwin', home: dir }));
    assert.equal(install({ ...settings, uninstall: true }, { platform: 'darwin', home: dir }).removed, true);
    assert.equal(fs.existsSync(result.manifestPath), false); assert.equal(fs.existsSync(script), true);
    install(settings, { platform: 'darwin', home: dir, envPath: dir });
    install({ ...settings, uninstall: true }, { platform: 'darwin', home: dir });
  }
});

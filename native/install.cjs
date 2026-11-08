'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const NAME = 'com.visual_annotator.herdr';
const DIRECTORIES = { chrome: 'Google/Chrome', edge: 'Microsoft Edge', chromium: 'Chromium', helium: 'net.imput.helium' };

function options(args) {
  const result = { browser: 'chrome', uninstall: false };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--uninstall') result.uninstall = true;
    else if (args[i] === '--extension-id') result.extensionId = args[++i];
    else if (args[i] === '--browser') result.browser = args[++i];
    else throw new Error(`Unknown argument: ${args[i]}`);
  }
  if (!/^[a-p]{32}$/.test(result.extensionId || '')) throw new Error('A precise Chromium extension ID is required: --extension-id (32 letters a–p)');
  if (!Object.hasOwn(DIRECTORIES, result.browser)) throw new Error(`Browser must be one of: ${Object.keys(DIRECTORIES).join(', ')}`);
  return result;
}
function executable(name, envPath = process.env.PATH || '') {
  for (const directory of envPath.split(path.delimiter)) {
    if (!path.isAbsolute(directory)) continue;
    const candidate = path.join(directory, name);
    try { fs.accessSync(candidate, fs.constants.X_OK); if (fs.statSync(candidate).isFile()) return fs.realpathSync(candidate); } catch {}
  }
  throw new Error(`Missing dependency: ${name}; install it separately and put it on PATH`);
}
const quote = value => `'${value.replace(/'/g, `'\\''`)}'`;
function install(settings, context = {}) {
  const platform = context.platform || process.platform;
  if (platform !== 'darwin') throw new Error('This installer supports macOS only');
  const home = context.home || os.homedir();
  const source = fs.realpathSync(path.join(__dirname, 'host.cjs'));
  const directory = path.join(home, 'Library/Application Support', NAME, settings.browser);
  const manifestPath = path.join(home, 'Library/Application Support', DIRECTORIES[settings.browser], 'NativeMessagingHosts', `${NAME}.json`);
  const launcher = path.join(directory, 'launch.sh');
  const configPath = path.join(directory, 'config.json');
  const origin = `chrome-extension://${settings.extensionId}/`;
  let previous = null;
  try { previous = JSON.parse(fs.readFileSync(manifestPath, 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') throw new Error('Existing host manifest is unreadable; refusing to replace it'); }
  if (previous && (previous.name !== NAME || previous.path !== launcher || previous.allowed_origins?.length !== 1 || previous.allowed_origins[0] !== origin)) throw new Error('Host registration belongs to another extension or installation; refusing to replace/remove it');
  if (settings.uninstall) {
    if (!previous) return { manifestPath, removed: false };
    fs.unlinkSync(manifestPath);
    for (const file of [launcher, configPath]) {
      try { fs.unlinkSync(file); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    try { fs.rmdirSync(directory); } catch (error) { if (!['ENOENT', 'ENOTEMPTY'].includes(error.code)) throw error; }
    return { manifestPath, removed: true };
  }
  if (!previous && fs.existsSync(directory)) throw new Error('Unowned installation directory exists; refusing to overwrite it');
  const config = { node: fs.realpathSync(process.execPath), hc: executable('hc', context.envPath), herdr: executable('herdr-app', context.envPath) };
  if (Number(process.versions.node.split('.')[0]) < 18) throw new Error('Node.js >=18 is required');
  for (const key of ['hc', 'herdr']) {
    const check = spawnSync(config[key], ['--version'], { encoding: 'utf8', timeout: 5000, maxBuffer: 65536 });
    if (check.error || check.status !== 0) throw new Error(`Cannot execute ${key} --version`);
  }
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n', { mode: 0o600 });
  fs.writeFileSync(launcher, `#!/bin/sh\nexec ${quote(config.node)} ${quote(source)} ${quote(configPath)}\n`, { mode: 0o700 });
  fs.chmodSync(launcher, 0o700);
  fs.mkdirSync(path.dirname(manifestPath), { recursive: true });
  fs.writeFileSync(manifestPath, JSON.stringify({ name: NAME, description: 'Visual Annotator Herdr bridge', path: launcher, type: 'stdio', allowed_origins: [origin] }, null, 2) + '\n', { mode: 0o600 });
  return { manifestPath, config };
}
if (require.main === module) {
  try { console.log(JSON.stringify(install(options(process.argv.slice(2))), null, 2)); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
module.exports = { options, install, executable, quote, NAME };

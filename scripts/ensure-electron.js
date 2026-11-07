'use strict';
/**
 * Newer npm versions block dependency install scripts by default, which skips
 * Electron's own postinstall (the step that downloads the Electron binary).
 * This root-level script runs Electron's installer ourselves if the binary is missing.
 */
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const dir = path.join(__dirname, '..', 'node_modules', 'electron');
const force = process.argv.includes('--force');

function installed() {
  try {
    const p = fs.readFileSync(path.join(dir, 'path.txt'), 'utf8').trim();
    return fs.existsSync(path.join(dir, 'dist', p));
  } catch (_) {
    return false;
  }
}

if (!fs.existsSync(dir)) {
  console.error('[korbaj] electron is not in node_modules — run `npm install` first.');
  process.exit(1);
}
if (!force && installed()) {
  console.log('[korbaj] Electron binary OK.');
  process.exit(0);
}
if (force) {
  fs.rmSync(path.join(dir, 'dist'), { recursive: true, force: true });
  fs.rmSync(path.join(dir, 'path.txt'), { force: true });
}
console.log('[korbaj] Downloading Electron binary...');
const r = spawnSync(process.execPath, [path.join(dir, 'install.js')], { cwd: dir, stdio: 'inherit' });
if (r.status !== 0 || !installed()) {
  console.error('[korbaj] Electron download failed. Check your network/proxy, then run: npm run fix-electron');
  process.exit(1);
}
console.log('[korbaj] Electron binary installed.');

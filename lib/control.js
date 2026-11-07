'use strict';
/**
 * Local control channel so any hotkey daemon / compositor bind / script can drive Korbaj:
 *   korbaj toggle | show | hide | passive | mode 1|2|3 | quit | status
 * Unix socket on Linux/macOS, named pipe on Windows. Only the current user can reach it.
 */
const net = require('net');
const fs = require('fs');
const os = require('os');
const path = require('path');

function controlPath() {
  if (process.platform === 'win32') return `\\\\.\\pipe\\korbaj-${os.userInfo().username}`;
  const dir = process.env.XDG_RUNTIME_DIR || os.tmpdir();
  return path.join(dir, `korbaj-${process.getuid ? process.getuid() : 'u'}.sock`);
}

function startServer(handler) {
  const p = controlPath();
  if (process.platform !== 'win32') {
    try { fs.unlinkSync(p); } catch (_) { /* not there */ }
  }
  const server = net.createServer((c) => {
    let buf = '';
    c.on('data', (d) => {
      buf += d.toString('utf8');
      if (!buf.includes('\n')) return;
      const line = buf.split('\n')[0].trim();
      let reply;
      try { reply = handler(line.split(/\s+/)); } catch (e) { reply = `error ${e.message}`; }
      c.end(`${reply || 'ok'}\n`);
    });
    c.on('error', () => {});
  });
  server.on('error', (e) => console.warn('[korbaj] control socket error:', e.message));
  server.listen(p, () => {
    if (process.platform !== 'win32') { try { fs.chmodSync(p, 0o600); } catch (_) { /* best effort */ } }
  });
  return { server, path: p };
}

function send(cmd, timeoutMs = 1500) {
  return new Promise((resolve, reject) => {
    const c = net.createConnection(controlPath());
    let out = '';
    const t = setTimeout(() => { c.destroy(); reject(new Error('timeout')); }, timeoutMs);
    c.on('connect', () => c.write(`${cmd}\n`));
    c.on('data', (d) => { out += d; });
    c.on('end', () => { clearTimeout(t); resolve(out.trim()); });
    c.on('error', (e) => { clearTimeout(t); reject(e); });
  });
}

module.exports = { controlPath, startServer, send };

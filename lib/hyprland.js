'use strict';
/**
 * Minimal Hyprland IPC client (same socket `hyprctl` uses).
 * Lets Korbaj read the GLOBAL cursor position on Wayland — something no regular
 * Wayland client can do — and turn its own window into a floating, pinned overlay.
 */
const net = require('net');
const fs = require('fs');
const path = require('path');

function socketPath() {
  const sig = process.env.HYPRLAND_INSTANCE_SIGNATURE;
  if (!sig) return null;
  const candidates = [];
  if (process.env.XDG_RUNTIME_DIR) candidates.push(path.join(process.env.XDG_RUNTIME_DIR, 'hypr', sig, '.socket.sock'));
  candidates.push(path.join('/tmp', 'hypr', sig, '.socket.sock')); // Hyprland < 0.40
  return candidates.find((p) => fs.existsSync(p)) || null;
}

const SOCK = socketPath();

function request(cmd, timeoutMs = 250) {
  return new Promise((resolve, reject) => {
    if (!SOCK) { reject(new Error('Hyprland socket not found')); return; }
    const c = net.createConnection(SOCK);
    const chunks = [];
    const timer = setTimeout(() => { c.destroy(); reject(new Error(`hyprland ipc timeout: ${cmd}`)); }, timeoutMs);
    c.on('connect', () => c.write(cmd));
    c.on('data', (d) => chunks.push(d));
    c.on('end', () => { clearTimeout(timer); resolve(Buffer.concat(chunks).toString('utf8')); });
    c.on('error', (e) => { clearTimeout(timer); reject(e); });
  });
}

async function json(cmd) {
  return JSON.parse(await request(`j/${cmd}`));
}

let monitors = [];
let monitorsAt = 0;
async function refreshMonitors() {
  if (Date.now() - monitorsAt < 2000 && monitors.length) return monitors;
  const list = await json('monitors');
  monitors = list
    .map((m) => {
      const rot = (m.transform || 0) % 2 === 1;
      const w = (rot ? m.height : m.width) / (m.scale || 1);
      const h = (rot ? m.width : m.height) / (m.scale || 1);
      return { x: m.x, y: m.y, w, h };
    })
    .sort((a, b) => a.x - b.x || a.y - b.y);
  monitorsAt = Date.now();
  return monitors;
}

/**
 * Global cursor, expressed as (monitor index sorted left→right, fraction within it).
 * Hyprland's layout coordinates and XWayland's can differ when scaling is on
 * (e.g. xwayland:force_zero_scaling), so main.js maps the fraction onto the
 * matching Electron display instead of trusting raw pixels.
 */
async function cursorPos() {
  const [p, mons] = await Promise.all([json('cursorpos'), refreshMonitors()]);
  let idx = mons.findIndex((m) => p.x >= m.x && p.x < m.x + m.w && p.y >= m.y && p.y < m.y + m.h);
  if (idx < 0) idx = 0;
  const m = mons[idx] || { x: 0, y: 0, w: 1, h: 1 };
  return { x: p.x, y: p.y, monitor: idx, fx: (p.x - m.x) / m.w, fy: (p.y - m.y) / m.h };
}

async function findWindow(title, pid) {
  const clients = await json('clients');
  return clients.find((c) => c.title === title) || clients.find((c) => c.pid === pid) || null;
}

async function batch(cmds) {
  return request(`[[BATCH]]${cmds.join(';')}`, 600);
}

/**
 * Make our window a click-through-friendly overlay: floating, pinned to all
 * workspaces, borderless, exactly covering `bounds`. Each command is independent,
 * so a dispatcher missing in the user's Hyprland version just gets ignored.
 */
async function makeOverlay(title, pid, bounds, refocusAddress) {
  let win = null;
  for (let i = 0; i < 20 && !win; i++) {
    win = await findWindow(title, pid).catch(() => null);
    if (!win) await new Promise((r) => setTimeout(r, 100));
  }
  if (!win) return { ok: false, reason: 'window not found in hyprctl clients' };
  const a = `address:${win.address}`;
  const cmds = [];
  if (!win.floating) cmds.push(`dispatch setfloating ${a}`);
  if (!win.pinned) cmds.push(`dispatch pin ${a}`);
  cmds.push(
    `dispatch resizewindowpixel exact ${bounds.width} ${bounds.height},${a}`,
    `dispatch movewindowpixel exact ${bounds.x} ${bounds.y},${a}`,
    `dispatch setprop ${a} noborder 1`,
    `dispatch setprop ${a} noshadow 1`,
    `dispatch setprop ${a} noblur 1`,
    `dispatch setprop ${a} noanim 1`,
    `dispatch setprop ${a} alphaoverride 0`,
  );
  if (refocusAddress && refocusAddress !== win.address) cmds.push(`dispatch focuswindow address:${refocusAddress}`);
  const out = await batch(cmds).catch((e) => e.message);
  return { ok: true, address: win.address, out };
}

async function moveOverlay(address, bounds) {
  const a = `address:${address}`;
  return batch([
    `dispatch resizewindowpixel exact ${bounds.width} ${bounds.height},${a}`,
    `dispatch movewindowpixel exact ${bounds.x} ${bounds.y},${a}`,
  ]).catch(() => null);
}

async function activeWindowAddress() {
  try {
    const w = await json('activewindow');
    return w && w.address ? w.address : null;
  } catch (_) {
    return null;
  }
}

module.exports = {
  available: !!SOCK, socket: SOCK, request, cursorPos, makeOverlay, moveOverlay, activeWindowAddress,
};

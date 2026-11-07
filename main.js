'use strict';
/**
 * Korbaj (كرباج) — main process.
 * Transparent, always-on-top, click-through overlay with global shortcuts.
 *
 * Key design decision: the cursor is tracked by POLLING screen.getCursorScreenPoint()
 * from the main process, not via DOM mouse events. `setIgnoreMouseEvents(true, {forward:true})`
 * only forwards mouse-move on Windows/macOS — on Linux it forwards nothing, so a DOM-driven
 * whip would freeze in click-through mode. Polling works identically everywhere.
 */
const {
  app, BrowserWindow, globalShortcut, ipcMain, screen, Tray, Menu, nativeImage,
} = require('electron');
const path = require('path');
const fs = require('fs');

// ---------- Platform flags (must run before app 'ready') ----------
const argv = process.argv.slice(1);
const NO_GPU = argv.includes('--disable-gpu') || process.env.KORBAJ_NO_GPU === '1';
if (process.platform === 'linux') {
  app.commandLine.appendSwitch('enable-transparent-visuals');
  // Let Electron pick Wayland natively when available; user may force X11 via --ozone-platform=x11.
  if (!argv.some((a) => a.startsWith('--ozone-platform'))) {
    app.commandLine.appendSwitch('ozone-platform-hint', 'auto');
  }
}
if (NO_GPU) {
  app.disableHardwareAcceleration();
  app.commandLine.appendSwitch('disable-gpu');
}

const POLL_MS = 8; // ~120 Hz cursor sampling
const SOUND_DIR = path.join(__dirname, 'assets', 'sounds');

const state = {
  visible: true,
  passive: true, // true = click-through
  mode: 1, // 1 = whip, 2 = dual, 3 = pat
};

let win = null;
let tray = null;
let pollTimer = null;

function targetDisplay() {
  return screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
}

function fitToDisplay() {
  if (!win) return;
  const { bounds } = targetDisplay();
  win.setBounds(bounds);
}

function createWindow() {
  const { bounds } = targetDisplay();
  win = new BrowserWindow({
    x: bounds.x,
    y: bounds.y,
    width: bounds.width,
    height: bounds.height,
    transparent: true,
    frame: false,
    // Real `fullscreen: true` creates a separate Space on macOS and hides the apps
    // underneath, defeating the overlay. A borderless window sized to the display is
    // the robust equivalent. Set KORBAJ_TRUE_FULLSCREEN=1 to force the literal flag.
    fullscreen: process.env.KORBAJ_TRUE_FULLSCREEN === '1',
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: false,
    movable: false,
    hasShadow: false,
    backgroundColor: '#00000000',
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: false,
      autoplayPolicy: 'no-user-gesture-required',
    },
  });

  win.setAlwaysOnTop(true, 'screen-saver');
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  win.loadFile(path.join(__dirname, 'index.html'));

  win.once('ready-to-show', () => {
    win.showInactive();
    applyMouseMode();
    pushState();
  });

  win.on('closed', () => { win = null; });
}

function applyMouseMode() {
  if (!win) return;
  if (state.passive) {
    win.setIgnoreMouseEvents(true, { forward: true });
  } else {
    win.setIgnoreMouseEvents(false);
    win.focus();
  }
}

function pushState() {
  if (win && !win.isDestroyed()) win.webContents.send('korbaj:state', { ...state });
  rebuildTrayMenu();
}

function startPolling() {
  stopPolling();
  pollTimer = setInterval(() => {
    if (!win || win.isDestroyed() || !state.visible) return;
    const p = screen.getCursorScreenPoint();
    const b = win.getBounds();
    win.webContents.send('korbaj:cursor', { x: p.x - b.x, y: p.y - b.y, t: Date.now() });
  }, POLL_MS);
}

function stopPolling() {
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = null;
}

// ---------- Actions ----------
function toggleVisible() {
  if (!win) return;
  state.visible = !state.visible;
  if (state.visible) {
    fitToDisplay();
    win.showInactive();
    win.setAlwaysOnTop(true, 'screen-saver');
    applyMouseMode();
    startPolling();
  } else {
    stopPolling();
    win.hide();
  }
  pushState();
}

function togglePassive() {
  state.passive = !state.passive;
  applyMouseMode();
  pushState();
}

function setMode(m) {
  state.mode = m;
  if (!state.visible) toggleVisible();
  pushState();
}

function quit() {
  app.quit();
}

// ---------- Shortcuts ----------
const SHORTCUTS = {
  'Alt+W': toggleVisible,
  'Alt+C': togglePassive,
  'Alt+1': () => setMode(1),
  'Alt+2': () => setMode(2),
  'Alt+3': () => setMode(3),
  'Alt+Q': quit,
};

function registerShortcuts() {
  const failed = [];
  for (const [accel, fn] of Object.entries(SHORTCUTS)) {
    try {
      if (!globalShortcut.register(accel, fn)) failed.push(accel);
    } catch (e) {
      failed.push(accel);
    }
  }
  if (failed.length) {
    console.warn(`[korbaj] Could not register: ${failed.join(', ')} — ` +
      'another app owns them, or your compositor (e.g. Wayland) blocks global shortcuts. ' +
      'Use the tray menu, or run `npm run start:x11`.');
  }
  return failed;
}

// ---------- Tray ----------
function makeTrayIcon() {
  // Procedurally draw a 32x32 icon (whip "K" on a red disc) — no binary assets needed.
  const S = 32;
  const buf = Buffer.alloc(S * S * 4);
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const i = (y * S + x) * 4;
      const dx = x - 15.5, dy = y - 15.5;
      const d = Math.hypot(dx, dy);
      let r = 0, g = 0, b = 0, a = 0;
      if (d < 15) {
        const t = d / 15;
        r = 200 - 60 * t; g = 40 - 20 * t; b = 30; a = 255;
        // Curving cord
        const cx = 8 + 16 * ((y - 4) / 24);
        const curve = cx + Math.sin((y / 32) * Math.PI * 2) * 4;
        if (y > 4 && y < 28 && Math.abs(x - curve) < 1.6) { r = 255; g = 220; b = 150; }
        // Handle
        if (y >= 4 && y <= 12 && x >= 7 && x <= 10) { r = 120; g = 70; b = 30; }
      }
      buf[i] = b; buf[i + 1] = g; buf[i + 2] = r; buf[i + 3] = a; // BGRA
    }
  }
  return nativeImage.createFromBitmap(buf, { width: S, height: S });
}

function rebuildTrayMenu() {
  if (!tray) return;
  const menu = Menu.buildFromTemplate([
    { label: 'Korbaj — كرباج', enabled: false },
    { type: 'separator' },
    { label: state.visible ? 'Hide (Alt+W)' : 'Summon (Alt+W)', click: toggleVisible },
    {
      label: 'Click-Through (Alt+C)', type: 'checkbox', checked: state.passive, click: togglePassive,
    },
    { type: 'separator' },
    { label: 'Single Whip (Alt+1)', type: 'radio', checked: state.mode === 1, click: () => setMode(1) },
    { label: 'Dual Whips (Alt+2)', type: 'radio', checked: state.mode === 2, click: () => setMode(2) },
    { label: 'Pat Mode (Alt+3)', type: 'radio', checked: state.mode === 3, click: () => setMode(3) },
    { type: 'separator' },
    { label: 'Quit (Alt+Q)', click: quit },
  ]);
  tray.setContextMenu(menu);
  tray.setToolTip(`Korbaj — ${['', 'Whip', 'Dual', 'Pat'][state.mode]} | ${state.passive ? 'Click-Through' : 'Active'}`);
}

function createTray() {
  try {
    tray = new Tray(makeTrayIcon());
    rebuildTrayMenu();
  } catch (e) {
    console.warn('[korbaj] Tray unavailable on this desktop:', e.message);
  }
}

// ---------- Custom audio ----------
function findSound(base) {
  for (const ext of ['mp3', 'wav', 'ogg']) {
    const p = path.join(SOUND_DIR, `${base}.${ext}`);
    if (fs.existsSync(p)) return p;
  }
  return null;
}

ipcMain.handle('korbaj:load-sound', async (_e, base) => {
  if (!/^[a-z]+$/.test(base)) return null; // no path traversal
  const p = findSound(base);
  if (!p) return null;
  const data = await fs.promises.readFile(p);
  return data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
});

ipcMain.handle('korbaj:config', () => ({
  soundMode: process.env.KORBAJ_SOUND_MODE === 'replace' ? 'replace' : 'mix',
  platform: process.platform,
}));

// ---------- Lifecycle ----------
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => { if (!state.visible) toggleVisible(); });

  app.whenReady().then(() => {
    // Linux compositors often need a short delay before a transparent window is mapped
    // correctly; otherwise the window comes up with a black background.
    const delay = process.platform === 'linux' ? 300 : 0;
    setTimeout(() => {
      createWindow();
      createTray();
      const failed = registerShortcuts();
      if (win) {
        win.webContents.once('did-finish-load', () => {
          if (failed.length) win.webContents.send('korbaj:warn', `Shortcuts unavailable: ${failed.join(', ')} — use tray menu`);
        });
      }
      startPolling();
      screen.on('display-metrics-changed', fitToDisplay);
    }, delay);
  });

  app.on('will-quit', () => {
    globalShortcut.unregisterAll();
    stopPolling();
  });

  app.on('window-all-closed', () => app.quit());
}

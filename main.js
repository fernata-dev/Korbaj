'use strict';
/**
 * Korbaj (كرباج) — main process.
 *
 * Design for Linux/Wayland reality:
 *  - Wayland forbids reading the global cursor and grabbing global keys. So on Linux
 *    Korbaj runs under XWayland (`--ozone-platform=x11`, see package.json), where
 *    click-through (XShape input region) works, and reads the cursor from:
 *       Hyprland IPC  → exact global position on any monitor
 *       Electron API  → X11 / Windows / macOS
 *  - Global shortcuts are registered where the OS allows it, AND every action is
 *    available through `bin/korbaj.js` (control socket) so you can bind it in your
 *    compositor / desktop settings. That works on every platform.
 *  - The overlay follows the cursor to whichever monitor it is on.
 */
const {
  app, BrowserWindow, globalShortcut, ipcMain, screen, Tray, Menu, nativeImage,
} = require('electron');
const path = require('path');
const fs = require('fs');
const hypr = require('./lib/hyprland');
const control = require('./lib/control');

const TITLE = 'Korbaj Overlay';
const argv = process.argv.slice(1);
const NO_GPU = argv.includes('--disable-gpu') || process.env.KORBAJ_NO_GPU === '1';
const SESSION = (process.env.XDG_SESSION_TYPE || '').toLowerCase();
const DESKTOP = process.env.XDG_CURRENT_DESKTOP || '';

if (process.platform === 'linux') app.commandLine.appendSwitch('enable-transparent-visuals');
if (NO_GPU) {
  app.disableHardwareAcceleration();
  app.commandLine.appendSwitch('disable-gpu');
}

const POLL_MS = 8;
const SOUND_DIR = path.join(__dirname, 'assets', 'sounds');
const startMode = Number((argv.find((a) => a.startsWith('--mode=')) || '').split('=')[1]) || 1;

const SKINS = ['leather', 'obsidian', 'bone'];
const SKIN_LABELS = { leather: 'Cognac Leather', obsidian: 'Obsidian', bone: 'Ivory & Gold' };
const startSkin = (argv.find((a) => a.startsWith('--skin=')) || '').split('=')[1] || process.env.KORBAJ_SKIN;

const state = {
  visible: true,
  passive: true,
  mode: [1, 2, 3].includes(startMode) ? startMode : 1,
  skin: SKINS.includes(startSkin) ? startSkin : 'leather',
};

let win = null;
let tray = null;
let pollTimer = null;
let currentDisplayId = null;
let hyprAddress = null;
let lastPoint = { x: 0, y: 0 };
let staleCount = 0;
let warnedStale = false;
let cursorSource = 'electron';

const runningOnWayland = () => process.platform === 'linux' && SESSION === 'wayland';
const nativeWayland = () => runningOnWayland() && app.commandLine.getSwitchValue('ozone-platform') !== 'x11'
  && !argv.includes('--ozone-platform=x11');

// ---------- Cursor ----------
let hyprBusy = false;
let hyprPoint = null;
function readCursor() {
  if (cursorSource === 'hyprland') {
    if (!hyprBusy) {
      hyprBusy = true;
      hypr.cursorPos()
        .then((p) => { hyprPoint = p; })
        .catch(() => { /* keep last */ })
        .finally(() => { hyprBusy = false; });
    }
    if (hyprPoint) {
      const ds = screen.getAllDisplays().sort((a, b) => a.bounds.x - b.bounds.x || a.bounds.y - b.bounds.y);
      const d = ds[hyprPoint.monitor] || ds[0];
      return {
        x: Math.round(d.bounds.x + hyprPoint.fx * d.bounds.width),
        y: Math.round(d.bounds.y + hyprPoint.fy * d.bounds.height),
      };
    }
  }
  return screen.getCursorScreenPoint();
}

// ---------- Window ----------
function displayFor(point) {
  return screen.getDisplayNearestPoint(point);
}

function createWindow() {
  const d = displayFor(readCursor());
  currentDisplayId = d.id;
  const { bounds } = d;
  win = new BrowserWindow({
    title: TITLE,
    x: bounds.x,
    y: bounds.y,
    width: bounds.width,
    height: bounds.height,
    transparent: true,
    frame: false,
    fullscreen: process.env.KORBAJ_TRUE_FULLSCREEN === '1',
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: false,
    movable: false,
    focusable: true,
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
  win.on('page-title-updated', (e) => e.preventDefault()); // keep TITLE for compositor rules
  win.loadFile(path.join(__dirname, 'index.html'));

  win.once('ready-to-show', () => showOverlay());
  win.on('closed', () => { win = null; });
}

async function showOverlay() {
  if (!win) return;
  const prevFocus = cursorSource === 'hyprland' ? await hypr.activeWindowAddress() : null;
  const d = displayFor(readCursor());
  currentDisplayId = d.id;
  win.setBounds(d.bounds);
  win.showInactive();
  win.setAlwaysOnTop(true, 'screen-saver');
  applyMouseMode();
  if (hypr.available) {
    const r = await hypr.makeOverlay(TITLE, process.pid, d.bounds, state.passive ? prevFocus : null);
    if (r.ok) hyprAddress = r.address;
    else console.warn('[korbaj] hyprland overlay setup:', r.reason);
  }
  startPolling();
  pushState();
}

function moveToDisplay(d) {
  if (!win || d.id === currentDisplayId) return;
  currentDisplayId = d.id;
  win.setBounds(d.bounds);
  if (hyprAddress) hypr.moveOverlay(hyprAddress, d.bounds);
  win.webContents.send('korbaj:display');
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
    const p = readCursor();

    // Follow the cursor across monitors
    const d = displayFor(p);
    if (d.id !== currentDisplayId) moveToDisplay(d);

    // Detect a cursor source that never updates (pure Wayland without Hyprland)
    if (p.x === lastPoint.x && p.y === lastPoint.y) staleCount++;
    else { staleCount = 0; lastPoint = p; }
    if (!warnedStale && staleCount > 1250 && state.passive && runningOnWayland() && cursorSource !== 'hyprland') {
      warnedStale = true;
      warn('Wayland is hiding the cursor position from apps. Use Alt+C (Active mode) or see README → Wayland.');
    }

    const b = win.getBounds();
    win.webContents.send('korbaj:cursor', { x: p.x - b.x, y: p.y - b.y });
  }, POLL_MS);
}

function stopPolling() {
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = null;
}

function warn(msg) {
  console.warn(`[korbaj] ${msg}`);
  if (win && !win.isDestroyed()) win.webContents.send('korbaj:warn', msg);
}

// ---------- Actions ----------
function setVisible(v) {
  if (!win || state.visible === v) return;
  state.visible = v;
  if (v) {
    showOverlay();
  } else {
    stopPolling();
    win.hide();
    pushState();
  }
}
const toggleVisible = () => setVisible(!state.visible);

function togglePassive() {
  state.passive = !state.passive;
  applyMouseMode();
  pushState();
}

function setMode(m) {
  state.mode = m;
  if (!state.visible) setVisible(true);
  pushState();
}

function setSkin(name) {
  state.skin = SKINS.includes(name) ? name : SKINS[(SKINS.indexOf(state.skin) + 1) % SKINS.length];
  if (!state.visible) setVisible(true);
  pushState();
}

const quit = () => app.quit();

function handleCommand(parts) {
  const [cmd, arg] = parts;
  switch (cmd) {
    case 'toggle': toggleVisible(); return state.visible ? 'shown' : 'hidden';
    case 'show': setVisible(true); return 'shown';
    case 'hide': setVisible(false); return 'hidden';
    case 'passive': case 'click-through': togglePassive(); return state.passive ? 'click-through' : 'active';
    case 'mode': {
      const m = Number(arg);
      if (![1, 2, 3].includes(m)) return 'error mode must be 1, 2 or 3';
      setMode(m);
      return `mode ${m}`;
    }
    case 'skin':
      if (arg && arg !== 'next' && !SKINS.includes(arg)) return `error skin must be one of: ${SKINS.join(', ')}`;
      setSkin(arg === 'next' ? undefined : arg);
      return `skin ${state.skin}`;
    case 'quit': setTimeout(quit, 50); return 'bye';
    case 'status': return JSON.stringify({ ...state, cursorSource, session: SESSION || process.platform, desktop: DESKTOP });
    default: return `error unknown command: ${cmd}`;
  }
}

// ---------- Shortcuts ----------
const SHORTCUTS = {
  'Alt+W': toggleVisible,
  'Alt+C': togglePassive,
  'Alt+1': () => setMode(1),
  'Alt+2': () => setMode(2),
  'Alt+3': () => setMode(3),
  'Alt+S': () => setSkin(),
  'Alt+Q': quit,
};

function registerShortcuts() {
  const failed = [];
  for (const [accel, fn] of Object.entries(SHORTCUTS)) {
    try {
      if (!globalShortcut.register(accel, fn)) failed.push(accel);
    } catch (_) {
      failed.push(accel);
    }
  }
  return failed;
}

// ---------- Tray ----------
function makeTrayIcon() {
  const S = 32;
  const buf = Buffer.alloc(S * S * 4);
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const i = (y * S + x) * 4;
      const d = Math.hypot(x - 15.5, y - 15.5);
      let r = 0, g = 0, b = 0, a = 0;
      if (d < 15) {
        const t = d / 15;
        r = 200 - 60 * t; g = 40 - 20 * t; b = 30; a = 255;
        const curve = 8 + 16 * ((y - 4) / 24) + Math.sin((y / 32) * Math.PI * 2) * 4;
        if (y > 4 && y < 28 && Math.abs(x - curve) < 1.6) { r = 255; g = 230; b = 190; }
        if (y >= 4 && y <= 12 && x >= 7 && x <= 10) { r = 240; g = 190; b = 60; }
      }
      buf[i] = b; buf[i + 1] = g; buf[i + 2] = r; buf[i + 3] = a;
    }
  }
  return nativeImage.createFromBitmap(buf, { width: S, height: S });
}

function rebuildTrayMenu() {
  if (!tray) return;
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Korbaj — كرباج', enabled: false },
    { type: 'separator' },
    { label: state.visible ? 'Hide (Alt+W)' : 'Summon (Alt+W)', click: toggleVisible },
    { label: 'Click-Through (Alt+C)', type: 'checkbox', checked: state.passive, click: togglePassive },
    { type: 'separator' },
    { label: 'Single Whip (Alt+1)', type: 'radio', checked: state.mode === 1, click: () => setMode(1) },
    { label: 'Dual Whips (Alt+2)', type: 'radio', checked: state.mode === 2, click: () => setMode(2) },
    { label: 'Pat Mode (Alt+3)', type: 'radio', checked: state.mode === 3, click: () => setMode(3) },
    { type: 'separator' },
    {
      label: 'Skin (Alt+S)',
      submenu: SKINS.map((k) => ({ label: SKIN_LABELS[k], type: 'radio', checked: state.skin === k, click: () => setSkin(k) })),
    },
    { type: 'separator' },
    { label: 'Quit (Alt+Q)', click: quit },
  ]));
  tray.setToolTip(`Korbaj — ${['', 'Whip', 'Dual', 'Pat'][state.mode]} | ${state.passive ? 'Click-Through' : 'Active'}`);
}

function createTray() {
  try {
    tray = new Tray(makeTrayIcon());
    rebuildTrayMenu();
  } catch (e) {
    console.warn('[korbaj] tray unavailable:', e.message);
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
  if (!/^[a-z]+$/.test(base)) return null;
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
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', (_e, args) => {
    const m = (args.find((a) => a.startsWith('--mode=')) || '').split('=')[1];
    if (m) setMode(Number(m)); else setVisible(true);
  });

  app.whenReady().then(() => {
    if (hypr.available) cursorSource = 'hyprland';

    const delay = process.platform === 'linux' ? 300 : 0;
    setTimeout(() => {
      createWindow();
      createTray();
      control.startServer(handleCommand);
      const failed = registerShortcuts();

      console.log(`[korbaj] session=${SESSION || process.platform} desktop=${DESKTOP || '-'} `
        + `cursor=${cursorSource} shortcuts=${failed.length ? `partial (failed: ${failed.join(',')})` : 'ok'}`);
      if (nativeWayland()) {
        console.warn('[korbaj] running as a native Wayland client: click-through and cursor tracking are limited. '
          + 'Use `npm start` (XWayland) instead.');
      }
      if (failed.length && win) {
        win.webContents.once('did-finish-load', () => warn(`Shortcuts blocked by your desktop: ${failed.join(', ')}. Bind \`bin/korbaj.js toggle\` instead (README).`));
      }
      screen.on('display-metrics-changed', () => {
        currentDisplayId = null;
        const d = displayFor(readCursor());
        moveToDisplay(d);
      });
    }, delay);
  });

  app.on('will-quit', () => {
    globalShortcut.unregisterAll();
    stopPolling();
  });

  app.on('window-all-closed', () => app.quit());
}

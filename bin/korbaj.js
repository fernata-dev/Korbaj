#!/usr/bin/env node
'use strict';
/**
 * korbaj — control the overlay from a terminal or any shortcut system.
 *
 *   korbaj                 start it (or summon it if already running)
 *   korbaj toggle          summon / hide — starts it if it is not running
 *   korbaj show | hide
 *   korbaj passive         click-through <-> active
 *   korbaj mode 1|2|3      whip / dual / pat
 *   korbaj skin [name]     leather | obsidian | bone (no name = next)
 *   korbaj restart         quit and start again (use after updating)
 *   korbaj quit
 *   korbaj status
 *   korbaj setup           install the keyboard shortcuts into Hyprland
 *   korbaj doctor          check everything and say what is wrong
 */
const fs = require('fs');
const { spawn } = require('child_process');
const { send } = require('../lib/control');
const setup = require('../lib/setup');

const args = process.argv.slice(2);
const cmd = args.length ? args.join(' ') : 'show';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function launch(extra = []) {
  const electron = setup.electronBinary();
  if (!electron) {
    console.error('Electron is not installed. Run:  npm run fix-electron');
    process.exit(1);
  }
  fs.mkdirSync(setup.STATE_DIR, { recursive: true });
  const log = fs.openSync(setup.LOG_FILE, 'w'); // keep the last run's output for `korbaj doctor`
  const flags = process.platform === 'linux' ? ['--ozone-platform=x11'] : [];
  const child = spawn(electron, [setup.ROOT, ...flags, ...extra], { detached: true, stdio: ['ignore', log, log], cwd: setup.ROOT });
  child.unref();
}

async function waitUntilUp(ms = 8000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try { await send('status', 400); return true; } catch (_) { await sleep(150); }
  }
  return false;
}

async function start(extra) {
  launch(extra);
  if (await waitUntilUp()) { console.log('korbaj started'); return; }
  console.error('korbaj did not start. Last log lines:');
  console.error(setup.logTail().map((l) => `  ${l}`).join('\n') || '  (log is empty)');
  console.error('Run `korbaj doctor` for a full check.');
  // Started from a keyboard shortcut there is no terminal to read this in — say it on screen.
  const hypr = require('../lib/hyprland');
  if (hypr.available) await hypr.request('notify 3 8000 rgb(ff5555) Korbaj failed to start. Open a terminal and run: korbaj doctor', 800).catch(() => {});
  process.exit(1);
}

async function main() {
  if (cmd === 'doctor') { console.log(await setup.doctor()); return; }
  if (cmd === 'setup') {
    const r = await setup.setupHyprland();
    console.log(r.text);
    if (r.ok) console.log('\nDone. Press Alt+W anywhere (works with any keyboard layout).');
    process.exitCode = r.ok ? 0 : 1;
    return;
  }
  if (cmd === 'restart') {
    try { await send('quit'); await sleep(700); } catch (_) { /* was not running */ }
    await start();
    return;
  }
  try {
    const reply = await send(cmd);
    if (reply && reply !== 'ok') console.log(reply);
  } catch (_) {
    if (/^(quit|hide|status)$/.test(cmd)) { console.log('korbaj is not running'); return; }
    // Not running yet: start it, applying the requested mode if any.
    const m = cmd.match(/^mode ([123])$/);
    await start(m ? [`--mode=${m[1]}`] : []);
  }
}

main();

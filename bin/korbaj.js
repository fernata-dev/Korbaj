#!/usr/bin/env node
'use strict';
/**
 * korbaj — control the overlay from any shortcut system.
 *   korbaj              start (or summon if already running)
 *   korbaj toggle       summon / hide
 *   korbaj show | hide
 *   korbaj passive      toggle click-through
 *   korbaj mode 1|2|3   whip / dual / pat
 *   korbaj skin [leather|obsidian|bone]   (no name = next skin)
 *   korbaj quit
 *   korbaj status
 */
const path = require('path');
const { spawn } = require('child_process');
const { send } = require('../lib/control');

const ROOT = path.join(__dirname, '..');
const args = process.argv.slice(2);
const cmd = args.length ? args.join(' ') : 'show';

function launch(extra) {
  const electron = require(path.join(ROOT, 'node_modules', 'electron'));
  const flags = process.platform === 'linux' ? ['--ozone-platform=x11'] : [];
  const child = spawn(electron, [ROOT, ...flags, ...extra], { detached: true, stdio: 'ignore', cwd: ROOT });
  child.unref();
}

send(cmd)
  .then((reply) => { if (reply && reply !== 'ok') console.log(reply); })
  .catch(() => {
    if (/^(quit|hide|status)$/.test(cmd)) { console.log('korbaj is not running'); return; }
    // Not running yet: start it, applying the requested mode if any.
    const m = cmd.match(/^mode ([123])$/);
    launch(m ? [`--mode=${m[1]}`] : []);
    console.log('korbaj started');
  });

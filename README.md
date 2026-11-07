<div align="center">

# ⚡ Korbaj — كرباج

### The AI Response Accelerator

**A real-physics whip that lives on top of your desktop.**
Flick your mouse → *TESHH!* 💥 — your slow AI gets the message.
Or pat it gently when it ships clean code. ✋

![Electron](https://img.shields.io/badge/Electron-45-47848F?logo=electron&logoColor=white)
![Canvas](https://img.shields.io/badge/HTML5-Canvas-E34F26?logo=html5&logoColor=white)
![Web Audio](https://img.shields.io/badge/Web%20Audio-procedural-ff6a3d)
![Platforms](https://img.shields.io/badge/Linux%20%7C%20Windows%20%7C%20macOS-supported-2ea44f)
![Zero assets](https://img.shields.io/badge/assets-zero%20required-8a2be2)

<img src="docs/demo.gif" alt="Korbaj demo" width="720"/>

</div>

---

## ✨ Features

| | |
|---|---|
| 🪢 **Real whip physics** | Rigid handle hinged at the cursor (swings & rotates), 26-node Verlet cord, 240 Hz substeps, gravity, quadratic air drag, exponential mass taper (tip 40× lighter), so the loop accelerates like a real bullwhip |
| 💥 **Real crack detection** | Only on deliberate fast moves or flicks: tip past the sound-barrier threshold, cord fully extended, hand moving fast. Tiny moves never crack |
| 🔥 **Fire Whip combo** | 5+ cracks inside 2 s sets the cord on fire |
| ⚡ **VFX** | Shockwave rings, white-hot flash, spark showers, burn marks that fade over 3 s |
| 🔊 **Procedural sound** | Whoosh that follows speed, a 5-layer crack (snap, hiss, resonant sweep, sub thump, room echo), soft chimes. No audio files needed |
| 🖱️ **Click-through** | Keep working in your IDE while the whip follows your cursor |
| ✋ **Pat mode** | Rub gently and you get wholesome praise in English and Arabic |
| 🎛️ **Tray + HUD** | Small status pill that fades after 3 s, plus a full tray menu |

## 📸 Screenshots

<table>
<tr>
<td align="center"><img src="docs/fire.png" width="420"/><br/><b>💥 Flick → crack → combo</b></td>
<td align="center"><img src="docs/dual.png" width="420"/><br/><b>🔥 Dual Whips on fire (5+ combo)</b></td>
</tr>
<tr>
<td align="center" colspan="2"><img src="docs/pat.png" width="420"/><br/><b>✋ Pat Mode: عاش يا وحش</b></td>
</tr>
</table>

## 🚀 Quick start

Requires **Node.js 18+**.

```bash
git clone https://github.com/fernata-dev/Korbaj.git
cd Korbaj
npm install
npm start
```

Something off?

```bash
npm run fix-electron  # "Electron failed to install correctly" → re-download the binary
```


```bash
npm run start:nogpu   # black background / GPU glitches
```

## ⌨️ Controls

| Shortcut | Action |
|:---:|---|
| `Alt + W` | Summon / hide the overlay |
| `Alt + C` | **Click-Through** (default) ↔ **Active** (left-click = crack) |
| `Alt + 1` | Single whip |
| `Alt + 2` | Dual whips |
| `Alt + 3` | Pat mode ✋ |
| `Alt + Q` | Quit |

> 💡 Everything is also in the **tray menu**, in case your desktop blocks global shortcuts.

**How to crack:** move the mouse fast in one direction, then snap it back sharply. The flick is what cracks it, not raw speed.

## 🔊 Custom sounds

Drop files into `assets/sounds/`:

```
assets/sounds/whip.mp3   # crack (.wav / .ogg also work)
assets/sounds/pat.mp3    # pat chime
```

By default your file plays on top of the built-in synth. To hear only your file:

```bash
KORBAJ_SOUND_MODE=replace npm start
```

## 🧠 How it works

```
main.js ──(cursor poll 120Hz, state)──► preload.js ──► renderer.js ──► Canvas 2D
   │                                                       │
   ├─ transparent always-on-top window                     ├─ Verlet physics + crack detection
   ├─ globalShortcut + Tray                                ├─ VFX: particles / rings / lashes / fire
   └─ custom sound loader (IPC)                            └─ sound.js (Web Audio synth)
```

- **The cursor comes from the main process** (`screen.getCursorScreenPoint`), not from DOM events.
  `setIgnoreMouseEvents(true, { forward: true })` sends no mouse moves on Linux, so polling is the only way
  click-through whipping works on every OS.
- **Tip-heavy inverse mass** is the trick behind a believable crack. Momentum moving into lighter and lighter
  segments makes the tip speed up, which is the same physics as a real whip.

## ⚙️ Tuning

All tunables live in `CFG` at the top of `renderer.js`:

| Key | Default | Effect |
|---|---|---|
| `intentSpeed` | `2300` | Minimum hand speed (px/s) for a crack. Lower = easier cracks |
| `crackSpeedFactor` | `3.0` | Tip-speed threshold × screen height per second |
| `wrist` | `0.012` | Lower = handle swings more freely |
| `nodes` / `segLen` | `28` / `10.5` | Cord length and resolution |
| `fireAt` | `5` | Combo needed for Fire Whip |
| `tauntChance` | `0.4` | How often taunts pop up |

## 🐧 Linux / Wayland (Hyprland, GNOME, KDE…)

Wayland deliberately forbids apps from (a) reading the global cursor and (b) grabbing global
keys. Korbaj works around both:

| Problem | Korbaj's answer |
|---|---|
| Cursor position hidden | On **Hyprland** it reads the cursor over Hyprland's IPC socket (any monitor). Elsewhere it uses XWayland |
| Click-through | Runs under **XWayland** (`npm start` passes `--ozone-platform=x11`), where input pass-through works |
| Window gets tiled / steals the screen | On Hyprland it makes itself floating, pinned to all workspaces, and borderless, then gives focus back |
| Global shortcuts blocked | Bind `bin/korbaj.js` in your compositor. It talks to the running app over a local socket |

### Hyprland setup (one line)

```ini
# ~/.config/hypr/hyprland.conf
source = ~/Korbaj/extras/hyprland.conf
```

That gives you `Alt+W / Alt+C / Alt+1-3 / Alt+Shift+Q` system-wide. `Alt+W` also **starts**
Korbaj if it isn't running.

### Control from anywhere (any OS, any hotkey tool)

```bash
node bin/korbaj.js toggle     # summon / hide (starts it if needed)
node bin/korbaj.js passive    # click-through ↔ active
node bin/korbaj.js mode 2     # 1 whip · 2 dual · 3 pat
node bin/korbaj.js status
node bin/korbaj.js quit
```

On startup the terminal prints what Korbaj detected, e.g.
`[korbaj] session=wayland desktop=Hyprland cursor=hyprland shortcuts=ok`. Include that line when reporting bugs.

**GNOME / KDE on Wayland:** there's no cursor IPC, so in click-through mode the whip only follows the
cursor while it's over XWayland windows. Use Active mode (`passive` command) or log into an X11
session for the full experience.

### Other platforms

- **macOS:** a real `fullscreen: true` opens a separate Space, so the window is sized to the display instead
  (`KORBAJ_TRUE_FULLSCREEN=1` forces it).
- **Multi-monitor:** the overlay jumps to whichever monitor your cursor is on.

## 📁 Project structure

```
Korbaj/
├── main.js          # window, shortcuts, tray, cursor polling, monitor follow
├── lib/hyprland.js  # Hyprland IPC: global cursor + overlay window setup
├── lib/control.js   # local control socket
├── bin/korbaj.js    # CLI: toggle / passive / mode / quit
├── extras/hyprland.conf
├── preload.js       # secure IPC bridge
├── index.html       # canvas + HUD
├── renderer.js      # physics, VFX, modes
├── sound.js         # procedural Web Audio engine
├── assets/sounds/   # optional custom sounds
└── docs/            # screenshots & demo
```

---

<div align="center">

Made with 💢 and ❤️ for everyone waiting on a slow model.
**اخلص يا عم!**

MIT License

</div>

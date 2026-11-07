# Korbaj — كرباج ⚡ (AI Response Accelerator)

A transparent, always-on-top desktop overlay that puts a physics-simulated whip on your
cursor. Flick to crack it at your slow AI. Or pat it when it does well.

## Run

```bash
npm install
npm start
```

Fallbacks:

```bash
npm run start:nogpu   # black background / GPU glitches
npm run start:x11     # Wayland blocks global shortcuts → force XWayland
```

## Controls

| Key     | Action |
|---------|--------|
| `Alt+W` | Summon / hide |
| `Alt+C` | Click-Through (default) ↔ Active (left-click = crack) |
| `Alt+1` | Single whip |
| `Alt+2` | Dual whips |
| `Alt+3` | Pat mode ✋ — rub left/right gently |
| `Alt+Q` | Quit |

Everything is also in the tray menu.

## How it works

- **Cursor tracking** is polled from the main process (`screen.getCursorScreenPoint`, ~120 Hz),
  not DOM events — `setIgnoreMouseEvents(..., {forward:true})` doesn't forward moves on Linux,
  so this is the only way flick-cracking works in click-through mode on every OS.
- **Physics**: 28-node Verlet rope, 120 Hz fixed substeps, 16 constraint iterations, and a
  tapered inverse-mass profile (lighter toward the tip) — that's what makes the loop accelerate
  and the tip break the crack threshold, exactly like a real whip.
- **Crack**: fires when tip speed > 3400 px/s, or forced ~110 ms after a click-snap.
- **Combo**: 5+ cracks with < 2 s gaps → Fire Whip.
- **Sound**: fully procedural (Web Audio). Drop `whip.mp3` / `pat.mp3` into `assets/sounds/`
  to layer your own; `KORBAJ_SOUND_MODE=replace npm start` to use only yours.

## Known platform limits

- **Wayland (GNOME/KDE)**: global shortcuts and always-on-top may be ignored by the compositor.
  Use `npm run start:x11` or the tray menu.
- **macOS**: real `fullscreen: true` would open a separate Space and hide your apps, so the window
  is sized to the display instead. Force it with `KORBAJ_TRUE_FULLSCREEN=1`.
- The overlay covers the display your cursor is on at summon time.

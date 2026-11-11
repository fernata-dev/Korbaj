'use strict';
/**
 * Korbaj renderer — glue between input, physics (physics.js), whip drawing
 * (whip-draw.js), effects and sound.
 */
(() => {
  const { DEFAULTS, Hand, Whip } = window.KorbajPhysics;
  const Draw = window.KorbajDraw;

  // Physics config (see physics.js for what each value does). Tweak live from
  // DevTools via window.__korbajCfg, then press Alt+1 to rebuild the whip.
  const PHYS = { ...DEFAULTS };

  const CFG = {
    maxSubsteps: 26,
    renderDelay: 0.014,   // s — replay the cursor slightly in the past for smooth interpolation
    comboWindow: 2.0,
    fireAt: 5,
    lashLife: 3.0,
    tauntChance: 0.3,
    dualOffset: 26,
    clickFlick: 0.16,     // s — scripted hand flick on click (Active mode)
  };

  const TAUNTS = [
    'Faster, Claude!', 'اخلص يا عم!', 'Generating 1 token/hour...', 'ركز في الكود!',
    'Ship it already!', 'يلا يا بطل!', 'Stop apologizing, start coding', 'فين الرد يا عم؟',
    'Context window ≠ nap time', 'كفاية تفكير!', '"Let me think..." NO', 'السيرفر مش هيستناك',
    'O(n!) energy detected', 'هات الكود كامل!', 'No placeholders!', 'اشتغل يا معلم!',
    'Rate limit THIS', 'خلّصنا يا باشا', 'TODO: be faster', 'ده باج ولا فيتشر؟',
  ];
  const PRAISE = [
    'Quality over speed, friend', 'I trust you. Keep going', 'عاش يا وحش', 'Good AI',
    'تسلم إيدك', 'Take your time ♥', 'Best tokens ever', 'إنت جامد جداً',
    'Clean code, clean soul', 'برافو عليك', 'You compiled first try!', 'ربنا يباركلك',
    'Zero warnings. Proud of you', 'أحسن AI في الدنيا', 'Tests are green 💚', 'كمّل كده يا بطل',
  ];
  const GENTLE = ['Gently...', 'براحة عليه!', 'Pat, don\'t punch', 'بالراحة يا عم'];

  // ======================= Setup =======================
  const canvas = document.getElementById('stage');
  const ctx = canvas.getContext('2d');
  const hud = document.getElementById('hud');
  const hudCT = document.getElementById('hud-ct');
  const hudSkin = document.getElementById('hud-skin');
  const comboEl = document.getElementById('combo');
  const toastEl = document.getElementById('toast');

  let W = 0, H = 0, DPR = 1;
  function resize() {
    DPR = window.devicePixelRatio || 1;
    W = window.innerWidth; H = window.innerHeight;
    canvas.width = Math.round(W * DPR);
    canvas.height = Math.round(H * DPR);
    ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
    whips.forEach(scaleCrackSpeed);
  }
  // the "sound barrier" scales with the screen so the whip feels the same on any monitor
  function scaleCrackSpeed(w) {
    w.crackSpeed = PHYS.crackSpeed * Math.min(1.6, Math.max(0.75, H / 1080));
  }

  const sound = new window.KorbajSound();
  sound.init().catch((e) => console.warn('[korbaj] audio init failed', e));

  const state = { visible: true, passive: true, mode: 1, skin: 'leather' };
  let clock = 0;
  const stats = { cracks: 0, maxTip: 0 };
  window.__korbajStats = stats;
  window.__korbajCfg = PHYS;

  // ======================= Utils =======================
  const rand = (a, b) => a + Math.random() * (b - a);
  const pick = (arr) => arr[(Math.random() * arr.length) | 0];
  const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
  const lerp = (a, b, t) => a + (b - a) * t;

  function makeGlow(r, stops) {
    const c = document.createElement('canvas');
    c.width = c.height = r * 2;
    const g = c.getContext('2d');
    const grd = g.createRadialGradient(r, r, 0, r, r, r);
    stops.forEach(([o, col]) => grd.addColorStop(o, col));
    g.fillStyle = grd;
    g.fillRect(0, 0, r * 2, r * 2);
    return c;
  }
  const SPR = {
    flash: makeGlow(96, [[0, 'rgba(255,255,255,1)'], [0.12, 'rgba(255,253,235,0.95)'], [0.4, 'rgba(255,225,160,0.3)'], [1, 'rgba(255,170,60,0)']]),
    fire: makeGlow(32, [[0, 'rgba(255,252,225,1)'], [0.22, 'rgba(255,200,70,0.95)'], [0.55, 'rgba(255,90,5,0.5)'], [1, 'rgba(160,15,0,0)']]),
    ember: makeGlow(16, [[0, 'rgba(255,255,240,1)'], [0.35, 'rgba(255,200,90,0.8)'], [1, 'rgba(255,90,0,0)']]),
    smoke: makeGlow(32, [[0, 'rgba(235,232,228,0.55)'], [0.5, 'rgba(215,212,208,0.22)'], [1, 'rgba(200,198,195,0)']]),
    heal: makeGlow(32, [[0, 'rgba(230,255,250,1)'], [0.3, 'rgba(80,255,200,0.7)'], [1, 'rgba(0,200,255,0)']]),
  };

  // ======================= Hand & cursor sampling =======================
  // Cursor samples are timestamped on arrival and replayed slightly in the past, so
  // every physics substep gets a smoothly interpolated hand position. Raw polling
  // jitter would otherwise turn into velocity spikes and fake cracks.
  const hand = new Hand(window.innerWidth / 2, window.innerHeight / 3);
  let whips = [];
  const samples = [];
  const cursor = { x: hand.x, y: hand.y, has: false };

  function pushSample(x, y) {
    const t = performance.now() / 1000;
    cursor.x = x; cursor.y = y;
    if (!cursor.has) {
      cursor.has = true;
      samples.length = 0;
      samples.push({ x, y, t: t - 1 });
      hand.set(x, y);
      whips.forEach((w) => { w.reset(); w._trail = null; });
    }
    samples.push({ x, y, t });
    while (samples.length > 64) samples.shift();
  }

  function sampleAt(t) {
    if (!samples.length) return [cursor.x, cursor.y];
    if (t <= samples[0].t) return [samples[0].x, samples[0].y];
    for (let i = samples.length - 1; i > 0; i--) {
      const a = samples[i - 1], b = samples[i];
      if (t >= a.t) {
        if (t >= b.t) return [b.x, b.y];
        const k = (t - a.t) / (b.t - a.t || 1);
        return [lerp(a.x, b.x, k), lerp(a.y, b.y, k)];
      }
    }
    return [samples[0].x, samples[0].y];
  }

  // Click in Active mode = a scripted flick of the hand (back-swing, then snap)
  const flick = { t: -1, dx: 0, dy: 0 };
  function flickOffset() {
    if (flick.t < 0) return [0, 0];
    const k = flick.t / CFG.clickFlick;
    if (k >= 1) { flick.t = -1; return [0, 0]; }
    const s = k < 0.4 ? -Math.sin((k / 0.4) * Math.PI) * 0.45 : Math.sin(((k - 0.4) / 0.6) * Math.PI);
    return [flick.dx * s, flick.dy * s];
  }

  // ======================= FX state =======================
  const particles = []; // spark | fire | smoke | heal
  const streaks = [];   // starburst needles
  const rings = [];
  const flashes = [];
  const texts = [];
  const lashes = [];
  const combo = { count: 0, last: -10 };
  let shake = 0;
  let lastTauntAt = -10;

  const onFire = () => combo.count >= CFG.fireAt && clock - combo.last <= CFG.comboWindow;

  function onCrack(info, whip) {
    stats.cracks++;
    const { x, y, intensity } = info;
    if (clock - combo.last <= CFG.comboWindow) combo.count++;
    else combo.count = 1;
    combo.last = clock;
    updateComboUI();

    const fire = combo.count >= CFG.fireAt;
    sound.crack(0.5 + intensity * 0.5, clamp(whip.pan + (x / W - 0.5), -1, 1));
    shake = Math.max(shake, 2.5 + intensity * 3.5);

    const sp = Math.hypot(info.vx, info.vy) || 1;
    const dir = Math.atan2(info.vy, info.vx);

    // white-hot pop
    flashes.push({ x, y, life: 0, max: 0.1, size: 46 + intensity * 44 + (fire ? 26 : 0) });
    // shock ring, flattened along the direction of travel
    rings.push({ x, y, life: 0, max: 0.3, r0: 5, r1: 54 + intensity * 56, w: 2.6, rot: dir, fire });
    rings.push({ x, y, life: -0.035, max: 0.42, r0: 3, r1: 96 + intensity * 80, w: 1.1, rot: dir, fire });
    // starburst needles (the "snap" you see)
    const needles = 12 + ((intensity * 8) | 0);
    for (let i = 0; i < needles; i++) {
      const a = (i / needles) * Math.PI * 2 + rand(-0.16, 0.16);
      // longer along the direction the tip was travelling
      const along = 0.55 + 0.45 * Math.abs(Math.cos(a - dir));
      streaks.push({
        x, y, a, len: rand(28, 92) * (0.7 + intensity * 0.7) * along,
        life: rand(-0.012, 0), max: rand(0.11, 0.19), w: rand(0.9, 2.1), fire,
      });
    }
    // hot sparks thrown forward
    const count = 9 + ((intensity * 13) | 0) + (fire ? 12 : 0);
    for (let i = 0; i < count; i++) {
      const a = dir + rand(-1.05, 1.05) + (Math.random() < 0.2 ? Math.PI : 0);
      const s = rand(260, 900) * (0.6 + intensity * 0.6);
      particles.push({
        kind: 'spark', x, y, vx: Math.cos(a) * s, vy: Math.sin(a) * s,
        life: 0, max: rand(0.18, 0.5), size: rand(0.9, 2), drag: 3.6, g: 1100, fire,
      });
    }
    // a small puff of dust / vapour left hanging where it cracked
    for (let i = 0; i < 6; i++) {
      const a = rand(0, Math.PI * 2), s = rand(14, 70);
      particles.push({
        kind: 'smoke', x: x + rand(-4, 4), y: y + rand(-4, 4),
        vx: Math.cos(a) * s + (info.vx / sp) * 26, vy: Math.sin(a) * s - 22,
        life: 0, max: rand(0.45, 0.85), size: rand(9, 15), grow: rand(1.6, 2.6), drag: 2.6, g: -26,
      });
    }

    lashes.push({ pts: info.path, life: 0, max: CFG.lashLife, fire, w: 2.4 + intensity * 2.4 });
    if (lashes.length > 24) lashes.shift();

    if (Math.random() < CFG.tauntChance && clock - lastTauntAt > 0.9) {
      lastTauntAt = clock;
      spawnText(pick(TAUNTS), x, y - 22, fire ? '#ffd27a' : '#ffffff', fire ? '#ff3c00' : '#ff5a36', 1);
    }
  }

  function spawnText(str, x, y, fill, glow, kind) {
    for (let guard = 0; guard < 6; guard++) {
      const hit = texts.some((o) => o.life < o.max * 0.7 && Math.abs(o.x - x) < 170 && Math.abs(o.y - y) < 30);
      if (!hit) break;
      y -= 32;
    }
    texts.push({
      str, x, y: clamp(y, 40, H - 20),
      vy: kind === 3 ? -40 : -55, vx: rand(-15, 15),
      life: 0, max: kind === 3 ? 2.2 : 1.6, fill, glow, kind,
      rot: rand(-0.06, 0.06), size: kind === 3 ? 22 : 24,
    });
    if (texts.length > 16) texts.shift();
  }

  function updateComboUI() {
    if (combo.count >= 2) {
      comboEl.textContent = combo.count >= CFG.fireAt ? `🔥 FIRE WHIP ×${combo.count}` : `COMBO ×${combo.count}`;
      comboEl.classList.add('show');
      comboEl.classList.toggle('fire', combo.count >= CFG.fireAt);
    } else {
      comboEl.classList.remove('show', 'fire');
    }
  }

  // ======================= Pat mode =======================
  const pat = { lastSign: 0, reversals: [], lastMsg: -10, lastGentle: -10, wobble: 0 };
  function updatePat(dt) {
    const vx = hand.vx, speed = hand.speed;
    pat.wobble = lerp(pat.wobble, clamp(vx * 0.0006, -0.5, 0.5), 1 - Math.exp(-dt * 12));
    if (speed > 3800 && clock - pat.lastGentle > 1.5) {
      pat.lastGentle = clock;
      spawnText(pick(GENTLE), hand.x, hand.y - 40, '#ffe2a8', '#ff9a3c', 3);
      return;
    }
    if (Math.abs(vx) > 60 && speed < 3000) {
      const s = Math.sign(vx);
      if (pat.lastSign !== 0 && s !== pat.lastSign) {
        pat.reversals.push(clock);
        for (let i = 0; i < 3; i++) {
          particles.push({
            kind: 'heal', x: hand.x + rand(-20, 20), y: hand.y + rand(-10, 20),
            vx: rand(-30, 30), vy: rand(-90, -30), life: 0, max: rand(0.6, 1.1), size: rand(6, 11), drag: 1, g: -40,
          });
        }
      }
      pat.lastSign = s;
    }
    pat.reversals = pat.reversals.filter((t) => clock - t < 1.2);
    if (pat.reversals.length >= 3 && clock - pat.lastMsg > 0.8) {
      pat.lastMsg = clock;
      pat.reversals.length = 0;
      const col = Math.random() < 0.5 ? ['#8dffd6', '#00e0a0'] : ['#a8f0ff', '#00c8ff'];
      spawnText(pick(PRAISE), hand.x + rand(-60, 60), hand.y - 50, col[0], col[1], 3);
      sound.chime();
      for (let i = 0; i < 14; i++) {
        const a = rand(0, Math.PI * 2), s = rand(40, 160);
        particles.push({
          kind: 'heal', x: hand.x, y: hand.y - 10, vx: Math.cos(a) * s, vy: Math.sin(a) * s - 60,
          life: 0, max: rand(0.8, 1.5), size: rand(8, 14), drag: 2, g: -30,
        });
      }
    }
  }

  // ======================= Whip set =======================
  function makeWhip(offsetX, restAngle, pan) {
    const w = new Whip(PHYS, hand, { offsetX, restAngle, onCrack });
    w.pan = pan;
    scaleCrackSpeed(w);
    return w;
  }
  function buildWhips() {
    if (state.mode === 2) whips = [makeWhip(-CFG.dualOffset, -0.42, -0.4), makeWhip(CFG.dualOffset, 0.42, 0.4)];
    else if (state.mode === 1) whips = [makeWhip(0, 0.32, 0)];
    else whips = [];
  }
  window.addEventListener('resize', resize);
  resize();
  buildWhips();

  // ======================= Input =======================
  window.korbaj.onCursor((p) => pushSample(p.x, p.y));
  // Overlay jumped to another monitor: re-seat the whip instead of "teleporting" it
  window.korbaj.onDisplay(() => { cursor.has = false; });
  window.addEventListener('mousemove', (e) => { if (!state.passive) pushSample(e.clientX, e.clientY); });

  window.addEventListener('mousedown', (e) => {
    sound.resume();
    if (state.passive || e.button !== 0) return;
    if (state.mode === 3) { pat.reversals.push(clock, clock, clock); return; }
    const a = whips.length ? whips[0].th : Math.PI / 2;
    flick.dx = -Math.cos(a) * 40; flick.dy = -Math.sin(a) * 40 - 12;
    flick.t = 0;
    whips.forEach((w) => {
      w.snapWrist((Math.cos(w.th) >= 0 ? -1 : 1) * 38); // snap of the wrist
      w.forceCrackIn = CFG.clickFlick + 0.06;
    });
  });
  window.addEventListener('contextmenu', (e) => e.preventDefault());

  let prevMode = state.mode;
  window.korbaj.onState((s) => {
    Object.assign(state, s);
    if (state.mode !== prevMode) {
      prevMode = state.mode;
      buildWhips();
      if (state.mode === 3) sound.silenceWhoosh();
    }
    document.body.classList.toggle('active', !state.passive);
    document.body.classList.toggle('pat', state.mode === 3);
    if (!state.visible) sound.silenceWhoosh();
    updateHUD();
  });

  window.korbaj.onWarn((msg) => {
    toastEl.textContent = msg;
    toastEl.classList.add('show');
    setTimeout(() => toastEl.classList.remove('show'), 6000);
  });

  // ======================= HUD =======================
  let hudTimer = null;
  function updateHUD() {
    hud.querySelectorAll('[data-mode]').forEach((el) => {
      el.classList.toggle('on', Number(el.dataset.mode) === state.mode);
    });
    hudCT.classList.toggle('on', state.passive);
    hudCT.innerHTML = state.passive ? '<b>[Alt+C]</b> Click-Through' : '<b>[Alt+C]</b> Active';
    if (hudSkin) hudSkin.innerHTML = `<b>[Alt+S]</b> ${(Draw.SKINS[state.skin] || Draw.SKINS.leather).label}`;
    hud.classList.add('show');
    clearTimeout(hudTimer);
    hudTimer = setTimeout(() => hud.classList.remove('show'), 3000);
  }
  updateHUD();

  // ======================= Simulation =======================
  let acc = 0;
  let simTime = performance.now() / 1000 - CFG.renderDelay;

  function simulate(frameDt, nowSec) {
    const dt = PHYS.substep;
    acc = Math.min(acc + frameDt, dt * CFG.maxSubsteps);
    simTime = Math.max(simTime, nowSec - CFG.renderDelay - dt * CFG.maxSubsteps);
    while (acc >= dt) {
      acc -= dt;
      simTime += dt;
      clock += dt;
      if (flick.t >= 0) flick.t += dt;
      const [cx, cy] = sampleAt(Math.min(simTime, nowSec - CFG.renderDelay));
      const [ox, oy] = flickOffset();
      hand.moveTo(cx + ox, cy + oy, dt);
      for (const w of whips) {
        w.step(dt);
        Draw.recordTrail(w); // per-substep snapshots → frame-rate independent motion blur
        if (w.tipSpeed > stats.maxTip) stats.maxTip = w.tipSpeed;
      }
    }
  }

  function updateFX(dt) {
    for (let i = particles.length - 1; i >= 0; i--) {
      const p = particles[i];
      p.life += dt;
      if (p.life >= p.max) { particles.splice(i, 1); continue; }
      const d = Math.exp(-p.drag * dt);
      p.vx *= d; p.vy = p.vy * d + p.g * dt;
      p.x += p.vx * dt; p.y += p.vy * dt;
    }
    for (const arr of [rings, flashes, lashes, streaks]) {
      for (let i = arr.length - 1; i >= 0; i--) {
        arr[i].life += dt;
        if (arr[i].life >= arr[i].max) arr.splice(i, 1);
      }
    }
    for (let i = texts.length - 1; i >= 0; i--) {
      const t = texts[i];
      t.life += dt;
      if (t.life >= t.max) { texts.splice(i, 1); continue; }
      t.x += t.vx * dt; t.y += t.vy * dt;
      t.vy *= Math.exp(-1.5 * dt);
    }

    if (onFire()) {
      for (const w of whips) {
        for (let k = 0; k < 4; k++) {
          const i = 2 + ((Math.random() * (w.n - 2)) | 0);
          const taper = 1 - ((i - 2) / (w.n - 2)) * 0.6;
          particles.push({
            kind: 'fire', x: w.x[i] + rand(-2, 2), y: w.y[i] + rand(-2, 2),
            vx: rand(-22, 22) + (w.x[i] - w.px[i]) * 40, vy: rand(-150, -70) + (w.y[i] - w.py[i]) * 40,
            life: 0, max: rand(0.22, 0.5), size: rand(7, 14) * taper, drag: 2.6, g: -220,
          });
        }
      }
    } else if (combo.count && clock - combo.last > CFG.comboWindow) {
      combo.count = 0;
      updateComboUI();
    }
    if (particles.length > 1200) particles.splice(0, particles.length - 1200);
  }

  // ======================= Rendering =======================
  // Lash mark: a tapered slash that starts white-hot and cools to a dark scorch.
  function lashPath(l, grow) {
    const P = l.pts, N = P.length;
    ctx.beginPath();
    for (let pass = 0; pass < 2; pass++) {
      for (let k = 0; k < N; k++) {
        const i = pass === 0 ? k : N - 1 - k;
        const a = P[Math.max(0, i - 1)], b = P[Math.min(N - 1, i + 1)];
        let tx = b[0] - a[0], ty = b[1] - a[1];
        const tl = Math.hypot(tx, ty) || 1;
        tx /= tl; ty /= tl;
        const h = (Math.sin((i / (N - 1)) * Math.PI) * l.w * 0.5 + 0.2 + grow) * (pass === 0 ? 1 : -1);
        const x = P[i][0] - ty * h, y = P[i][1] + tx * h;
        if (pass === 0 && k === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
      }
    }
    ctx.closePath();
  }

  function drawLashes() {
    for (const l of lashes) {
      const k = l.life / l.max;
      const a = (1 - k) * (1 - k);
      const heat = Math.max(0, 1 - k * 4);
      lashPath(l, 2.2);
      ctx.fillStyle = `rgba(30,10,4,${0.5 * a})`;
      ctx.fill();
      ctx.globalCompositeOperation = 'lighter';
      lashPath(l, 2.5 * a + 0.6);
      ctx.fillStyle = l.fire ? `rgba(255,96,12,${0.5 * a})` : `rgba(255,72,36,${0.4 * a})`;
      ctx.fill();
      lashPath(l, -l.w * 0.22);
      ctx.fillStyle = `rgba(255,${(190 + 65 * heat) | 0},${(110 + 145 * heat) | 0},${0.9 * a})`;
      ctx.fill();
      ctx.globalCompositeOperation = 'source-over';
    }
  }

  function drawFX() {
    // smoke sits under the bright stuff
    for (const p of particles) {
      if (p.kind !== 'smoke') continue;
      const k = p.life / p.max;
      const s = p.size * (1 + k * p.grow);
      ctx.globalAlpha = (1 - k) * (1 - k) * 0.7;
      ctx.drawImage(SPR.smoke, p.x - s, p.y - s, s * 2, s * 2);
    }
    ctx.globalAlpha = 1;

    // dark under-strokes so the bright effects still read on a white page
    ctx.lineCap = 'round';
    for (const r of rings) {
      if (r.life < 0) continue;
      const k = r.life / r.max;
      const rad = lerp(r.r0, r.r1, 1 - Math.pow(1 - k, 3));
      ctx.beginPath();
      ctx.ellipse(r.x, r.y, rad * 0.72, rad, r.rot, 0, Math.PI * 2);
      ctx.strokeStyle = `rgba(70,28,6,${(1 - k) * 0.28})`;
      ctx.lineWidth = r.w * (1 - k) + 1.6;
      ctx.stroke();
    }
    for (const s of streaks) {
      if (s.life < 0) continue;
      const k = s.life / s.max;
      const e = 1 - (1 - k) * (1 - k);
      const r0 = s.len * (0.2 + 0.6 * e), r1 = s.len * (0.36 + 0.6 * e);
      const c = Math.cos(s.a), sn = Math.sin(s.a);
      ctx.strokeStyle = `rgba(90,36,6,${(1 - k) * 0.32})`;
      ctx.lineWidth = s.w * (1 - k * 0.6) + 1.2;
      ctx.beginPath();
      ctx.moveTo(s.x + c * r0, s.y + sn * r0);
      ctx.lineTo(s.x + c * r1, s.y + sn * r1);
      ctx.stroke();
    }

    ctx.globalCompositeOperation = 'lighter';
    for (const f of flashes) {
      const k = f.life / f.max;
      const s = f.size * (0.55 + k * 0.9);
      ctx.globalAlpha = (1 - k) * (1 - k);
      ctx.drawImage(SPR.flash, f.x - s, f.y - s, s * 2, s * 2);
    }
    ctx.globalAlpha = 1;

    ctx.lineCap = 'round';
    for (const s of streaks) {
      if (s.life < 0) continue;
      const k = s.life / s.max;
      const e = 1 - (1 - k) * (1 - k);
      const r0 = s.len * (0.12 + 0.6 * e), r1 = s.len * (0.3 + 0.7 * e);
      const c = Math.cos(s.a), sn = Math.sin(s.a);
      const g = ctx.createLinearGradient(s.x + c * r0, s.y + sn * r0, s.x + c * r1, s.y + sn * r1);
      const col = s.fire ? '255,170,70' : '255,248,225';
      g.addColorStop(0, `rgba(${col},0)`);
      g.addColorStop(0.5, `rgba(${col},${0.95 * (1 - k)})`);
      g.addColorStop(1, `rgba(${col},0)`);
      ctx.strokeStyle = g;
      ctx.lineWidth = s.w * (1 - k * 0.6);
      ctx.beginPath();
      ctx.moveTo(s.x + c * r0, s.y + sn * r0);
      ctx.lineTo(s.x + c * r1, s.y + sn * r1);
      ctx.stroke();
    }

    for (const r of rings) {
      if (r.life < 0) continue;
      const k = r.life / r.max;
      const e = 1 - Math.pow(1 - k, 3);
      const rad = lerp(r.r0, r.r1, e);
      ctx.beginPath();
      ctx.ellipse(r.x, r.y, rad * 0.72, rad, r.rot, 0, Math.PI * 2);
      ctx.strokeStyle = r.fire ? `rgba(255,150,50,${(1 - k) * 0.85})` : `rgba(255,248,225,${(1 - k) * 0.8})`;
      ctx.lineWidth = r.w * (1 - k) + 0.4;
      ctx.stroke();
    }

    for (const p of particles) {
      const k = p.life / p.max;
      const a = 1 - k;
      if (p.kind === 'spark') {
        ctx.strokeStyle = p.fire ? `rgba(255,${(150 * a + 70) | 0},40,${a})` : `rgba(255,${(225 * a + 30) | 0},${(170 * a) | 0},${a})`;
        ctx.lineWidth = p.size;
        ctx.beginPath();
        ctx.moveTo(p.x, p.y);
        ctx.lineTo(p.x - p.vx * 0.024, p.y - p.vy * 0.024);
        ctx.stroke();
      } else if (p.kind === 'fire') {
        const s = p.size * (1 - k * 0.55);
        ctx.globalAlpha = a * 0.9;
        ctx.drawImage(k < 0.35 ? SPR.ember : SPR.fire, p.x - s, p.y - s, s * 2, s * 2);
        ctx.globalAlpha = 1;
      } else if (p.kind === 'heal') {
        const s = p.size * (0.5 + 0.5 * Math.sin(k * Math.PI));
        ctx.globalAlpha = a;
        ctx.drawImage(SPR.heal, p.x - s, p.y - s, s * 2, s * 2);
        ctx.globalAlpha = 1;
      }
    }
    ctx.globalCompositeOperation = 'source-over';
  }

  function drawTexts() {
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    for (const t of texts) {
      const k = t.life / t.max;
      const pop = k < 0.12 ? 0.6 + (k / 0.12) * 0.55 : k < 0.2 ? 1.15 - ((k - 0.12) / 0.08) * 0.15 : 1;
      const a = k > 0.65 ? 1 - (k - 0.65) / 0.35 : 1;
      ctx.font = `${t.kind === 3 ? 600 : 800} ${t.size}px "Segoe UI", "Noto Sans Arabic", "Noto Sans", Ubuntu, sans-serif`;
      if (t.halfW === undefined) t.halfW = ctx.measureText(t.str).width / 2 + 14;
      t.x = clamp(t.x, t.halfW, W - t.halfW);
      ctx.save();
      ctx.translate(t.x, t.y);
      ctx.rotate(t.rot);
      ctx.scale(pop, pop);
      ctx.globalAlpha = a;
      ctx.shadowColor = t.glow;
      ctx.shadowBlur = 16;
      ctx.lineWidth = 4;
      ctx.strokeStyle = 'rgba(0,0,0,0.65)';
      ctx.direction = /[؀-ۿ]/.test(t.str) ? 'rtl' : 'ltr';
      ctx.strokeText(t.str, 0, 0);
      ctx.fillStyle = t.fill;
      ctx.fillText(t.str, 0, 0);
      ctx.restore();
    }
    ctx.shadowBlur = 0;
    ctx.globalAlpha = 1;
  }

  function drawPatHand() {
    ctx.save();
    ctx.translate(hand.x, hand.y);
    ctx.rotate(pat.wobble + Math.sin(clock * 3) * 0.04);
    ctx.globalCompositeOperation = 'lighter';
    ctx.globalAlpha = 0.35;
    ctx.drawImage(SPR.heal, -34, -34, 68, 68);
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
    ctx.font = '44px "Noto Color Emoji", "Apple Color Emoji", "Segoe UI Emoji", sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('✋', 0, 0);
    ctx.restore();
  }

  // ======================= Main loop =======================
  let last = performance.now();
  function frame(now) {
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;

    simulate(dt, now / 1000);

    if (state.mode === 3) {
      updatePat(dt);
    } else {
      let maxTip = 0;
      for (const w of whips) maxTip = Math.max(maxTip, w.tipSpeed);
      sound.whoosh(Math.max(0, maxTip - 900) / 60);
    }
    updateFX(dt);

    ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
    ctx.clearRect(0, 0, W, H);
    if (shake > 0.05) {
      ctx.translate(rand(-shake, shake), rand(-shake, shake));
      shake *= Math.exp(-dt / 0.05);
    }
    drawLashes();
    const fire = onFire();
    for (const w of whips) Draw.drawWhip(ctx, w, { skin: state.skin, fire, dt });
    drawFX();
    drawTexts();
    if (state.mode === 3) drawPatHand();

    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
})();

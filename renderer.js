'use strict';
/**
 * Korbaj renderer — rigid-handle + Verlet cord whip physics, VFX and interaction.
 *
 * Physics model (all in CSS px and seconds, fixed 240 Hz substeps):
 *   node 0      grip — kinematic, follows the (interpolated) cursor
 *   node 1      end of the handle — heavy rigid stick hinged at the grip, with a soft
 *               "wrist" spring toward a rest angle. It swings and rotates naturally.
 *   node 2..N   cord — point masses joined by inextensible distance constraints,
 *               lighter toward the tip (tapered mass), gravity + quadratic air drag.
 *
 * Crack = the real-world signature, not just "tip is fast":
 *   tip speed (smoothed) above a sound-barrier threshold scaled to the screen
 *   AND the hand itself moved fast/deliberately (intentSpeed) — small moves never crack
 *   AND tip at least 2× faster than the hand (energy concentrated in the tip)
 *   AND cord almost fully extended (the loop has unrolled to the end)
 *   AND the detector has re-armed since the last crack (hysteresis).
 */
(() => {
  // ======================= Config =======================
  const CFG = {
    cordNodes: 26,
    segLen: 11,                 // cord ≈ 286 px
    handleLen: 64,
    gravity: 1800,              // px/s²
    airDrag: 0.00055,           // quadratic drag coefficient (1/px)
    linDamp: 0.9996,            // tiny internal friction per substep
    handleInvMass: 0.12,        // handle is ~8× heavier than a cord node
    tipMassRatio: 40,           // tip is 40× lighter than the cord root (exponential taper)
    wrist: 0.012,               // wrist spring stiffness toward rest angle (per substep) — low = handle swings freely
    iterations: 16,
    substep: 1 / 240,
    maxSubsteps: 12,
    renderDelay: 0.014,         // s — sample cursor slightly in the past for smooth interpolation
    crackSpeedFactor: 3.0,      // threshold = factor × screen height per second (≈3240 px/s @1080p)
    crackRatio: 2.0,            // tip speed / hand speed
    intentSpeed: 2300,          // hand must have moved at least this fast (px/s) in the last ~0.25 s
    crackExtension: 0.86,       // fraction of full cord length
    rearmFactor: 0.45,          // must drop below threshold×this before the next crack
    crackCooldown: 0.22,
    maxTipSpeed: 14000,
    comboWindow: 2.0,
    fireAt: 5,
    lashLife: 3.0,
    tauntChance: 0.3,
    dualOffset: 26,
    clickFlick: 0.2,            // s — duration of the scripted wrist flick on click
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
  const comboEl = document.getElementById('combo');
  const toastEl = document.getElementById('toast');

  let W = 0, H = 0, DPR = 1;
  function resize() {
    DPR = window.devicePixelRatio || 1;
    W = window.innerWidth; H = window.innerHeight;
    canvas.width = Math.round(W * DPR);
    canvas.height = Math.round(H * DPR);
    ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
  }
  window.addEventListener('resize', resize);
  resize();
  const crackThreshold = () => Math.max(3200, CFG.crackSpeedFactor * Math.max(H, 600));

  const sound = new window.KorbajSound();
  sound.init().catch((e) => console.warn('[korbaj] audio init failed', e));

  const state = { visible: true, passive: true, mode: 1 };
  let clock = 0;
  const stats = { cracks: 0, maxTip: 0 };
  window.__korbajStats = stats; // handy for tuning from DevTools
  window.__korbajCfg = CFG;

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
    flash: makeGlow(128, [[0, 'rgba(255,255,255,1)'], [0.15, 'rgba(255,250,215,0.9)'], [0.45, 'rgba(255,200,100,0.3)'], [1, 'rgba(255,120,0,0)']]),
    fire: makeGlow(32, [[0, 'rgba(255,250,220,1)'], [0.25, 'rgba(255,190,60,0.9)'], [0.6, 'rgba(255,80,0,0.45)'], [1, 'rgba(180,20,0,0)']]),
    spark: makeGlow(16, [[0, 'rgba(255,255,240,1)'], [0.4, 'rgba(255,215,130,0.7)'], [1, 'rgba(255,120,0,0)']]),
    heal: makeGlow(32, [[0, 'rgba(230,255,250,1)'], [0.3, 'rgba(80,255,200,0.7)'], [1, 'rgba(0,200,255,0)']]),
  };

  // ======================= Cursor sampling =======================
  // Samples are timestamped on arrival and replayed slightly in the past, so every
  // substep gets a smoothly interpolated hand position. Without this, polling jitter
  // turns into velocity spikes — which used to fake whip cracks.
  const samples = [];
  const cursor = { x: W / 2, y: H / 3, has: false };
  function pushSample(x, y) {
    const t = performance.now() / 1000;
    cursor.x = x; cursor.y = y;
    if (!cursor.has) {
      cursor.has = true;
      samples.length = 0;
      samples.push({ x, y, t: t - 1 });
      hand.x = x; hand.y = y;
      whips.forEach((w) => w.reset());
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

  // The "hand" = interpolated cursor + scripted flick offset (click in Active mode)
  const hand = { x: W / 2, y: H / 3, vx: 0, vy: 0, speed: 0, peak: 0 };
  const flick = { t: -1, dx: 0, dy: 0 };
  function flickOffset() {
    if (flick.t < 0) return [0, 0];
    const k = flick.t / CFG.clickFlick;
    if (k >= 1) { flick.t = -1; return [0, 0]; }
    // back-swing then a sharp forward snap: -sin for first 40%, strong + for the rest
    const s = k < 0.4 ? -Math.sin((k / 0.4) * Math.PI) * 0.45 : Math.sin(((k - 0.4) / 0.6) * Math.PI);
    return [flick.dx * s, flick.dy * s];
  }

  // ======================= Whip =======================
  class Whip {
    constructor(offsetX, restAngle, pan) {
      this.offsetX = offsetX;
      this.restAngle = restAngle; // radians, 0 = pointing down; + = toward the right
      this.pan = pan;
      this.n = 2 + CFG.cordNodes;
      const n = this.n;
      this.x = new Float64Array(n); this.y = new Float64Array(n);
      this.px = new Float64Array(n); this.py = new Float64Array(n);
      this.w = new Float64Array(n);
      this.len = new Float64Array(n); // rest length from node i-1 to i
      this.w[0] = 0;
      this.w[1] = CFG.handleInvMass;
      this.len[1] = CFG.handleLen;
      for (let i = 2; i < n; i++) {
        const k = (i - 2) / (n - 3);
        // Exponential taper: mass falls off geometrically toward the tip, like braided leather
        this.w[i] = Math.pow(CFG.tipMassRatio, k);
        this.len[i] = CFG.segLen;
      }
      this.cordLen = CFG.segLen * (n - 2);
      this.tipEma = 0;
      this.armed = true;
      this.cooldown = 0;
      this.forceCrackAt = -1;
      this.reset();
    }

    gripPos() { return [hand.x + this.offsetX, hand.y]; }

    reset() {
      const [gx, gy] = this.gripPos();
      const sx = Math.sin(this.restAngle), sy = Math.cos(this.restAngle);
      let x = gx, y = gy;
      for (let i = 0; i < this.n; i++) {
        if (i > 0) {
          // handle points along rest angle, cord hangs straight down
          if (i === 1) { x += sx * this.len[1]; y += sy * this.len[1]; } else { y += this.len[i]; }
        }
        this.x[i] = this.px[i] = x; this.y[i] = this.py[i] = y;
      }
      this.tipEma = 0;
    }

    handleAngle() { return Math.atan2(this.y[1] - this.y[0], this.x[1] - this.x[0]); }

    step(dt) {
      const { n, x, y, px, py, w, len } = this;
      const [gx, gy] = this.gripPos();
      const g = CFG.gravity * dt * dt;
      const maxStep = CFG.maxTipSpeed * dt;

      // --- Integrate (Verlet) with quadratic air drag: a = -c|v|v (lighter nodes feel it more) ---
      for (let i = 1; i < n; i++) {
        let vx = x[i] - px[i], vy = y[i] - py[i];
        const sp = Math.hypot(vx, vy);
        if (sp > maxStep) { vx *= maxStep / sp; vy *= maxStep / sp; }
        const drag = Math.max(0.5, 1 - CFG.airDrag * (sp / dt) * dt * (i === 1 ? 0.2 : Math.min(3, Math.sqrt(w[i])) * 0.6));
        const f = drag * CFG.linDamp;
        px[i] = x[i]; py[i] = y[i];
        x[i] += vx * f;
        y[i] += vy * f + g;
      }
      px[0] = x[0]; py[0] = y[0];
      x[0] = gx; y[0] = gy;

      // --- Wrist: soft spring pulling the handle toward its rest angle ---
      const tx = gx + Math.sin(this.restAngle) * len[1];
      const ty = gy + Math.cos(this.restAngle) * len[1];
      x[1] += (tx - x[1]) * CFG.wrist;
      y[1] += (ty - y[1]) * CFG.wrist;

      // --- Constraints (Gauss-Seidel, root → tip) ---
      for (let it = 0; it < CFG.iterations; it++) {
        for (let i = 1; i < n; i++) {
          const a = i - 1;
          const dx = x[i] - x[a], dy = y[i] - y[a];
          const d = Math.hypot(dx, dy) || 1e-9;
          const ws = w[a] + w[i];
          const c = (d - len[i]) / (d * ws);
          x[a] += dx * c * w[a]; y[a] += dy * c * w[a];
          x[i] -= dx * c * w[i]; y[i] -= dy * c * w[i];
        }
      }

      // --- Crack detection ---
      const t = n - 1;
      const tipV = Math.hypot(x[t] - px[t], y[t] - py[t]) / dt;
      this.tipEma = this.tipEma * 0.55 + tipV * 0.45;
      if (this.tipEma > stats.maxTip) stats.maxTip = this.tipEma;
      this.cooldown -= dt;

      const thr = crackThreshold();
      if (!this.armed && this.tipEma < thr * CFG.rearmFactor) this.armed = true;
      const ext = Math.hypot(x[t] - x[1], y[t] - y[1]) / this.cordLen;
      const ratio = this.tipEma / Math.max(hand.peak, 250);

      if (this.armed && this.cooldown <= 0 && this.tipEma > thr &&
          ratio > CFG.crackRatio && ext > CFG.crackExtension && hand.peak > CFG.intentSpeed) {
        this.crack(clamp((this.tipEma - thr) / thr, 0, 1));
      } else if (this.forceCrackAt >= 0 && clock >= this.forceCrackAt) {
        // Click flick that didn't quite break the barrier: crack at the end of the snap.
        this.forceCrackAt = -1;
        if (this.cooldown <= 0) this.crack(0.6);
      }
    }

    crack(intensity) {
      this.cooldown = CFG.crackCooldown;
      this.armed = false;
      this.forceCrackAt = -1;
      stats.cracks++;
      const t = this.n - 1;
      const tx = this.x[t], ty = this.y[t];
      const vx = this.x[t] - this.px[t], vy = this.y[t] - this.py[t];
      const pts = [];
      for (let i = Math.max(2, this.n - 8); i < this.n; i++) pts.push([this.x[i], this.y[i]]);
      onCrack(tx, ty, vx, vy, intensity, pts, this.pan + (tx / W - 0.5));
    }
  }

  // ======================= FX systems =======================
  const particles = [];
  const rings = [];
  const flashes = [];
  const texts = [];
  const lashes = [];
  const combo = { count: 0, last: -10 };
  let lastTauntAt = -10;

  function onCrack(x, y, vx, vy, intensity, pts, pan) {
    if (clock - combo.last <= CFG.comboWindow) combo.count++;
    else combo.count = 1;
    combo.last = clock;
    updateComboUI();

    const fire = combo.count >= CFG.fireAt;
    sound.crack(0.5 + intensity * 0.5, clamp(pan, -1, 1));

    flashes.push({ x, y, life: 0, max: 0.12, size: 80 + intensity * 70 + (fire ? 50 : 0) });
    rings.push({ x, y, life: 0, max: 0.32, r0: 4, r1: 60 + intensity * 60, w: 3, fire });
    rings.push({ x, y, life: -0.03, max: 0.45, r0: 3, r1: 110 + intensity * 80, w: 1.3, fire });

    const count = 16 + ((intensity * 18) | 0) + (fire ? 16 : 0);
    const sp = Math.hypot(vx, vy) || 1;
    const base = Math.atan2(vy / sp, vx / sp);
    for (let i = 0; i < count; i++) {
      const a = base + rand(-1.2, 1.2) + (Math.random() < 0.25 ? Math.PI : 0);
      const s = rand(220, 760) * (0.6 + intensity * 0.6);
      particles.push({
        kind: 'spark', x, y, vx: Math.cos(a) * s, vy: Math.sin(a) * s,
        life: 0, max: rand(0.2, 0.55), size: rand(1, 2.2), drag: 3.4, g: 1000, fire,
      });
    }

    lashes.push({ pts, life: 0, max: CFG.lashLife, fire, w: 2 + intensity * 2 });
    if (lashes.length > 24) lashes.shift();

    if (Math.random() < CFG.tauntChance && clock - lastTauntAt > 0.9) {
      lastTauntAt = clock;
      spawnText(pick(TAUNTS), x, y - 18, fire ? '#ffd27a' : '#ffffff', fire ? '#ff3c00' : '#ff5a36', 1);
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
  const onFire = () => combo.count >= CFG.fireAt && clock - combo.last <= CFG.comboWindow;

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
  let whips = [];
  function buildWhips() {
    if (state.mode === 2) {
      whips = [new Whip(-CFG.dualOffset, -0.45, -0.4), new Whip(CFG.dualOffset, 0.45, 0.4)];
    } else if (state.mode === 1) {
      whips = [new Whip(0, 0.35, 0)];
    } else {
      whips = [];
    }
  }
  buildWhips();

  // ======================= Input =======================
  window.korbaj.onCursor((p) => pushSample(p.x, p.y));
  window.addEventListener('mousemove', (e) => { if (!state.passive) pushSample(e.clientX, e.clientY); });

  window.addEventListener('mousedown', (e) => {
    sound.resume();
    if (state.passive || e.button !== 0) return;
    if (state.mode === 3) { pat.reversals.push(clock, clock, clock); return; }
    // Scripted wrist flick: the hand itself moves; physics produces the crack.
    const a = whips.length ? whips[0].handleAngle() : Math.PI / 2;
    flick.dx = -Math.cos(a) * 70; flick.dy = -Math.sin(a) * 70 - 20;
    flick.t = 0;
    whips.forEach((w) => { w.forceCrackAt = clock + CFG.clickFlick + 0.06; });
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
    hud.classList.add('show');
    clearTimeout(hudTimer);
    hudTimer = setTimeout(() => hud.classList.remove('show'), 3000);
  }
  updateHUD();

  // ======================= Simulation =======================
  let acc = 0;
  let simTime = performance.now() / 1000 - CFG.renderDelay;

  function simulate(frameDt, nowSec) {
    acc = Math.min(acc + frameDt, CFG.substep * CFG.maxSubsteps);
    const dt = CFG.substep;
    simTime = Math.max(simTime, nowSec - CFG.renderDelay - CFG.substep * CFG.maxSubsteps);
    while (acc >= dt) {
      acc -= dt;
      simTime += dt;
      clock += dt;
      if (flick.t >= 0) flick.t += dt;
      const [cx, cy] = sampleAt(Math.min(simTime, nowSec - CFG.renderDelay));
      const [ox, oy] = flickOffset();
      const nx = cx + ox, ny = cy + oy;
      const vx = (nx - hand.x) / dt, vy = (ny - hand.y) / dt;
      hand.vx = lerp(hand.vx, vx, 0.3);
      hand.vy = lerp(hand.vy, vy, 0.3);
      hand.speed = Math.hypot(hand.vx, hand.vy);
      hand.peak = Math.max(hand.speed, hand.peak * Math.exp(-dt / 0.25));
      hand.x = nx; hand.y = ny;
      for (const w of whips) w.step(dt);
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
    for (const arr of [rings, flashes, lashes]) {
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
        for (let k = 0; k < 3; k++) {
          const i = 3 + ((Math.random() * (w.n - 3)) | 0);
          particles.push({
            kind: 'fire', x: w.x[i] + rand(-3, 3), y: w.y[i] + rand(-3, 3),
            vx: rand(-25, 25), vy: rand(-140, -60),
            life: 0, max: rand(0.25, 0.5), size: rand(8, 16) * (1 - (i / w.n) * 0.5), drag: 2.5, g: -200,
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
  function drawLashes() {
    ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    for (const l of lashes) {
      const k = l.life / l.max;
      const a = (1 - k) * (1 - k);
      const heat = Math.max(0, 1 - k * 3);
      const path = () => {
        ctx.beginPath();
        ctx.moveTo(l.pts[0][0], l.pts[0][1]);
        for (let i = 1; i < l.pts.length; i++) ctx.lineTo(l.pts[i][0], l.pts[i][1]);
      };
      path();
      ctx.strokeStyle = `rgba(40,12,4,${0.45 * a})`;
      ctx.lineWidth = l.w + 4;
      ctx.stroke();
      ctx.globalCompositeOperation = 'lighter';
      path();
      ctx.strokeStyle = l.fire ? `rgba(255,90,10,${0.45 * a})` : `rgba(255,70,40,${0.35 * a})`;
      ctx.lineWidth = l.w + 6 * a;
      ctx.stroke();
      path();
      ctx.strokeStyle = `rgba(255,${(200 + 55 * heat) | 0},${(120 + 135 * heat) | 0},${0.8 * a})`;
      ctx.lineWidth = Math.max(0.8, l.w * 0.45);
      ctx.stroke();
      ctx.globalCompositeOperation = 'source-over';
    }
  }

  // Catmull-Rom resample of the cord, then build a tapered outline polygon.
  function cordOutline(w) {
    const P = [];
    for (let i = 1; i < w.n; i++) P.push([w.x[i], w.y[i]]);
    const pts = [];
    const SUB = 3;
    for (let i = 0; i < P.length - 1; i++) {
      const p0 = P[Math.max(0, i - 1)], p1 = P[i], p2 = P[i + 1], p3 = P[Math.min(P.length - 1, i + 2)];
      for (let s = 0; s < SUB; s++) {
        const t = s / SUB, t2 = t * t, t3 = t2 * t;
        pts.push([
          0.5 * (2 * p1[0] + (-p0[0] + p2[0]) * t + (2 * p0[0] - 5 * p1[0] + 4 * p2[0] - p3[0]) * t2 + (-p0[0] + 3 * p1[0] - 3 * p2[0] + p3[0]) * t3),
          0.5 * (2 * p1[1] + (-p0[1] + p2[1]) * t + (2 * p0[1] - 5 * p1[1] + 4 * p2[1] - p3[1]) * t2 + (-p0[1] + 3 * p1[1] - 3 * p2[1] + p3[1]) * t3),
        ]);
      }
    }
    pts.push(P[P.length - 1]);
    const L = [], R = [];
    const N = pts.length;
    for (let i = 0; i < N; i++) {
      const a = pts[Math.max(0, i - 1)], b = pts[Math.min(N - 1, i + 1)];
      let tx = b[0] - a[0], ty = b[1] - a[1];
      const tl = Math.hypot(tx, ty) || 1;
      tx /= tl; ty /= tl;
      const u = i / (N - 1);
      const half = lerp(3.4, 0.55, Math.pow(u, 0.7));
      L.push([pts[i][0] - ty * half, pts[i][1] + tx * half]);
      R.push([pts[i][0] + ty * half, pts[i][1] - tx * half]);
    }
    return { pts, L, R };
  }

  function tracePoly(L, R) {
    ctx.beginPath();
    ctx.moveTo(L[0][0], L[0][1]);
    for (let i = 1; i < L.length; i++) ctx.lineTo(L[i][0], L[i][1]);
    for (let i = R.length - 1; i >= 0; i--) ctx.lineTo(R[i][0], R[i][1]);
    ctx.closePath();
  }

  function drawCord(w) {
    const { pts, L, R } = cordOutline(w);
    const fire = onFire();

    // soft drop shadow
    ctx.save();
    ctx.translate(4, 6);
    tracePoly(L, R);
    ctx.fillStyle = 'rgba(0,0,0,0.22)';
    ctx.fill();
    ctx.restore();

    if (fire) {
      ctx.globalCompositeOperation = 'lighter';
      ctx.lineCap = 'round'; ctx.lineJoin = 'round';
      ctx.beginPath();
      ctx.moveTo(pts[0][0], pts[0][1]);
      for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i][0], pts[i][1]);
      ctx.strokeStyle = 'rgba(255,110,10,0.45)';
      ctx.lineWidth = 12;
      ctx.stroke();
      ctx.globalCompositeOperation = 'source-over';
    }

    // body: dark outline + light leather fill (reads on both dark terminals and light pages)
    tracePoly(L, R);
    ctx.lineJoin = 'round';
    ctx.strokeStyle = 'rgba(25,14,6,0.9)';
    ctx.lineWidth = 1.6;
    ctx.stroke();
    ctx.fillStyle = fire ? '#ffd9a0' : '#efe3cc';
    ctx.fill();

    // highlight running down one side
    ctx.beginPath();
    const hl = Math.floor(pts.length * 0.8);
    for (let i = 0; i < hl; i++) {
      const p = L[i], c = pts[i];
      const hx = lerp(c[0], p[0], 0.45), hy = lerp(c[1], p[1], 0.45);
      if (i === 0) ctx.moveTo(hx, hy); else ctx.lineTo(hx, hy);
    }
    ctx.strokeStyle = 'rgba(255,255,255,0.75)';
    ctx.lineWidth = 0.9;
    ctx.stroke();

    // cracker tuft
    const n = w.n;
    const tx = w.x[n - 1], ty = w.y[n - 1];
    const ang = Math.atan2(w.y[n - 1] - w.y[n - 2], w.x[n - 1] - w.x[n - 2]);
    ctx.strokeStyle = 'rgba(30,20,10,0.85)';
    ctx.lineWidth = 1;
    ctx.lineCap = 'round';
    for (let k = -2; k <= 2; k++) {
      const a = ang + k * 0.2;
      ctx.beginPath(); ctx.moveTo(tx, ty);
      ctx.lineTo(tx + Math.cos(a) * 8, ty + Math.sin(a) * 8);
      ctx.stroke();
    }
    if (fire) {
      ctx.globalCompositeOperation = 'lighter';
      ctx.drawImage(SPR.fire, tx - 14, ty - 14, 28, 28);
      ctx.globalCompositeOperation = 'source-over';
    }
  }

  function drawHandle(w) {
    const gx = w.x[0], gy = w.y[0];
    const L = Math.hypot(w.x[1] - gx, w.y[1] - gy);
    ctx.save();
    ctx.translate(gx, gy);
    ctx.rotate(w.handleAngle());

    // shadow
    ctx.fillStyle = 'rgba(0,0,0,0.25)';
    ctx.beginPath();
    ctx.ellipse(L / 2 + 4, 6, L / 2 + 6, 6.5, 0, 0, Math.PI * 2);
    ctx.fill();

    // golden lacquered wood, slightly flared toward the grip
    const body = () => {
      ctx.beginPath();
      ctx.moveTo(2, -6.8);
      ctx.bezierCurveTo(L * 0.4, -6, L * 0.75, -4.8, L - 2, -4.2);
      ctx.quadraticCurveTo(L + 2, 0, L - 2, 4.2);
      ctx.bezierCurveTo(L * 0.75, 4.8, L * 0.4, 6, 2, 6.8);
      ctx.closePath();
    };
    const wood = ctx.createLinearGradient(0, -7, 0, 7);
    wood.addColorStop(0, '#fff2b0');
    wood.addColorStop(0.3, '#f2c33c');
    wood.addColorStop(0.75, '#b97a12');
    wood.addColorStop(1, '#6b3f06');
    body();
    ctx.fillStyle = wood;
    ctx.fill();
    ctx.strokeStyle = 'rgba(40,22,2,0.9)';
    ctx.lineWidth = 1.4;
    ctx.stroke();

    // grip wrap (spiral)
    ctx.save();
    body(); ctx.clip();
    ctx.strokeStyle = 'rgba(90,50,5,0.55)';
    ctx.lineWidth = 1.2;
    for (let s = 12; s < L * 0.72; s += 5) {
      ctx.beginPath(); ctx.moveTo(s, -8); ctx.lineTo(s + 5, 8); ctx.stroke();
    }
    ctx.restore();

    // dark ferrule where the cord leaves
    ctx.fillStyle = '#3a2408';
    ctx.fillRect(L - 8, -4.6, 5, 9.2);
    ctx.fillStyle = 'rgba(255,230,160,0.5)';
    ctx.fillRect(L - 8, -4.6, 5, 1.6);

    // pommel at the cursor
    const knob = ctx.createRadialGradient(-2, -3, 1, 0, 0, 9);
    knob.addColorStop(0, '#fff6cf'); knob.addColorStop(0.5, '#d9a52a'); knob.addColorStop(1, '#5a3605');
    ctx.fillStyle = knob;
    ctx.beginPath(); ctx.arc(0, 0, 8, 0, Math.PI * 2); ctx.fill();
    ctx.strokeStyle = 'rgba(40,22,2,0.9)'; ctx.lineWidth = 1.2; ctx.stroke();

    // specular
    ctx.strokeStyle = 'rgba(255,255,240,0.7)';
    ctx.lineWidth = 1.3;
    ctx.beginPath(); ctx.moveTo(10, -4.4); ctx.lineTo(L * 0.8, -3); ctx.stroke();
    ctx.restore();
  }

  function drawFX() {
    ctx.globalCompositeOperation = 'lighter';
    for (const f of flashes) {
      const k = f.life / f.max;
      const s = f.size * (0.6 + k * 0.8);
      ctx.globalAlpha = (1 - k) * (1 - k);
      ctx.drawImage(SPR.flash, f.x - s, f.y - s, s * 2, s * 2);
    }
    ctx.globalAlpha = 1;
    for (const r of rings) {
      if (r.life < 0) continue;
      const k = r.life / r.max;
      const e = 1 - Math.pow(1 - k, 3);
      ctx.beginPath();
      ctx.arc(r.x, r.y, lerp(r.r0, r.r1, e), 0, Math.PI * 2);
      ctx.strokeStyle = r.fire ? `rgba(255,140,40,${(1 - k) * 0.9})` : `rgba(255,245,210,${(1 - k) * 0.85})`;
      ctx.lineWidth = r.w * (1 - k) + 0.5;
      ctx.stroke();
    }
    for (const p of particles) {
      const k = p.life / p.max;
      const a = 1 - k;
      if (p.kind === 'spark') {
        ctx.strokeStyle = p.fire ? `rgba(255,${(160 * a + 60) | 0},40,${a})` : `rgba(255,${(230 * a + 25) | 0},${(160 * a) | 0},${a})`;
        ctx.lineWidth = p.size;
        ctx.beginPath();
        ctx.moveTo(p.x, p.y);
        ctx.lineTo(p.x - p.vx * 0.02, p.y - p.vy * 0.02);
        ctx.stroke();
      } else {
        const spr = p.kind === 'fire' ? SPR.fire : SPR.heal;
        const s = p.kind === 'fire' ? p.size * (1 - k * 0.6) : p.size * (0.5 + 0.5 * Math.sin(k * Math.PI));
        ctx.globalAlpha = a * 0.9;
        ctx.drawImage(spr, p.x - s, p.y - s, s * 2, s * 2);
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
      for (const w of whips) maxTip = Math.max(maxTip, w.tipEma);
      sound.whoosh(Math.max(0, maxTip - 900) / 60);
    }
    updateFX(dt);

    ctx.clearRect(0, 0, W, H);
    drawLashes();
    for (const w of whips) drawCord(w);
    for (const w of whips) drawHandle(w);
    drawFX();
    drawTexts();
    if (state.mode === 3) drawPatHand();

    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
})();

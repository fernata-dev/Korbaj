'use strict';
/**
 * Korbaj renderer — Verlet whip physics, VFX and interaction.
 * Coordinates are CSS pixels; the canvas backing store is scaled by devicePixelRatio.
 */
(() => {
  // ======================= Config =======================
  const CFG = {
    nodes: 28,
    segLen: 10.5,               // px between nodes (cord length ≈ 285px)
    handleLen: 62,
    gravity: 1500,              // px/s²
    damping: 0.992,             // per substep velocity retention (air resistance)
    iterations: 16,             // constraint solver passes
    bendStiffness: 0.08,        // weak i↔i+2 constraint: lets the loop travel down the cord
    substep: 1 / 120,
    maxSubsteps: 6,
    crackSpeed: 3400,           // px/s tip speed that counts as breaking the "sound barrier"
    crackCooldown: 0.16,        // s
    clickCrackDelay: 0.11,      // s — forced crack if a click-snap didn't crack naturally
    maxTipSpeed: 11000,         // px/s clamp to keep the sim stable
    comboWindow: 2.0,           // s
    fireAt: 5,
    lashLife: 3.0,              // s
    tauntChance: 0.4,
    dualOffset: 30,
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

  const sound = new window.KorbajSound();
  sound.init().catch((e) => console.warn('[korbaj] audio init failed', e));

  const state = { visible: true, passive: true, mode: 1 };
  const cursor = { x: W / 2, y: H / 3, has: false };
  const anchor = { x: W / 2, y: H / 3, vx: 0, vy: 0 };
  let clock = 0;

  // ======================= Utils =======================
  const rand = (a, b) => a + Math.random() * (b - a);
  const pick = (arr) => arr[(Math.random() * arr.length) | 0];
  const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
  const lerp = (a, b, t) => a + (b - a) * t;
  function angLerp(a, b, t) {
    let d = b - a;
    while (d > Math.PI) d -= Math.PI * 2;
    while (d < -Math.PI) d += Math.PI * 2;
    return a + d * t;
  }

  // Pre-rendered glow sprites (much cheaper than shadowBlur per particle)
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
    flash: makeGlow(128, [[0, 'rgba(255,255,255,1)'], [0.15, 'rgba(255,250,210,0.9)'], [0.45, 'rgba(255,190,80,0.35)'], [1, 'rgba(255,120,0,0)']]),
    fire: makeGlow(32, [[0, 'rgba(255,250,220,1)'], [0.25, 'rgba(255,190,60,0.9)'], [0.6, 'rgba(255,80,0,0.45)'], [1, 'rgba(180,20,0,0)']]),
    spark: makeGlow(16, [[0, 'rgba(255,255,240,1)'], [0.4, 'rgba(255,210,120,0.7)'], [1, 'rgba(255,120,0,0)']]),
    heal: makeGlow(32, [[0, 'rgba(230,255,250,1)'], [0.3, 'rgba(80,255,200,0.7)'], [1, 'rgba(0,200,255,0)']]),
  };

  // ======================= Whip =======================
  class Whip {
    constructor(offsetX, baseAngle, pan) {
      this.offsetX = offsetX;
      this.baseAngle = baseAngle;     // resting handle angle (radians, 0 = right, +π/2 = down)
      this.angle = baseAngle;
      this.pan = pan;
      this.n = CFG.nodes;
      this.x = new Float32Array(this.n); this.y = new Float32Array(this.n);
      this.px = new Float32Array(this.n); this.py = new Float32Array(this.n);
      this.w = new Float32Array(this.n); // inverse mass
      for (let i = 0; i < this.n; i++) {
        // Tip is lighter than the base: a tapered mass profile is what makes a real whip
        // accelerate its loop toward the tip — conservation of momentum on shrinking mass.
        this.w[i] = i === 0 ? 0 : 1 + (i / this.n) * 5;
      }
      this.cooldown = 0;
      this.pendingCrack = -1;
      this.tipSpeed = 0;
      this.hx = 0; this.hy = 0; // handle tip (= cord root)
      this.reset(anchor.x, anchor.y);
    }

    reset(ax, ay) {
      const gx = ax + this.offsetX, gy = ay;
      this.hx = gx + Math.cos(this.angle) * CFG.handleLen;
      this.hy = gy + Math.sin(this.angle) * CFG.handleLen;
      for (let i = 0; i < this.n; i++) {
        this.x[i] = this.px[i] = this.hx;
        this.y[i] = this.py[i] = this.hy + i * CFG.segLen;
      }
    }

    grip(ax, ay) { return [ax + this.offsetX, ay]; }

    step(dt, ax, ay, avx, avy) {
      const { n, x, y, px, py, w } = this;
      // --- Handle orientation: tilts with movement, springs back to rest ---
      const sway = clamp(avx * 0.00055, -1.1, 1.1) + clamp(avy * 0.00025, -0.4, 0.4);
      const target = this.baseAngle - sway;
      this.angle = angLerp(this.angle, target, 1 - Math.exp(-dt * 14));
      const [gx, gy] = this.grip(ax, ay);
      this.hx = gx + Math.cos(this.angle) * CFG.handleLen;
      this.hy = gy + Math.sin(this.angle) * CFG.handleLen;

      // --- Verlet integrate ---
      const g = CFG.gravity * dt * dt;
      const maxStep = CFG.maxTipSpeed * dt;
      for (let i = 1; i < n; i++) {
        let vx = (x[i] - px[i]) * CFG.damping;
        let vy = (y[i] - py[i]) * CFG.damping;
        const sp = Math.hypot(vx, vy);
        if (sp > maxStep) { vx *= maxStep / sp; vy *= maxStep / sp; }
        px[i] = x[i]; py[i] = y[i];
        x[i] += vx; y[i] += vy + g;
      }
      px[0] = x[0]; py[0] = y[0];
      x[0] = this.hx; y[0] = this.hy;

      // --- Constraints ---
      const L = CFG.segLen;
      for (let k = 0; k < CFG.iterations; k++) {
        x[0] = this.hx; y[0] = this.hy;
        for (let i = 0; i < n - 1; i++) {
          const j = i + 1;
          const dx = x[j] - x[i], dy = y[j] - y[i];
          const d = Math.hypot(dx, dy) || 1e-6;
          const wsum = w[i] + w[j];
          if (wsum === 0) continue;
          const diff = (d - L) / (d * wsum);
          x[i] += dx * diff * w[i]; y[i] += dy * diff * w[i];
          x[j] -= dx * diff * w[j]; y[j] -= dy * diff * w[j];
        }
        // Weak bending (skip-one) constraint, only near the handle where the cord is thick
        for (let i = 0; i < n - 2; i++) {
          const j = i + 2;
          const stiff = CFG.bendStiffness * (1 - i / n);
          const dx = x[j] - x[i], dy = y[j] - y[i];
          const d = Math.hypot(dx, dy) || 1e-6;
          if (d >= 2 * L) continue;
          const wsum = w[i] + w[j];
          const diff = ((d - 2 * L) / (d * wsum)) * stiff;
          x[i] += dx * diff * w[i]; y[i] += dy * diff * w[i];
          x[j] -= dx * diff * w[j]; y[j] -= dy * diff * w[j];
        }
      }

      // Keep the cord on-screen-ish (soft floor at the bottom edge)
      for (let i = 1; i < n; i++) {
        if (y[i] > H - 2) { y[i] = H - 2; px[i] = lerp(px[i], x[i], 0.3); }
      }

      // --- Tip speed / crack detection ---
      const t = n - 1;
      this.tipSpeed = Math.hypot(x[t] - px[t], y[t] - py[t]) / dt;
      this.cooldown -= dt;
      if (this.pendingCrack >= 0) this.pendingCrack -= dt;

      if (this.cooldown <= 0 && this.tipSpeed > CFG.crackSpeed) {
        this.crack(clamp((this.tipSpeed - CFG.crackSpeed) / 5000, 0, 1));
      } else if (this.pendingCrack >= 0 && this.pendingCrack <= 0 && this.cooldown <= 0) {
        this.crack(0.85);
      }
    }

    /** Click snap: inject a travelling wave of velocity, biggest at the tip. */
    snap() {
      const { n, x, y, px, py } = this;
      const dirX = Math.cos(this.angle), dirY = Math.sin(this.angle);
      // Perpendicular flip direction so the cord loops over and cracks at full extension
      const side = Math.random() < 0.5 ? 1 : -1;
      const nx = -dirY * side, ny = dirX * side;
      for (let i = 1; i < n; i++) {
        const f = Math.pow(i / n, 1.6);
        const kick = 2600 * f * CFG.substep;
        px[i] = x[i] - (dirX * 0.75 + nx * 0.55) * kick;
        py[i] = y[i] - (dirY * 0.75 + ny * 0.55) * kick;
      }
      this.pendingCrack = CFG.clickCrackDelay;
    }

    crack(intensity) {
      this.cooldown = CFG.crackCooldown;
      this.pendingCrack = -1;
      const t = this.n - 1;
      const tx = this.x[t], ty = this.y[t];
      const vx = this.x[t] - this.px[t], vy = this.y[t] - this.py[t];
      // Lash mark follows the last few cord nodes — the arc the cracker just traced
      const pts = [];
      for (let i = Math.max(0, this.n - 9); i < this.n; i++) pts.push([this.x[i], this.y[i]]);
      onCrack(tx, ty, vx, vy, intensity, pts, this.pan + (tx / W - 0.5));
    }

    tip() { return [this.x[this.n - 1], this.y[this.n - 1]]; }
  }

  // ======================= FX systems =======================
  const particles = []; // sparks / fire / heal motes
  const rings = [];
  const flashes = [];
  const texts = [];
  const lashes = [];

  function onCrack(x, y, vx, vy, intensity, pts, pan) {
    // Combo
    if (clock - combo.last <= CFG.comboWindow) combo.count++;
    else combo.count = 1;
    combo.last = clock;
    updateComboUI();

    const fire = combo.count >= CFG.fireAt;
    sound.crack(intensity, clamp(pan, -1, 1));

    flashes.push({ x, y, life: 0, max: 0.14, size: 110 + intensity * 90 + (fire ? 60 : 0) });
    rings.push({ x, y, life: 0, max: 0.38, r0: 6, r1: 90 + intensity * 70, w: 3.5, fire });
    rings.push({ x, y, life: -0.03, max: 0.5, r0: 4, r1: 150 + intensity * 90, w: 1.5, fire });

    const count = 26 + ((intensity * 24) | 0) + (fire ? 20 : 0);
    const sp = Math.hypot(vx, vy) || 1;
    const dx = vx / sp, dy = vy / sp;
    for (let i = 0; i < count; i++) {
      const a = Math.atan2(dy, dx) + rand(-1.4, 1.4) + (Math.random() < 0.3 ? Math.PI : 0);
      const s = rand(250, 900) * (0.6 + intensity * 0.6);
      particles.push({
        kind: 'spark', x, y, vx: Math.cos(a) * s, vy: Math.sin(a) * s,
        life: 0, max: rand(0.25, 0.65), size: rand(1, 2.4), drag: 3.2, g: 900, fire,
      });
    }

    lashes.push({ pts, life: 0, max: CFG.lashLife, fire, w: 2.5 + intensity * 2 });
    if (lashes.length > 40) lashes.shift();

    if (Math.random() < CFG.tauntChance && clock - lastTauntAt > 0.6) {
      lastTauntAt = clock;
      spawnText(pick(TAUNTS), x, y - 18, fire ? '#ffd27a' : '#ffffff', fire ? '#ff3c00' : '#ff5a36', 1);
    }
  }
  let lastTauntAt = -10;

  function spawnText(str, x, y, fill, glow, kind) {
    texts.push({
      str, x: clamp(x, 80, W - 80), y: clamp(y, 40, H - 20),
      vy: kind === 3 ? -40 : -55, vx: rand(-15, 15),
      life: 0, max: kind === 3 ? 2.2 : 1.6, fill, glow, kind,
      rot: rand(-0.08, 0.08), size: kind === 3 ? 22 : 24,
    });
    if (texts.length > 24) texts.shift();
  }

  const combo = { count: 0, last: -10 };
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
  function updatePat(dt, vx, vy) {
    const speed = Math.hypot(vx, vy);
    pat.wobble = lerp(pat.wobble, clamp(vx * 0.0006, -0.5, 0.5), 1 - Math.exp(-dt * 12));
    if (speed > 3800 && clock - pat.lastGentle > 1.5) {
      pat.lastGentle = clock;
      spawnText(pick(GENTLE), cursor.x, cursor.y - 40, '#ffe2a8', '#ff9a3c', 3);
      return;
    }
    if (Math.abs(vx) > 60 && speed < 3000) {
      const s = Math.sign(vx);
      if (pat.lastSign !== 0 && s !== pat.lastSign) {
        pat.reversals.push(clock);
        // tiny sparkle per rub
        for (let i = 0; i < 3; i++) {
          particles.push({
            kind: 'heal', x: cursor.x + rand(-20, 20), y: cursor.y + rand(-10, 20),
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
      spawnText(pick(PRAISE), cursor.x + rand(-60, 60), cursor.y - 50, col[0], col[1], 3);
      sound.chime();
      for (let i = 0; i < 14; i++) {
        const a = rand(0, Math.PI * 2), s = rand(40, 160);
        particles.push({
          kind: 'heal', x: cursor.x, y: cursor.y - 10, vx: Math.cos(a) * s, vy: Math.sin(a) * s - 60,
          life: 0, max: rand(0.8, 1.5), size: rand(8, 14), drag: 2, g: -30,
        });
      }
    }
  }

  // ======================= Whip set =======================
  let whips = [];
  function buildWhips() {
    if (state.mode === 2) {
      whips = [
        new Whip(-CFG.dualOffset, Math.PI / 2 + 0.55, -0.4),
        new Whip(CFG.dualOffset, Math.PI / 2 - 0.55, 0.4),
      ];
    } else if (state.mode === 1) {
      whips = [new Whip(0, Math.PI / 2 - 0.35, 0)];
    } else {
      whips = [];
    }
  }
  buildWhips();

  // ======================= Input =======================
  window.korbaj.onCursor((p) => {
    cursor.x = p.x; cursor.y = p.y;
    if (!cursor.has) {
      cursor.has = true;
      anchor.x = p.x; anchor.y = p.y;
      whips.forEach((w) => w.reset(p.x, p.y));
    }
  });

  // DOM fallback (Active mode, or if polling ever stalls)
  window.addEventListener('mousemove', (e) => { cursor.x = e.clientX; cursor.y = e.clientY; cursor.has = true; });

  window.addEventListener('mousedown', (e) => {
    sound.resume();
    if (state.passive || e.button !== 0) return;
    if (state.mode === 3) {
      pat.reversals.push(clock, clock, clock); // a click is a deliberate pat
      return;
    }
    whips.forEach((w) => w.snap());
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

  // ======================= Simulation loop =======================
  let acc = 0;
  let last = performance.now();

  function simulate(frameDt) {
    acc = Math.min(acc + frameDt, CFG.substep * CFG.maxSubsteps);
    const steps = Math.floor(acc / CFG.substep);
    if (steps === 0) return;
    const sx = anchor.x, sy = anchor.y;
    for (let s = 1; s <= steps; s++) {
      // Interpolate the anchor across substeps so fast flicks are not quantised to frames
      const t = s / steps;
      const ax = lerp(sx, cursor.x, t), ay = lerp(sy, cursor.y, t);
      const avx = (ax - anchor.x) / CFG.substep, avy = (ay - anchor.y) / CFG.substep;
      anchor.vx = lerp(anchor.vx, avx, 0.35);
      anchor.vy = lerp(anchor.vy, avy, 0.35);
      anchor.x = ax; anchor.y = ay;
      for (const w of whips) w.step(CFG.substep, ax, ay, anchor.vx, anchor.vy);
      clock += CFG.substep;
      acc -= CFG.substep;
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

    // Fire whip: emit flames along the cord
    if (onFire()) {
      for (const w of whips) {
        for (let k = 0; k < 4; k++) {
          const i = 3 + ((Math.random() * (w.n - 3)) | 0);
          particles.push({
            kind: 'fire', x: w.x[i] + rand(-3, 3), y: w.y[i] + rand(-3, 3),
            vx: rand(-25, 25) + (w.x[i] - w.px[i]) * 6, vy: rand(-140, -60),
            life: 0, max: rand(0.25, 0.55), size: rand(10, 20) * (1 - i / w.n * 0.5), drag: 2.5, g: -200,
          });
        }
      }
    } else if (combo.count && clock - combo.last > CFG.comboWindow) {
      combo.count = 0;
      updateComboUI();
    }
    if (particles.length > 1400) particles.splice(0, particles.length - 1400);
  }

  // ======================= Rendering =======================
  function drawLashes() {
    for (const l of lashes) {
      const k = l.life / l.max;
      const a = (1 - k) * (1 - k);
      const heat = Math.max(0, 1 - k * 3); // white-hot for the first second, then scorch
      ctx.lineCap = 'round'; ctx.lineJoin = 'round';
      const path = () => {
        ctx.beginPath();
        ctx.moveTo(l.pts[0][0], l.pts[0][1]);
        for (let i = 1; i < l.pts.length; i++) ctx.lineTo(l.pts[i][0], l.pts[i][1]);
      };
      // dark scorch underlay
      path();
      ctx.strokeStyle = `rgba(40,12,4,${0.55 * a})`;
      ctx.lineWidth = l.w + 5;
      ctx.stroke();
      // glow
      ctx.globalCompositeOperation = 'lighter';
      path();
      ctx.strokeStyle = l.fire ? `rgba(255,90,10,${0.5 * a})` : `rgba(255,60,40,${0.4 * a})`;
      ctx.lineWidth = l.w + 7 * a;
      ctx.stroke();
      path();
      ctx.strokeStyle = `rgba(255,${(200 + 55 * heat) | 0},${(120 + 135 * heat) | 0},${0.85 * a})`;
      ctx.lineWidth = Math.max(0.8, l.w * 0.45);
      ctx.stroke();
      ctx.globalCompositeOperation = 'source-over';
    }
  }

  function drawHandle(w) {
    const [gx, gy] = w.grip(anchor.x, anchor.y);
    ctx.save();
    ctx.translate(gx, gy);
    ctx.rotate(w.angle);
    const L = CFG.handleLen;

    // drop shadow
    ctx.fillStyle = 'rgba(0,0,0,0.28)';
    ctx.beginPath();
    ctx.ellipse(L / 2 + 4, 6, L / 2 + 6, 6, 0, 0, Math.PI * 2);
    ctx.fill();

    // wooden core
    const wood = ctx.createLinearGradient(0, -7, 0, 7);
    wood.addColorStop(0, '#c08a52');
    wood.addColorStop(0.35, '#8a5428');
    wood.addColorStop(1, '#3f210c');
    ctx.fillStyle = wood;
    ctx.beginPath();
    ctx.moveTo(4, -6.5);
    ctx.lineTo(L - 4, -4.2);
    ctx.quadraticCurveTo(L, 0, L - 4, 4.2);
    ctx.lineTo(4, 6.5);
    ctx.closePath();
    ctx.fill();

    // braided leather wrap
    ctx.lineWidth = 1.4;
    for (let s = 10; s < L - 8; s += 5) {
      const h = lerp(6.3, 4.4, s / L);
      ctx.strokeStyle = 'rgba(30,14,4,0.75)';
      ctx.beginPath(); ctx.moveTo(s, -h); ctx.lineTo(s + 4, h); ctx.stroke();
      ctx.strokeStyle = 'rgba(255,210,160,0.22)';
      ctx.beginPath(); ctx.moveTo(s + 1, -h); ctx.lineTo(s + 5, h); ctx.stroke();
    }

    // brass ferrule at cord end
    const brass = ctx.createLinearGradient(0, -5, 0, 5);
    brass.addColorStop(0, '#fff1b0'); brass.addColorStop(0.5, '#c9962c'); brass.addColorStop(1, '#5c3d08');
    ctx.fillStyle = brass;
    ctx.fillRect(L - 9, -4.8, 6, 9.6);

    // pommel knob
    const knob = ctx.createRadialGradient(-1, -3, 1, 0, 0, 9);
    knob.addColorStop(0, '#ffe6a0'); knob.addColorStop(0.45, '#b8862a'); knob.addColorStop(1, '#4a2c06');
    ctx.fillStyle = knob;
    ctx.beginPath(); ctx.arc(0, 0, 8.5, 0, Math.PI * 2); ctx.fill();
    ctx.strokeStyle = 'rgba(0,0,0,0.4)'; ctx.lineWidth = 1; ctx.stroke();

    // specular highlight along the top
    ctx.strokeStyle = 'rgba(255,240,210,0.35)';
    ctx.lineWidth = 1.2;
    ctx.beginPath(); ctx.moveTo(9, -4.8); ctx.lineTo(L - 10, -3.2); ctx.stroke();
    ctx.restore();
  }

  function drawCord(w) {
    const { n, x, y } = w;
    const fire = onFire();
    ctx.lineCap = 'round'; ctx.lineJoin = 'round';

    // Smooth the polyline with midpoint quadratic curves, segment by segment for taper
    const mid = (i) => [(x[i] + x[i + 1]) / 2, (y[i] + y[i + 1]) / 2];
    const segPath = (i) => {
      ctx.beginPath();
      const [m0x, m0y] = i === 0 ? [x[0], y[0]] : mid(i - 1);
      const [m1x, m1y] = i >= n - 2 ? [x[n - 1], y[n - 1]] : mid(i);
      ctx.moveTo(m0x, m0y);
      ctx.quadraticCurveTo(x[i], y[i], m1x, m1y);
    };
    const thick = (i) => lerp(7.5, 1.3, Math.pow(i / (n - 1), 0.8));

    // shadow pass
    ctx.strokeStyle = 'rgba(0,0,0,0.22)';
    for (let i = 0; i < n - 3; i++) {
      ctx.save(); ctx.translate(3, 5); segPath(i); ctx.lineWidth = thick(i); ctx.stroke(); ctx.restore();
    }

    if (fire) {
      ctx.globalCompositeOperation = 'lighter';
      for (let i = 0; i < n - 1; i++) {
        segPath(i);
        ctx.strokeStyle = `rgba(255,${(90 + Math.random() * 60) | 0},0,0.35)`;
        ctx.lineWidth = thick(i) + 9;
        ctx.stroke();
      }
      ctx.globalCompositeOperation = 'source-over';
    }

    // leather body (fall excluded)
    for (let i = 0; i < n - 3; i++) {
      const t = i / n;
      segPath(i);
      ctx.strokeStyle = fire
        ? `rgb(${(110 + 90 * t) | 0},${(40 + 20 * t) | 0},12)`
        : `rgb(${(92 + 40 * t) | 0},${(52 + 26 * t) | 0},${(26 + 14 * t) | 0})`;
      ctx.lineWidth = thick(i);
      ctx.stroke();
    }
    // braid texture: alternating dark ticks + highlight line
    for (let i = 0; i < n - 3; i++) {
      segPath(i);
      ctx.setLineDash([2, 3]);
      ctx.lineDashOffset = i * 1.7;
      ctx.strokeStyle = 'rgba(20,8,2,0.55)';
      ctx.lineWidth = thick(i) * 0.7;
      ctx.stroke();
    }
    ctx.setLineDash([]);
    for (let i = 0; i < n - 3; i++) {
      segPath(i);
      ctx.strokeStyle = fire ? 'rgba(255,220,120,0.55)' : 'rgba(255,215,170,0.28)';
      ctx.lineWidth = Math.max(0.6, thick(i) * 0.22);
      ctx.stroke();
    }

    // fall + cracker (light, thin) at the very end
    for (let i = n - 3; i < n - 1; i++) {
      segPath(i);
      ctx.strokeStyle = fire ? '#ffe0a0' : '#e6d2ac';
      ctx.lineWidth = 1.2;
      ctx.stroke();
    }
    // frayed tuft
    const tx = x[n - 1], ty = y[n - 1];
    const ang = Math.atan2(y[n - 1] - y[n - 2], x[n - 1] - x[n - 2]);
    ctx.strokeStyle = fire ? 'rgba(255,240,190,0.95)' : 'rgba(245,235,215,0.9)';
    ctx.lineWidth = 0.8;
    for (let k = -2; k <= 2; k++) {
      const a = ang + k * 0.22;
      ctx.beginPath(); ctx.moveTo(tx, ty);
      ctx.lineTo(tx + Math.cos(a) * 7, ty + Math.sin(a) * 7);
      ctx.stroke();
    }
    if (fire) {
      ctx.globalCompositeOperation = 'lighter';
      ctx.drawImage(SPR.fire, tx - 14, ty - 14, 28, 28);
      ctx.globalCompositeOperation = 'source-over';
    }
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
      const rad = lerp(r.r0, r.r1, e);
      ctx.beginPath();
      ctx.arc(r.x, r.y, rad, 0, Math.PI * 2);
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
        ctx.lineTo(p.x - p.vx * 0.022, p.y - p.vy * 0.022);
        ctx.stroke();
        ctx.globalAlpha = a;
        ctx.drawImage(SPR.spark, p.x - 5, p.y - 5, 10, 10);
        ctx.globalAlpha = 1;
      } else if (p.kind === 'fire') {
        const s = p.size * (1 - k * 0.6);
        ctx.globalAlpha = a * 0.9;
        ctx.drawImage(SPR.fire, p.x - s, p.y - s, s * 2, s * 2);
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
      ctx.save();
      ctx.translate(t.x, t.y);
      ctx.rotate(t.rot);
      ctx.scale(pop, pop);
      ctx.globalAlpha = a;
      ctx.font = `${t.kind === 3 ? 600 : 800} ${t.size}px "Segoe UI", "Noto Sans Arabic", "Noto Sans", Ubuntu, sans-serif`;
      ctx.shadowColor = t.glow;
      ctx.shadowBlur = 16;
      ctx.lineWidth = 4;
      ctx.strokeStyle = 'rgba(0,0,0,0.65)';
      ctx.direction = /[\u0600-\u06FF]/.test(t.str) ? 'rtl' : 'ltr';
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
    ctx.translate(cursor.x, cursor.y);
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
  function frame(now) {
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;

    simulate(dt);

    if (state.mode === 3) {
      updatePat(dt, anchor.vx, anchor.vy);
    } else {
      let maxTip = 0;
      for (const w of whips) maxTip = Math.max(maxTip, w.tipSpeed);
      sound.whoosh(maxTip / 60); // px/s -> px/frame@60
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

'use strict';
/**
 * Korbaj whip physics — framework-free, runs in the renderer and in Node (tests).
 *
 * Model (CSS px, seconds; fixed 480 Hz substeps):
 *
 *   Hand     kinematic point that follows the cursor; tracks velocity / acceleration.
 *
 *   Handle   rigid body hinged at the hand: angle θ, angular velocity ω.
 *            Torques: wrist spring-damper aiming it along the hand's motion,
 *            pseudo-force from hand acceleration, gravity, and the cord pulling back.
 *
 *   Thong    chain of point masses with
 *              · inextensible distance constraints,
 *              · bending stiffness that is high at the handle and fades to zero at
 *                the tip (a real whip is a tapered rod, not a string),
 *              · a clamped exit: the thong leaves the handle along the handle's axis,
 *                so rotating the wrist actually throws a wave down the whip,
 *              · exponentially tapering mass (tip ≈ 40× lighter than the root) —
 *                momentum flowing into ever lighter cord is what accelerates the tip,
 *              · gravity and quadratic air drag.
 *
 *   Crack    tip speed above a sound-barrier threshold AND the hand moved fast on
 *            purpose AND the tip outruns the hand AND the cord is near full extension
 *            AND the detector has re-armed. Afterwards the tip loses its energy to the
 *            shock wave and recoils.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.KorbajPhysics = factory();
}(typeof self !== 'undefined' ? self : this, () => {
  const DEFAULTS = {
    // geometry
    cordNodes: 36,
    segLen: 9,                  // thong ≈ 324 px
    handleLen: 70,
    // world
    gravity: 1700,              // px/s²
    airDrag: 0.0005,            // quadratic drag coefficient (1/px)
    linDamp: 0.9998,            // internal friction per substep
    substep: 1 / 480,
    iterations: 8,
    maxNodeSpeed: 16000,        // px/s safety clamp
    // thong
    tipMassRatio: 40,           // tip is this many times lighter than the root
    bendRoot: 0.5,              // bending stiffness right at the handle (0..1 per iteration)
    bendPower: 2.4,             // how fast the stiffness fades toward the tip
    clampStiff: 0.85,           // how firmly the thong follows the handle's axis at the exit
    // handle / wrist
    handleInvMass: 0.04,        // grip firmness vs the cord's pull during the solve
    gripCoupling: 0.22,         // share of the cord's pull that turns into handle rotation
    wristFreq: 15,              // rad/s natural frequency (keep ≤ ~17 or flicks stop cracking)
    wristDamping: 0.34,         // damping ratio (<1 = slight follow-through)
    leadSpeed: 480,             // px/s at which the handle points halfway toward the motion
    handleInertia: 1.0,         // how strongly hand acceleration swings the handle
    handleGravity: 0.25,        // gravity sag of the handle against the wrist
    // crack
    crackSpeed: 3300,           // px/s tip speed at 1080p; scaled with screen height by the renderer
    crackRatio: 2.0,            // tip speed / recent hand speed
    intentSpeed: 2300,          // hand must have reached this speed (px/s) within the last ~half second
    crackExtension: 0.84,       // fraction of full thong length
    rearmFactor: 0.6,           // tip must slow below crackSpeed × this before it can crack again
    crackCooldown: 0.22,
    rearmTime: 0.5,             // …or this long has passed since the last crack
  };

  const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
  const wrapAngle = (a) => Math.atan2(Math.sin(a), Math.cos(a));

  class Hand {
    constructor(x = 0, y = 0) { this.set(x, y); }

    set(x, y) {
      this.x = x; this.y = y;
      this.vx = 0; this.vy = 0; this.ax = 0; this.ay = 0;
      this.speed = 0; this.peak = 0; this.intent = 0;
    }

    moveTo(nx, ny, dt) {
      const kv = 1 - Math.exp(-dt / 0.0117);
      const ka = 1 - Math.exp(-dt / 0.0145);
      const rvx = (nx - this.x) / dt, rvy = (ny - this.y) / dt;
      const pvx = this.vx, pvy = this.vy;
      this.vx += (rvx - this.vx) * kv;
      this.vy += (rvy - this.vy) * kv;
      this.ax += ((this.vx - pvx) / dt - this.ax) * ka;
      this.ay += ((this.vy - pvy) / dt - this.ay) * ka;
      this.speed = Math.hypot(this.vx, this.vy);
      this.peak = Math.max(this.speed, this.peak * Math.exp(-dt / 0.25));
      // "Did the user just swing on purpose?" — remembered long enough for the wave
      // to travel down the whip (the crack comes ~0.2 s after the hand's flick).
      this.intent = Math.max(this.speed, this.intent * Math.exp(-dt / 0.5));
      this.x = nx; this.y = ny;
    }
  }

  class Whip {
    /**
     * @param {object} cfg       config (DEFAULTS merged with overrides)
     * @param {Hand}   hand
     * @param {object} opts      { offsetX, restAngle (rad from straight-down, + = right), onCrack }
     */
    constructor(cfg, hand, opts = {}) {
      this.cfg = cfg;
      this.hand = hand;
      this.offsetX = opts.offsetX || 0;
      this.restAngle = opts.restAngle || 0;
      this.onCrack = opts.onCrack || (() => {});
      this.crackSpeed = cfg.crackSpeed;

      const n = this.n = 2 + cfg.cordNodes; // 0 grip, 1 handle end, 2.. thong
      this.x = new Float64Array(n); this.y = new Float64Array(n);
      this.px = new Float64Array(n); this.py = new Float64Array(n);
      this.w = new Float64Array(n);     // inverse mass
      this.len = new Float64Array(n);   // rest length from node i-1 to i
      this.bend = new Float64Array(n);  // bending stiffness of the joint at node i
      this.w[0] = 0;
      this.w[1] = cfg.handleInvMass;
      this.len[1] = cfg.handleLen;
      for (let i = 2; i < n; i++) {
        const u = (i - 2) / (n - 3);
        this.w[i] = Math.pow(cfg.tipMassRatio, u);
        this.len[i] = cfg.segLen;
      }
      this.bend[1] = cfg.clampStiff; // joint at the handle end: clamped exit
      for (let i = 2; i < n - 1; i++) {
        const u = (i - 2) / (n - 3);
        this.bend[i] = cfg.bendRoot * Math.pow(1 - u, cfg.bendPower);
      }
      this.cordLen = cfg.segLen * (n - 2);

      this.th = Math.PI / 2 - this.restAngle; // screen angle of the handle (π/2 = down)
      this.om = 0;
      this.tipSpeed = 0;   // smoothed, px/s
      this.armed = true;
      this.cooldown = 0;
      this.forceCrackIn = -1;
      this.time = 0;
      this.reset();
    }

    gripX() { return this.hand.x + this.offsetX; }

    reset() {
      const { n, x, y, px, py, len } = this;
      this.th = Math.PI / 2 - this.restAngle;
      this.om = 0;
      const gx = this.gripX(), gy = this.hand.y;
      let cx = gx, cy = gy;
      let dirX = Math.cos(this.th), dirY = Math.sin(this.th);
      for (let i = 0; i < n; i++) {
        if (i > 0) {
          // leave along the handle, then curve smoothly to hanging straight down
          const u = i < 2 ? 0 : Math.min(1, (i - 1) / 10);
          const ax = dirX * (1 - u), ay = dirY * (1 - u) + u;
          const al = Math.hypot(ax, ay) || 1;
          cx += (ax / al) * len[i]; cy += (ay / al) * len[i];
        }
        x[i] = px[i] = cx; y[i] = py[i] = cy;
      }
      this.tipSpeed = 0;
      this.armed = true;
    }

    /** Angular impulse on the handle (wrist snap), rad/s. */
    snapWrist(dOmega) { this.om += dOmega; }

    step(dt) {
      const {
        cfg, hand, n, x, y, px, py, w, len, bend,
      } = this;
      this.time += dt;
      const gx = this.gripX(), gy = hand.y;
      const L = len[1];

      // ---- 1. Handle rigid body ----
      const rest = Math.PI / 2 - this.restAngle;
      const tx = Math.cos(rest) + hand.vx / cfg.leadSpeed;
      const ty = Math.sin(rest) + hand.vy / cfg.leadSpeed;
      const err = wrapAngle(Math.atan2(ty, tx) - this.th);
      const k = cfg.wristFreq * cfg.wristFreq;
      const c = 2 * cfg.wristDamping * cfg.wristFreq;
      // rod pivoting at one end: α = (3 / 2L)·(dir × g_eff), g_eff = g − a_hand
      const gex = -hand.ax * cfg.handleInertia;
      const gey = cfg.gravity * cfg.handleGravity - hand.ay * cfg.handleInertia;
      const cross = Math.cos(this.th) * gey - Math.sin(this.th) * gex;
      this.om += (k * err - c * this.om + (3 / (2 * L)) * cross) * dt;
      this.om = clamp(this.om, -70, 70);
      this.th += this.om * dt;

      px[0] = x[0]; py[0] = y[0];
      px[1] = x[1]; py[1] = y[1];
      x[0] = gx; y[0] = gy;
      x[1] = gx + Math.cos(this.th) * L;
      y[1] = gy + Math.sin(this.th) * L;

      // ---- 2. Integrate the thong (Verlet + gravity + quadratic drag) ----
      const g = cfg.gravity * dt * dt;
      const maxStep = cfg.maxNodeSpeed * dt;
      for (let i = 2; i < n; i++) {
        let vx = x[i] - px[i], vy = y[i] - py[i];
        const sp = Math.hypot(vx, vy);
        if (sp > maxStep) { vx *= maxStep / sp; vy *= maxStep / sp; }
        // thin, light sections feel the air more
        const drag = Math.max(0.5, 1 - cfg.airDrag * sp * Math.min(3, Math.sqrt(w[i])) * 0.6);
        const f = drag * cfg.linDamp;
        px[i] = x[i]; py[i] = y[i];
        x[i] += vx * f;
        y[i] += vy * f + g;
      }

      // ---- 3. Constraints ----
      for (let it = 0; it < cfg.iterations; it++) {
        // bending: keep node i-1 and i+1 at straight-line distance, scaled by joint stiffness
        for (let i = 1; i < n - 1; i++) {
          const s = bend[i];
          if (s <= 0.0005) continue;
          const a = i - 1, b = i + 1;
          const restD = len[i] + len[b];
          const dx = x[b] - x[a], dy = y[b] - y[a];
          const d = Math.hypot(dx, dy) || 1e-9;
          const ws = w[a] + w[b];
          if (ws === 0) continue;
          const corr = (s * (d - restD)) / (d * ws);
          x[a] += dx * corr * w[a]; y[a] += dy * corr * w[a];
          x[b] -= dx * corr * w[b]; y[b] -= dy * corr * w[b];
        }
        // stretch: inextensible segments, root → tip
        for (let i = 1; i < n; i++) {
          const a = i - 1;
          const dx = x[i] - x[a], dy = y[i] - y[a];
          const d = Math.hypot(dx, dy) || 1e-9;
          const ws = w[a] + w[i];
          const corr = (d - len[i]) / (d * ws);
          x[a] += dx * corr * w[a]; y[a] += dy * corr * w[a];
          x[i] -= dx * corr * w[i]; y[i] -= dy * corr * w[i];
        }
        x[0] = gx; y[0] = gy;
      }

      // ---- 4. The cord's pull moved node 1: turn part of it into handle rotation ----
      const nth = Math.atan2(y[1] - gy, x[1] - gx);
      const d = wrapAngle(nth - this.th);
      this.th += d;
      this.om += (d / dt) * cfg.gripCoupling;
      x[1] = gx + Math.cos(this.th) * L;
      y[1] = gy + Math.sin(this.th) * L;

      // ---- 5. Crack detection ----
      const t = n - 1;
      const tipV = Math.hypot(x[t] - px[t], y[t] - py[t]) / dt;
      this.tipSpeed += (tipV - this.tipSpeed) * (1 - Math.exp(-dt / 0.007));
      this.cooldown -= dt;
      const thr = this.crackSpeed;
      if (!this.armed && (this.tipSpeed < thr * cfg.rearmFactor || this.cooldown < cfg.crackCooldown - cfg.rearmTime)) this.armed = true;

      if (this.armed && this.cooldown <= 0 && this.tipSpeed > thr && hand.intent > cfg.intentSpeed) {
        const ext = Math.hypot(x[t] - x[1], y[t] - y[1]) / this.cordLen;
        const ratio = this.tipSpeed / Math.max(hand.intent, 250);
        if (ext > cfg.crackExtension && ratio > cfg.crackRatio) {
          this.crack(clamp((this.tipSpeed - thr) / thr, 0, 1));
        }
      }
      if (this.forceCrackIn >= 0) {
        this.forceCrackIn -= dt;
        if (this.forceCrackIn < 0 && this.cooldown <= 0) this.crack(0.6);
      }
    }

    crack(intensity) {
      const { n, x, y, px, py } = this;
      this.cooldown = this.cfg.crackCooldown;
      this.armed = false;
      this.forceCrackIn = -1;
      const t = n - 1;
      const dt = this.cfg.substep;
      const info = {
        x: x[t], y: y[t],
        vx: (x[t] - px[t]) / dt, vy: (y[t] - py[t]) / dt,
        intensity,
        speed: this.tipSpeed,
        path: [],
      };
      for (let i = Math.max(2, n - 9); i < n; i++) info.path.push([x[i], y[i]]);
      // Recoil: the shock wave carries the energy away and the cracker snaps back.
      for (let j = 0; j < 7; j++) {
        const i = n - 1 - j;
        const f = j / 7;
        const rebound = -0.3 * (1 - f) + 0.25 * f; // tip bounces back, inner nodes just lose speed
        const vx0 = x[i] - px[i], vy0 = y[i] - py[i];
        px[i] = x[i] - vx0 * rebound;
        py[i] = y[i] - vy0 * rebound;
      }
      this.onCrack(info, this);
    }
  }

  return { DEFAULTS, Hand, Whip };
}));

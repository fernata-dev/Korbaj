'use strict';
/**
 * Korbaj whip renderer — draws a KorbajPhysics.Whip as a braided leather bullwhip.
 *
 * Anatomy (as on a real whip):
 *   pommel knot · braided handle · transition knot · tapered braided thong ·
 *   fall hitch · fall (thin leather strip) · cracker (frayed string)
 *
 * Technique: a tileable plait texture is generated once per skin and wrapped along
 * the smoothed centre-line in thin rotated slices, so the braid follows every curve.
 * A light rim + dark outline keep it readable on both dark terminals and white pages.
 * Lighting is fixed in screen space (top-left), and fast sections get real motion blur
 * built from the swept area between consecutive frames.
 */
window.KorbajDraw = (() => {
  const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
  const lerp = (a, b, t) => a + (b - a) * t;

  const SKINS = {
    leather: {
      label: 'Cognac Leather',
      thong: { base: '#8f4a1c', light: '#d9914e', dark: '#4a2109', groove: 'rgba(30,12,2,0.75)' },
      handle: { base: '#5b2a10', light: '#a8623a', dark: '#2c1206', groove: 'rgba(16,6,1,0.8)' },
      knot: { light: '#c98a55', base: '#6d3414', dark: '#2a1105' },
      fall: '#c9a273',
      cracker: '#f3ead9',
      outline: 'rgba(20,9,3,0.95)',
      rim: 'rgba(255,224,186,0.46)',
      trail: '255,232,205',
      loop: '#6d3414',
    },
    obsidian: {
      label: 'Obsidian',
      thong: { base: '#2a2b33', light: '#70748a', dark: '#0c0c10', groove: 'rgba(0,0,0,0.8)' },
      handle: { base: '#1b1b22', light: '#565a70', dark: '#060608', groove: 'rgba(0,0,0,0.85)' },
      knot: { light: '#ff6b5a', base: '#b3211a', dark: '#4a0906' },
      fall: '#9a2a22',
      cracker: '#ffd9d2',
      outline: 'rgba(0,0,0,0.95)',
      rim: 'rgba(255,120,105,0.6)',
      trail: '255,150,135',
      loop: '#b3211a',
    },
    bone: {
      label: 'Ivory & Gold',
      thong: { base: '#e2d6bf', light: '#ffffff', dark: '#a59479', groove: 'rgba(90,70,40,0.55)' },
      handle: { base: '#c08a1e', light: '#ffe08a', dark: '#6b4406', groove: 'rgba(60,32,0,0.7)' },
      knot: { light: '#fff0b0', base: '#d9a32a', dark: '#6b4406' },
      fall: '#f1e7d2',
      cracker: '#ffffff',
      outline: 'rgba(34,24,10,0.92)',
      rim: 'rgba(255,255,255,0.5)',
      trail: '255,255,255',
      loop: '#b98a22',
    },
  };

  // ---------------- texture generation ----------------
  const TEX_H = 32;   // across the cord
  const TEX_P = 24;   // plait period along the cord
  const TEX_W = TEX_P * 4;

  function braidTexture(pal) {
    const c = document.createElement('canvas');
    c.width = TEX_W; c.height = TEX_H;
    const g = c.getContext('2d');
    g.fillStyle = pal.base;
    g.fillRect(0, 0, TEX_W, TEX_H);

    const half = TEX_H / 2;
    const S = 15;            // how far a strand leans over half the width
    const band = TEX_P / 2;  // strand width along the cord
    // strands: chevrons pointing along the cord, alternating tone = two-tone plait
    for (let k = -4, x = -TEX_P * 2; x < TEX_W + TEX_P; x += band, k++) {
      const tone = k % 2 === 0 ? pal.light : pal.dark;
      g.globalAlpha = k % 2 === 0 ? 0.42 : 0.38;
      g.fillStyle = tone;
      g.beginPath();
      g.moveTo(x, 0); g.lineTo(x + band, 0); g.lineTo(x + band + S, half); g.lineTo(x + S, half);
      g.closePath(); g.fill();
      g.beginPath();
      g.moveTo(x, TEX_H); g.lineTo(x + band, TEX_H); g.lineTo(x + band + S, half); g.lineTo(x + S, half);
      g.closePath(); g.fill();
    }
    g.globalAlpha = 1;
    // grooves between strands + a soft lit edge beside each groove (emboss)
    g.lineCap = 'round';
    for (let x = -TEX_P * 2; x < TEX_W + TEX_P; x += band) {
      g.strokeStyle = pal.groove;
      g.lineWidth = 2.6;
      g.beginPath(); g.moveTo(x, -1); g.lineTo(x + S, half); g.lineTo(x, TEX_H + 1); g.stroke();
      g.strokeStyle = pal.light;
      g.globalAlpha = 0.35;
      g.lineWidth = 1.4;
      g.beginPath(); g.moveTo(x + 3, 1); g.lineTo(x + S + 3, half); g.lineTo(x + 3, TEX_H - 1); g.stroke();
      g.globalAlpha = 1;
    }
    // centre seam where the strands cross
    g.strokeStyle = pal.groove;
    g.globalAlpha = 0.35;
    g.lineWidth = 1.2;
    g.beginPath(); g.moveTo(0, half); g.lineTo(TEX_W, half); g.stroke();
    g.globalAlpha = 1;
    // cylinder shading: dark toward both edges, so it reads as round
    const sh = g.createLinearGradient(0, 0, 0, TEX_H);
    sh.addColorStop(0, 'rgba(0,0,0,0.62)');
    sh.addColorStop(0.22, 'rgba(0,0,0,0.12)');
    sh.addColorStop(0.42, 'rgba(0,0,0,0)');
    sh.addColorStop(0.62, 'rgba(0,0,0,0.08)');
    sh.addColorStop(1, 'rgba(0,0,0,0.7)');
    g.fillStyle = sh;
    g.fillRect(0, 0, TEX_W, TEX_H);
    return c;
  }

  function knotSprite(pal) {
    const R = 24;
    const c = document.createElement('canvas');
    c.width = c.height = R * 2;
    const g = c.getContext('2d');
    g.save();
    g.beginPath(); g.arc(R, R, R - 1.5, 0, Math.PI * 2); g.clip();
    const base = g.createRadialGradient(R * 0.7, R * 0.6, 2, R, R, R);
    base.addColorStop(0, pal.light); base.addColorStop(0.55, pal.base); base.addColorStop(1, pal.dark);
    g.fillStyle = base;
    g.fillRect(0, 0, R * 2, R * 2);
    // woven turk's-head: two families of curved strands
    g.lineWidth = 2.4;
    for (let i = -6; i <= 6; i++) {
      g.strokeStyle = 'rgba(0,0,0,0.42)';
      g.beginPath(); g.moveTo(R + i * 9 - 16, 0); g.quadraticCurveTo(R + i * 9 + 4, R, R + i * 9 - 16, R * 2); g.stroke();
      g.beginPath(); g.moveTo(R + i * 9 + 16, 0); g.quadraticCurveTo(R + i * 9 - 4, R, R + i * 9 + 16, R * 2); g.stroke();
      g.strokeStyle = 'rgba(255,255,255,0.16)';
      g.beginPath(); g.moveTo(R + i * 9 - 13, 0); g.quadraticCurveTo(R + i * 9 + 7, R, R + i * 9 - 13, R * 2); g.stroke();
    }
    const edge = g.createRadialGradient(R, R, R * 0.55, R, R, R);
    edge.addColorStop(0, 'rgba(0,0,0,0)'); edge.addColorStop(1, 'rgba(0,0,0,0.55)');
    g.fillStyle = edge;
    g.fillRect(0, 0, R * 2, R * 2);
    const spec = g.createRadialGradient(R * 0.66, R * 0.56, 0, R * 0.66, R * 0.56, R * 0.5);
    spec.addColorStop(0, 'rgba(255,255,255,0.55)'); spec.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = spec;
    g.fillRect(0, 0, R * 2, R * 2);
    g.restore();
    return c;
  }

  const cache = {};
  function assets(skinName) {
    const name = SKINS[skinName] ? skinName : 'leather';
    if (!cache[name]) {
      const skin = SKINS[name];
      cache[name] = {
        skin,
        thong: braidTexture(skin.thong),
        handle: braidTexture(skin.handle),
        knot: knotSprite(skin.knot),
      };
    }
    return cache[name];
  }

  // ---------------- geometry ----------------
  const THONG_END = 0.86;   // fraction of the cord that is braided thong
  const FALL_END = 0.955;   // then the fall; the rest is the cracker

  function halfWidth(u) {
    if (u <= THONG_END) return lerp(4.7, 1.55, Math.pow(u / THONG_END, 0.85));
    if (u <= FALL_END) return 0.95;
    return 0.6;
  }

  /** Catmull-Rom resample of nodes 1..n-1 with arc length, tangent and half-width. */
  function centerline(w) {
    const P = [];
    for (let i = 1; i < w.n; i++) P.push([w.x[i], w.y[i]]);
    // extend the first control point backwards along the handle so the exit is tangent to it
    const hx = w.x[1] - w.x[0], hy = w.y[1] - w.y[0];
    const hl = Math.hypot(hx, hy) || 1;
    const pre = [P[0][0] - (hx / hl) * 9, P[0][1] - (hy / hl) * 9];
    const pts = [];
    const SUB = 4;
    for (let i = 0; i < P.length - 1; i++) {
      const p0 = i === 0 ? pre : P[i - 1], p1 = P[i], p2 = P[i + 1], p3 = P[Math.min(P.length - 1, i + 2)];
      for (let s = 0; s < SUB; s++) {
        const t = s / SUB, t2 = t * t, t3 = t2 * t;
        pts.push({
          x: 0.5 * (2 * p1[0] + (-p0[0] + p2[0]) * t + (2 * p0[0] - 5 * p1[0] + 4 * p2[0] - p3[0]) * t2 + (-p0[0] + 3 * p1[0] - 3 * p2[0] + p3[0]) * t3),
          y: 0.5 * (2 * p1[1] + (-p0[1] + p2[1]) * t + (2 * p0[1] - 5 * p1[1] + 4 * p2[1] - p3[1]) * t2 + (-p0[1] + 3 * p1[1] - 3 * p2[1] + p3[1]) * t3),
        });
      }
    }
    pts.push({ x: P[P.length - 1][0], y: P[P.length - 1][1] });
    let total = 0;
    pts[0].s = 0;
    for (let i = 1; i < pts.length; i++) {
      total += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y);
      pts[i].s = total;
    }
    const N = pts.length;
    for (let i = 0; i < N; i++) {
      const a = pts[Math.max(0, i - 1)], b = pts[Math.min(N - 1, i + 1)];
      let tx = b.x - a.x, ty = b.y - a.y;
      const tl = Math.hypot(tx, ty) || 1;
      tx /= tl; ty /= tl;
      const p = pts[i];
      p.tx = tx; p.ty = ty;
      p.u = p.s / (total || 1);
      p.h = halfWidth(p.u);
    }
    return pts;
  }

  function tracePolygon(ctx, pts, grow, from, to) {
    ctx.beginPath();
    for (let i = from; i <= to; i++) {
      const p = pts[i], h = p.h + grow;
      const x = p.x - p.ty * h, y = p.y + p.tx * h;
      if (i === from) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    }
    for (let i = to; i >= from; i--) {
      const p = pts[i], h = p.h + grow;
      ctx.lineTo(p.x + p.ty * h, p.y - p.tx * h);
    }
    ctx.closePath();
  }

  // ---------------- motion blur ----------------
  // Snapshots of the outer cord are taken every physics substep (≈2 ms). The area
  // swept between two snapshots is filled with an opacity of (cord width ÷ distance
  // swept): the same light spread over more area. So slow parts stay crisp, fast
  // parts smear, and the thin tip nearly vanishes at full speed — like a real whip.
  const TRAIL_SNAPS = 18;
  const TRAIL_FROM = 0.25; // fraction of the whip (from the handle) that never blurs

  function recordTrail(w) {
    if (!w._trail) w._trail = [];
    const from = Math.floor(w.n * TRAIL_FROM);
    let snap = w._trail.length >= TRAIL_SNAPS ? w._trail.shift() : new Float32Array((w.n - from) * 2);
    if (snap.length !== (w.n - from) * 2) snap = new Float32Array((w.n - from) * 2);
    for (let i = from, j = 0; i < w.n; i++) { snap[j++] = w.x[i]; snap[j++] = w.y[i]; }
    w._trail.push(snap);
  }

  function drawTrail(ctx, w, skin, fire) {
    const tr = w._trail;
    if (!tr || tr.length < 3) return;
    const count = tr[0].length / 2;
    const from = w.n - count;
    const pairs = tr.length - 1;
    for (let f = 0; f < pairs; f++) {
      const a = tr[f], b = tr[f + 1];
      let start = -1; let gapSum = 0; let hSum = 0; let m = 0;
      for (let i = 0; i < count; i++) {
        const d = Math.hypot(b[i * 2] - a[i * 2], b[i * 2 + 1] - a[i * 2 + 1]);
        if (start < 0 && d > 2.5) start = i;
        if (start >= 0) {
          gapSum += d; m++;
          hSum += halfWidth((from + i - 1) / (w.n - 2));
        }
      }
      if (start < 0 || m < 2) continue;
      const age = (f + 1) / pairs; // 0 = oldest, 1 = newest
      const coverage = (2 * hSum) / Math.max(gapSum, 1e-3); // width ÷ swept distance
      const alpha = clamp(coverage * 1.15, 0, 0.2) * age * age;
      if (alpha < 0.006) continue;
      ctx.beginPath();
      ctx.moveTo(a[start * 2], a[start * 2 + 1]);
      for (let i = start + 1; i < count; i++) ctx.lineTo(a[i * 2], a[i * 2 + 1]);
      for (let i = count - 1; i >= start; i--) ctx.lineTo(b[i * 2], b[i * 2 + 1]);
      ctx.closePath();
      // fade in from the slow inner part toward the fast tip (no hard inner edge)
      const last = count - 1;
      const grad = ctx.createLinearGradient(b[start * 2], b[start * 2 + 1], b[last * 2], b[last * 2 + 1]);
      const col = fire ? '255,150,40' : skin.trail;
      const peak = fire ? Math.min(0.45, alpha * 1.7) : alpha;
      grad.addColorStop(0, `rgba(${col},0)`);
      grad.addColorStop(0.45, `rgba(${col},${peak * 0.55})`);
      grad.addColorStop(1, `rgba(${col},${peak})`);
      ctx.fillStyle = grad;
      ctx.fill();
    }
  }

  // ---------------- whip ----------------
  function drawThong(ctx, w, A, opts) {
    const { skin } = A;
    const pts = centerline(w);
    const N = pts.length;
    let iThong = N - 1, iFall = N - 1;
    for (let i = 0; i < N; i++) { if (pts[i].u >= THONG_END) { iThong = i; break; } }
    for (let i = 0; i < N; i++) { if (pts[i].u >= FALL_END) { iFall = i; break; } }

    // 1. soft drop shadow + light rim + dark outline (whole length, one path each)
    ctx.save();
    ctx.shadowColor = 'rgba(0,0,0,0.38)';
    ctx.shadowBlur = 7;
    ctx.shadowOffsetX = 3; ctx.shadowOffsetY = 6;
    tracePolygon(ctx, pts, 1.9, 0, N - 1);
    ctx.fillStyle = skin.rim;
    ctx.fill();
    ctx.restore();
    tracePolygon(ctx, pts, 0.95, 0, N - 1);
    ctx.fillStyle = skin.outline;
    ctx.fill();

    if (opts.fire) {
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      ctx.shadowColor = 'rgba(255,90,0,0.9)';
      ctx.shadowBlur = 16;
      tracePolygon(ctx, pts, 1.5, 0, N - 1);
      ctx.fillStyle = 'rgba(255,120,20,0.35)';
      ctx.fill();
      ctx.restore();
    }

    // 2. braided leather: wrap the plait texture along the curve in thin slices
    const tex = A.thong;
    const T = ctx.getTransform();
    let uTex = 0;
    for (let i = 0; i < iThong; i++) {
      const p = pts[i], q = pts[i + 1];
      const dx = q.x - p.x, dy = q.y - p.y;
      const d = Math.hypot(dx, dy);
      if (d < 0.01) continue;
      const h = (p.h + q.h) / 2;
      // texture advances so the plait keeps its proportions as the thong tapers
      const du = Math.min(TEX_P * 1.5, d * (TEX_H / (2 * h)) * 0.62);
      const cos = dx / d, sin = dy / d;
      ctx.setTransform(T.a * cos + T.c * sin, T.b * cos + T.d * sin, -T.a * sin + T.c * cos, -T.b * sin + T.d * cos, T.a * p.x + T.c * p.y + T.e, T.b * p.x + T.d * p.y + T.f);
      ctx.drawImage(tex, uTex % TEX_P, 0, du, TEX_H, -0.35, -h, d + 0.7, h * 2);
      uTex += du;
    }
    ctx.setTransform(T);

    // 3. screen-space specular (light from the top-left, independent of cord direction)
    ctx.save();
    tracePolygon(ctx, pts, 0, 0, iThong);
    ctx.clip();
    ctx.beginPath();
    for (let pass = 0; pass < 2; pass++) {
      const sgn = pass === 0 ? 1 : -1;
      for (let k = 0; k <= iThong; k++) {
        const p = pts[pass === 0 ? k : iThong - k];
        // how much this part of the surface faces the light
        const facing = Math.abs(p.tx * 0.55 - p.ty * 0.83);
        const hw = p.h * 0.2 * (0.35 + 0.65 * facing);
        const cx = p.x - 0.5 * p.h * 0.62, cy = p.y - 0.78 * p.h * 0.62;
        const x = cx - p.ty * hw * sgn, y = cy + p.tx * hw * sgn;
        if (pass === 0 && k === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
      }
    }
    ctx.closePath();
    ctx.fillStyle = opts.fire ? 'rgba(255,235,170,0.5)' : 'rgba(255,255,255,0.3)';
    ctx.fill();
    ctx.restore();

    // 4. fall (thin leather strip) and cracker (string)
    ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    ctx.beginPath();
    ctx.moveTo(pts[iThong].x, pts[iThong].y);
    for (let i = iThong + 1; i <= iFall; i++) ctx.lineTo(pts[i].x, pts[i].y);
    ctx.strokeStyle = opts.fire ? '#ffd9a0' : skin.fall;
    ctx.lineWidth = 1.7;
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(pts[iFall].x, pts[iFall].y);
    for (let i = iFall + 1; i < N; i++) ctx.lineTo(pts[i].x, pts[i].y);
    ctx.strokeStyle = opts.fire ? '#fff3d0' : skin.cracker;
    ctx.lineWidth = 1.05;
    ctx.stroke();

    // hitches where fall and cracker are tied on
    for (const [i, r] of [[iThong, 2.3], [iFall, 1.6]]) {
      ctx.beginPath(); ctx.arc(pts[i].x, pts[i].y, r + 0.8, 0, Math.PI * 2);
      ctx.fillStyle = skin.outline; ctx.fill();
      ctx.beginPath(); ctx.arc(pts[i].x, pts[i].y, r, 0, Math.PI * 2);
      ctx.fillStyle = skin.thong.base; ctx.fill();
      ctx.beginPath(); ctx.arc(pts[i].x - r * 0.3, pts[i].y - r * 0.35, r * 0.45, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(255,255,255,0.35)'; ctx.fill();
    }

    // frayed tuft: fans out and trails behind the tip's motion
    const tip = pts[N - 1];
    const n = w.n;
    const tvx = w.x[n - 1] - w.px[n - 1], tvy = w.y[n - 1] - w.py[n - 1];
    const tv = Math.hypot(tvx, tvy);
    let ax = tip.tx, ay = tip.ty;
    if (tv > 0.4) {
      const k = clamp(tv / 6, 0, 0.75);
      ax = lerp(ax, -tvx / tv, k); ay = lerp(ay, -tvy / tv, k);
    }
    const base = Math.atan2(ay, ax);
    const spread = lerp(0.5, 0.16, clamp(tv / 8, 0, 1));
    ctx.lineWidth = 0.75;
    for (let k = -3; k <= 3; k++) {
      const a = base + (k / 3) * spread + Math.sin(k * 12.9898 + w.time * 30) * 0.05;
      const len = 9 + ((k * 7 + 21) % 5);
      ctx.beginPath();
      ctx.moveTo(tip.x, tip.y);
      ctx.quadraticCurveTo(tip.x + Math.cos(base) * len * 0.5, tip.y + Math.sin(base) * len * 0.5, tip.x + Math.cos(a) * len, tip.y + Math.sin(a) * len);
      ctx.strokeStyle = skin.outline; ctx.globalAlpha = 0.5; ctx.lineWidth = 1.7; ctx.stroke();
      ctx.strokeStyle = opts.fire ? '#fff3d0' : skin.cracker; ctx.globalAlpha = 1; ctx.lineWidth = 0.75; ctx.stroke();
    }
    return tip;
  }

  function drawWristLoop(ctx, w, A, dt) {
    // a small leather strap on the pommel: damped pendulum driven by gravity and hand motion
    if (w._loopA === undefined) { w._loopA = Math.PI / 2; w._loopW = 0; }
    const hand = w.hand;
    const gx = -hand.ax * 0.9, gy = 2600 - hand.ay * 0.9;
    const cross = Math.cos(w._loopA) * gy - Math.sin(w._loopA) * gx;
    w._loopW += (cross / 26 - 9 * w._loopW) * Math.min(dt, 0.03);
    w._loopW = clamp(w._loopW, -40, 40);
    w._loopA += w._loopW * Math.min(dt, 0.03);
    const a = w._loopA;
    const x0 = w.x[0], y0 = w.y[0];
    const L = 27;
    const ex = x0 + Math.cos(a) * L, ey = y0 + Math.sin(a) * L;
    const nx = -Math.sin(a), ny = Math.cos(a);
    const path = () => {
      ctx.beginPath();
      ctx.moveTo(x0, y0);
      ctx.bezierCurveTo(x0 + nx * 11 + Math.cos(a) * 8, y0 + ny * 11 + Math.sin(a) * 8, ex + nx * 9, ey + ny * 9, ex, ey);
      ctx.bezierCurveTo(ex - nx * 9, ey - ny * 9, x0 - nx * 11 + Math.cos(a) * 8, y0 - ny * 11 + Math.sin(a) * 8, x0, y0);
    };
    ctx.lineJoin = 'round';
    path(); ctx.strokeStyle = A.skin.rim; ctx.lineWidth = 5; ctx.stroke();
    path(); ctx.strokeStyle = A.skin.outline; ctx.lineWidth = 3.6; ctx.stroke();
    path(); ctx.strokeStyle = A.skin.loop; ctx.lineWidth = 2.1; ctx.stroke();
    path(); ctx.strokeStyle = 'rgba(255,255,255,0.22)'; ctx.lineWidth = 0.7; ctx.stroke();
  }

  function drawHandle(ctx, w, A) {
    const { skin } = A;
    const gx = w.x[0], gy = w.y[0];
    const L = Math.hypot(w.x[1] - gx, w.y[1] - gy);
    const hw = (x) => lerp(5.9, 4.9, clamp(x / L, 0, 1)); // slight taper toward the thong

    ctx.save();
    ctx.translate(gx, gy);
    ctx.rotate(w.th);

    const body = (grow) => {
      ctx.beginPath();
      ctx.moveTo(0, -hw(0) - grow);
      ctx.lineTo(L, -hw(L) - grow);
      ctx.lineTo(L, hw(L) + grow);
      ctx.lineTo(0, hw(0) + grow);
      ctx.closePath();
    };
    // shadow + rim + outline
    ctx.save();
    ctx.shadowColor = 'rgba(0,0,0,0.4)';
    ctx.shadowBlur = 8; ctx.shadowOffsetX = 3; ctx.shadowOffsetY = 6;
    body(1.9); ctx.fillStyle = skin.rim; ctx.fill();
    ctx.restore();
    body(0.95); ctx.fillStyle = skin.outline; ctx.fill();

    // braided grip
    const step = 4;
    let u = 0;
    for (let x = 0; x < L; x += step) {
      const h = hw(x + step / 2);
      const d = Math.min(step, L - x);
      const du = d * (TEX_H / (2 * h)) * 0.5;
      ctx.drawImage(A.handle, u % TEX_P, 0, du, TEX_H, x - 0.3, -h, d + 0.6, h * 2);
      u += du;
    }
    ctx.restore();

    // screen-space specular on the grip
    const dx = Math.cos(w.th), dy = Math.sin(w.th);
    const facing = Math.abs(dx * 0.55 - dy * 0.83);
    const ox = -0.5 * 3.4, oy = -0.78 * 3.4;
    ctx.beginPath();
    ctx.moveTo(gx + dx * 9 + ox, gy + dy * 9 + oy);
    ctx.lineTo(gx + dx * (L - 8) + ox, gy + dy * (L - 8) + oy);
    ctx.strokeStyle = `rgba(255,255,255,${0.12 + 0.3 * facing})`;
    ctx.lineWidth = 1.5;
    ctx.lineCap = 'round';
    ctx.stroke();

    // knots: pommel, a ring one third up, and the transition into the thong
    const knot = (t, r) => {
      const x = gx + dx * L * t, y = gy + dy * L * t;
      ctx.beginPath(); ctx.arc(x, y, r + 1.9, 0, Math.PI * 2); ctx.fillStyle = skin.rim; ctx.fill();
      ctx.beginPath(); ctx.arc(x, y, r + 0.95, 0, Math.PI * 2); ctx.fillStyle = skin.outline; ctx.fill();
      ctx.save();
      ctx.translate(x, y);
      ctx.rotate(w.th);
      ctx.drawImage(A.knot, -r, -r, r * 2, r * 2);
      ctx.restore();
    };
    // two leather ring bands on the grip
    for (const t of [0.3, 0.37]) {
      const x = gx + dx * L * t, y = gy + dy * L * t;
      const h = hw(L * t) + 0.9;
      ctx.beginPath();
      ctx.moveTo(x + dy * h, y - dx * h);
      ctx.lineTo(x - dy * h, y + dx * h);
      ctx.strokeStyle = skin.outline; ctx.lineWidth = 3.4; ctx.lineCap = 'butt'; ctx.stroke();
      ctx.strokeStyle = skin.knot.base; ctx.lineWidth = 2; ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(x + dy * h * 0.75 - 0.4, y - dx * h * 0.75 - 0.6);
      ctx.lineTo(x + dy * h * 0.1 - 0.4, y - dx * h * 0.1 - 0.6);
      ctx.strokeStyle = 'rgba(255,255,255,0.35)'; ctx.lineWidth = 0.9; ctx.stroke();
    }
    knot(1, 5.9);
    knot(0, 7.2);
  }

  /**
   * Draw one whip. opts: { skin, fire, dt }
   * Returns the smoothed tip position {x, y}.
   */
  function drawWhip(ctx, w, opts) {
    const A = assets(opts.skin);
    drawTrail(ctx, w, A.skin, opts.fire);
    drawWristLoop(ctx, w, A, opts.dt || 0.016);
    const tip = drawThong(ctx, w, A, opts);
    drawHandle(ctx, w, A);
    return tip;
  }

  return { SKINS, drawWhip, recordTrail, skinNames: () => Object.keys(SKINS) };
})();

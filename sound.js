'use strict';
/**
 * Korbaj procedural sound engine — Web Audio API, zero assets required.
 *  - whoosh(): continuous filtered noise driven by tip velocity
 *  - crack():  layered transient (click + noise burst + resonant sweep + sub thump)
 *  - chime():  soft bell for Pat mode
 * Optional custom files (assets/sounds/whip.*, pat.*) are layered on or replace the synth.
 */
class KorbajSound {
  constructor() {
    this.ctx = null;
    this.ready = false;
    this.custom = { whip: null, pat: null };
    this.soundMode = 'mix';
  }

  async init() {
    if (this.ready) return;
    const AC = window.AudioContext || window.webkitAudioContext;
    this.ctx = new AC({ latencyHint: 'interactive' });
    const ctx = this.ctx;

    // Master chain: gain -> compressor (keeps cracks loud without clipping) -> out
    this.master = ctx.createGain();
    this.master.gain.value = 0.9;
    this.comp = ctx.createDynamicsCompressor();
    this.comp.threshold.value = -10;
    this.comp.knee.value = 6;
    this.comp.ratio.value = 8;
    this.comp.attack.value = 0.001;
    this.comp.release.value = 0.12;
    this.master.connect(this.comp).connect(ctx.destination);

    this.whiteBuf = this._makeNoise('white', 2);
    this.pinkBuf = this._makeNoise('pink', 3);
    this._buildWhoosh();

    try {
      const cfg = await window.korbaj.config();
      this.soundMode = cfg.soundMode;
    } catch (_) { /* defaults */ }
    await Promise.all(['whip', 'pat'].map((n) => this._loadCustom(n)));

    this.ready = true;
  }

  resume() {
    if (this.ctx && this.ctx.state === 'suspended') this.ctx.resume();
  }

  _makeNoise(kind, seconds) {
    const len = Math.floor(this.ctx.sampleRate * seconds);
    const buf = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
    const d = buf.getChannelData(0);
    if (kind === 'white') {
      for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    } else {
      // Paul Kellet's refined pink-noise filter
      let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0;
      for (let i = 0; i < len; i++) {
        const w = Math.random() * 2 - 1;
        b0 = 0.99886 * b0 + w * 0.0555179;
        b1 = 0.99332 * b1 + w * 0.0750759;
        b2 = 0.96900 * b2 + w * 0.1538520;
        b3 = 0.86650 * b3 + w * 0.3104856;
        b4 = 0.55000 * b4 + w * 0.5329522;
        b5 = -0.7616 * b5 - w * 0.0168980;
        d[i] = (b0 + b1 + b2 + b3 + b4 + b5 + b6 + w * 0.5362) * 0.11;
        b6 = w * 0.115926;
      }
    }
    return buf;
  }

  async _loadCustom(name) {
    try {
      const ab = await window.korbaj.loadSound(name);
      if (ab && ab.byteLength) this.custom[name] = await this.ctx.decodeAudioData(ab);
    } catch (e) {
      console.warn(`[korbaj] custom ${name} sound failed to decode:`, e);
    }
  }

  _playBuffer(buf, gain = 1, rate = 1) {
    const src = this.ctx.createBufferSource();
    src.buffer = buf;
    src.playbackRate.value = rate;
    const g = this.ctx.createGain();
    g.gain.value = gain;
    src.connect(g).connect(this.master);
    src.start();
  }

  // ---------------- Whoosh ----------------
  _buildWhoosh() {
    const ctx = this.ctx;
    const src = ctx.createBufferSource();
    src.buffer = this.pinkBuf;
    src.loop = true;
    this.whooshFilter = ctx.createBiquadFilter();
    this.whooshFilter.type = 'bandpass';
    this.whooshFilter.frequency.value = 400;
    this.whooshFilter.Q.value = 1.2;
    this.whooshGain = ctx.createGain();
    this.whooshGain.gain.value = 0;
    src.connect(this.whooshFilter).connect(this.whooshGain).connect(this.master);
    src.start();
  }

  /** speed: tip speed in px/frame (60fps-normalised). Call every frame. */
  whoosh(speed) {
    if (!this.ready) return;
    const t = this.ctx.currentTime;
    const n = Math.max(0, Math.min(1, (speed - 4) / 60));
    const vol = n * n * 0.55;
    const freq = 250 + n * 2600;
    this.whooshGain.gain.setTargetAtTime(vol, t, 0.03);
    this.whooshFilter.frequency.setTargetAtTime(freq, t, 0.03);
    this.whooshFilter.Q.setTargetAtTime(0.8 + n * 2.5, t, 0.05);
  }

  silenceWhoosh() {
    if (!this.ready) return;
    this.whooshGain.gain.setTargetAtTime(0, this.ctx.currentTime, 0.05);
  }

  // ---------------- Crack ("Teshh!") ----------------
  /** intensity 0..1, pan -1..1 */
  crack(intensity = 1, pan = 0) {
    if (!this.ready) return;
    this.resume();
    const ctx = this.ctx;
    const t = ctx.currentTime + 0.002;
    const I = 0.6 + 0.4 * Math.max(0, Math.min(1, intensity));

    const out = ctx.createStereoPanner();
    out.pan.value = Math.max(-1, Math.min(1, pan));
    out.connect(this.master);

    if (this.custom.whip) {
      this._playBuffer(this.custom.whip, I, 0.96 + Math.random() * 0.08);
      if (this.soundMode === 'replace') return;
    }
    const synthGain = this.custom.whip ? 0.5 : 1;

    // 1) Sonic-boom click: one-sample-sharp impulse through a waveshaper (the "snap")
    const clickLen = Math.floor(ctx.sampleRate * 0.004);
    const clickBuf = ctx.createBuffer(1, clickLen, ctx.sampleRate);
    const cd = clickBuf.getChannelData(0);
    for (let i = 0; i < clickLen; i++) {
      const env = Math.exp(-i / (clickLen * 0.12));
      cd[i] = (i === 0 ? 1 : (Math.random() * 2 - 1)) * env;
    }
    const click = ctx.createBufferSource();
    click.buffer = clickBuf;
    const shaper = ctx.createWaveShaper();
    shaper.curve = this._distCurve(40);
    const clickG = ctx.createGain();
    clickG.gain.value = 1.4 * I * synthGain;
    click.connect(shaper).connect(clickG).connect(out);
    click.start(t);

    // 2) White-noise burst, instant attack, fast exponential decay (the "tsh")
    const noise = ctx.createBufferSource();
    noise.buffer = this.whiteBuf;
    const hp = ctx.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.value = 1800;
    const nG = ctx.createGain();
    nG.gain.setValueAtTime(0.0001, t);
    nG.gain.linearRampToValueAtTime(1.1 * I * synthGain, t + 0.0015);
    nG.gain.exponentialRampToValueAtTime(0.25 * I * synthGain, t + 0.025);
    nG.gain.exponentialRampToValueAtTime(0.0001, t + 0.22);
    noise.connect(hp).connect(nG).connect(out);
    noise.start(t, Math.random() * 1.5);
    noise.stop(t + 0.25);

    // 3) Resonant bandpass sweep high -> mid (the "eshh" tail)
    const noise2 = ctx.createBufferSource();
    noise2.buffer = this.whiteBuf;
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.Q.value = 6;
    bp.frequency.setValueAtTime(9500, t);
    bp.frequency.exponentialRampToValueAtTime(2600, t + 0.12);
    const bG = ctx.createGain();
    bG.gain.setValueAtTime(0.0001, t);
    bG.gain.linearRampToValueAtTime(1.8 * I * synthGain, t + 0.002);
    bG.gain.exponentialRampToValueAtTime(0.0001, t + 0.16);
    noise2.connect(bp).connect(bG).connect(out);
    noise2.start(t, Math.random() * 1.5);
    noise2.stop(t + 0.18);

    // 4) Sub-bass transient for punch
    const sub = ctx.createOscillator();
    sub.type = 'sine';
    sub.frequency.setValueAtTime(170, t);
    sub.frequency.exponentialRampToValueAtTime(42, t + 0.09);
    const sG = ctx.createGain();
    sG.gain.setValueAtTime(0.0001, t);
    sG.gain.linearRampToValueAtTime(0.9 * I * synthGain, t + 0.003);
    sG.gain.exponentialRampToValueAtTime(0.0001, t + 0.12);
    sub.connect(sG).connect(out);
    sub.start(t);
    sub.stop(t + 0.14);

    // 5) Short room slap: delayed, filtered copy for realism
    const slap = ctx.createDelay(0.1);
    slap.delayTime.value = 0.038;
    const slapF = ctx.createBiquadFilter();
    slapF.type = 'lowpass';
    slapF.frequency.value = 3500;
    const slapG = ctx.createGain();
    slapG.gain.value = 0.18;
    bG.connect(slap).connect(slapF).connect(slapG).connect(out);
  }

  _distCurve(k) {
    const n = 1024;
    const c = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const x = (i * 2) / n - 1;
      c[i] = ((1 + k) * x) / (1 + k * Math.abs(x));
    }
    return c;
  }

  // ---------------- Pat chime ----------------
  chime() {
    if (!this.ready) return;
    this.resume();
    if (this.custom.pat) {
      this._playBuffer(this.custom.pat, 0.8);
      if (this.soundMode === 'replace') return;
    }
    const ctx = this.ctx;
    const t = ctx.currentTime + 0.005;
    const scale = [523.25, 587.33, 659.25, 783.99, 880.0, 1046.5]; // C major pentatonic-ish
    const base = scale[Math.floor(Math.random() * scale.length)];
    [1, 2, 3.01].forEach((mult, i) => {
      const o = ctx.createOscillator();
      o.type = 'sine';
      o.frequency.value = base * mult;
      const g = ctx.createGain();
      const peak = [0.22, 0.08, 0.04][i];
      g.gain.setValueAtTime(0.0001, t);
      g.gain.linearRampToValueAtTime(peak, t + 0.012);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 1.2 - i * 0.3);
      o.connect(g).connect(this.master);
      o.start(t);
      o.stop(t + 1.3);
    });
  }
}

window.KorbajSound = KorbajSound;

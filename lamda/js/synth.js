/* synth.js — Web Audio 合成器（钢琴 + 打击乐）
 * 不依赖任何音源文件，纯振荡器/噪声合成，保证单文件离线可跑。
 */
(function (global) {
  'use strict';

  var Synth = {
    ctx: null,
    master: null,
    noiseBuf: null,

    init: function () {
      if (this.ctx) return this.ctx;
      var AC = global.AudioContext || global.webkitAudioContext;
      if (!AC) return null;
      var c = new AC({ latencyHint: 'interactive' });
      this.ctx = c;

      var comp = c.createDynamicsCompressor();
      comp.threshold.value = -13;
      comp.knee.value = 14;
      comp.ratio.value = 3.2;
      comp.attack.value = 0.004;
      comp.release.value = 0.22;

      var master = c.createGain();
      master.gain.value = 0.9;
      master.connect(comp);
      comp.connect(c.destination);
      this.master = master;

      var len = Math.floor(c.sampleRate * 1.2);
      var buf = c.createBuffer(1, len, c.sampleRate);
      var d = buf.getChannelData(0);
      for (var i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
      this.noiseBuf = buf;

      return c;
    },

    resume: function () {
      if (!this.ctx) return;
      if (this.ctx.state === 'suspended') { var p = this.ctx.resume(); if (p && p.catch) p.catch(function () {}); }
    },
    suspend: function () {
      if (!this.ctx) return;
      if (this.ctx.state === 'running') { var p = this.ctx.suspend(); if (p && p.catch) p.catch(function () {}); }
    },
    latency: function () {
      var c = this.ctx;
      if (!c) return 0;
      var l = c.outputLatency;
      if (typeof l !== 'number' || !isFinite(l) || l <= 0) l = c.baseLatency || 0;
      return Math.min(0.12, l || 0);
    },

    /* ---------- 噪声源 ---------- */
    _noise: function (when, dur) {
      var c = this.ctx;
      var s = c.createBufferSource();
      s.buffer = this.noiseBuf;
      s.loop = true;
      s.start(when, Math.random() * 0.5);
      s.stop(when + dur + 0.06);
      return s;
    },
    _env: function (g, when, peak, attack, decay) {
      peak = Math.max(peak, 0.0004);
      g.gain.setValueAtTime(0.0001, when);
      g.gain.exponentialRampToValueAtTime(peak, when + attack);
      g.gain.exponentialRampToValueAtTime(0.0001, when + attack + decay);
    },

    /* ---------- 钢琴音色 ---------- */
    piano: function (when, freq, vel, dur, gainScale) {
      var c = this.ctx;
      if (!c || !isFinite(freq) || freq <= 0) return;
      var v = Math.max(0.05, vel / 127);
      var peak = 0.15 * (0.32 + 0.68 * v) * gainScale;
      var hold = Math.min(Math.max(dur, 0.1), 1.5);
      var end = when + hold + 0.42;

      var lp = c.createBiquadFilter();
      lp.type = 'lowpass';
      lp.Q.value = 0.6;
      var bright = Math.min(12000, 820 + freq * 9);
      lp.frequency.setValueAtTime(bright, when);
      lp.frequency.exponentialRampToValueAtTime(Math.max(420, bright * 0.3), when + 0.42);

      var g = c.createGain();
      g.gain.setValueAtTime(0.0001, when);
      g.gain.exponentialRampToValueAtTime(peak, when + 0.006);
      g.gain.exponentialRampToValueAtTime(peak * 0.46, when + 0.085);
      g.gain.exponentialRampToValueAtTime(0.0001, end);

      lp.connect(g);
      g.connect(this.master);

      var parts = [[1, 'triangle', 1.0], [2, 'sine', 0.26], [3.008, 'sine', 0.085]];
      for (var i = 0; i < parts.length; i++) {
        var f = freq * parts[i][0];
        if (f > 15000) continue;
        var o = c.createOscillator();
        o.type = parts[i][1];
        o.frequency.value = f;
        var og = c.createGain();
        og.gain.value = parts[i][2];
        o.connect(og);
        og.connect(lp);
        o.start(when);
        o.stop(end + 0.03);
      }
    },

    /* ---------- 打击乐 ---------- */
    drum: function (when, note, vel) {
      var c = this.ctx;
      if (!c) return;
      var a = Math.max(0.08, vel / 127);
      var out = this.master;
      var self = this;

      /* 底鼓 */
      if (note === 35 || note === 36) {
        var o = c.createOscillator();
        o.type = 'sine';
        o.frequency.setValueAtTime(165, when);
        o.frequency.exponentialRampToValueAtTime(46, when + 0.1);
        var g = c.createGain();
        this._env(g, when, 0.62 * a, 0.004, 0.28);
        o.connect(g); g.connect(out);
        o.start(when); o.stop(when + 0.32);
        return;
      }

      /* 军鼓 */
      if (note === 38 || note === 40) {
        var ns = this._noise(when, 0.2);
        var bp = c.createBiquadFilter();
        bp.type = 'bandpass'; bp.frequency.value = 1750; bp.Q.value = 0.7;
        var g2 = c.createGain();
        this._env(g2, when, 0.34 * a, 0.003, 0.15);
        ns.connect(bp); bp.connect(g2); g2.connect(out);

        var t = c.createOscillator();
        t.type = 'triangle'; t.frequency.value = 188;
        var g3 = c.createGain();
        this._env(g3, when, 0.14 * a, 0.003, 0.08);
        t.connect(g3); g3.connect(out);
        t.start(when); t.stop(when + 0.12);
        return;
      }

      /* 踩镲 */
      if (note === 42 || note === 44) {
        var nh = this._noise(when, 0.12);
        var hp = c.createBiquadFilter();
        hp.type = 'highpass'; hp.frequency.value = 8200;
        var gh = c.createGain();
        this._env(gh, when, 0.075 * a, 0.002, 0.045);
        nh.connect(hp); hp.connect(gh); gh.connect(out);
        return;
      }
      /* 开镲 */
      if (note === 46) {
        var no = this._noise(when, 0.4);
        var hp2 = c.createBiquadFilter();
        hp2.type = 'highpass'; hp2.frequency.value = 7200;
        var go = c.createGain();
        this._env(go, when, 0.07 * a, 0.002, 0.26);
        no.connect(hp2); hp2.connect(go); go.connect(out);
        return;
      }
      /* 吊镲 */
      if (note === 49 || note === 51 || note === 52 || note === 57 || note === 59) {
        var nc = this._noise(when, 1.0);
        var hc = c.createBiquadFilter();
        hc.type = 'highpass'; hc.frequency.value = 4600;
        var gc = c.createGain();
        this._env(gc, when, 0.11 * a, 0.004, 0.85);
        nc.connect(hc); hc.connect(gc); gc.connect(out);
        return;
      }
      /* 通鼓 */
      if (note >= 41 && note <= 50) {
        var f0 = note <= 43 ? 110 : (note <= 47 ? 165 : 230);
        var ot = c.createOscillator();
        ot.type = 'sine';
        ot.frequency.setValueAtTime(f0 * 1.6, when);
        ot.frequency.exponentialRampToValueAtTime(f0, when + 0.16);
        var gt = c.createGain();
        this._env(gt, when, 0.3 * a, 0.004, 0.2);
        ot.connect(gt); gt.connect(out);
        ot.start(when); ot.stop(when + 0.26);
        var nn = this._noise(when, 0.1);
        var gn = c.createGain();
        this._env(gn, when, 0.06 * a, 0.003, 0.07);
        nn.connect(gn); gn.connect(out);
        return;
      }
      /* 其它：轻击 */
      var nd = this._noise(when, 0.08);
      var bp2 = c.createBiquadFilter();
      bp2.type = 'bandpass'; bp2.frequency.value = 2400; bp2.Q.value = 1.2;
      var gd = c.createGain();
      this._env(gd, when, 0.05 * a, 0.002, 0.05);
      nd.connect(bp2); bp2.connect(gd); gd.connect(out);
    },

    /* ---------- 打击反馈（玩家按键） ---------- */
    tick: function (when, power) {
      var c = this.ctx;
      if (!c) return;
      var p = (typeof power === 'number') ? power : 0.05;
      var ns = this._noise(when, 0.06);
      var bp = c.createBiquadFilter();
      bp.type = 'bandpass'; bp.frequency.value = 3200; bp.Q.value = 2.2;
      var g = c.createGain();
      this._env(g, when, p, 0.001, 0.035);
      ns.connect(bp); bp.connect(g); g.connect(this.master);
    }
  };

  global.Synth = Synth;
})(window);

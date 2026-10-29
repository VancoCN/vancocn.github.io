/* skeleton.js — 旋律骨架提取
 *
 * 问题：MIDI 右手轨是「旋律 + 装饰音 + 经过音」，密度常常 4~6 音/秒，
 *       而单指持续敲击的物理上限约 6~8 次/秒，所以直接照搬不可玩。
 *
 * 做法：抽出「旋律骨架」——只保留有音乐重量感的那批音，压到 2~4 音/秒，
 *       同时把时值够长的音标成 hold（按住），给单键补上第二个输入维度。
 *
 * 三条规则（按优先级）：
 *   1. 装饰音：时值极短且紧贴在别的音后面 → 丢
 *   2. 密度限流：距离上一个保留音 < minGap → 只有明显重音才留
 *   3. 时值 ≥ holdMin → 标 hold
 */
(function (root) {
  'use strict';

  var OPT = {
    minGap: 0.24,     /* 两个保留音之间的最小间隔（秒）——决定上限密度 */
    minDur: 0.07,     /* 低于此时值视为装饰音 */
    accentVel: 72,    /* 挤在 minGap 内时，只有力度 ≥ 此值才算重音 */
    holdMin: 0.22,    /* MIDI 本身时值 ≥ 此值 → hold（按住） */
    chordWin: 0.028,  /* 和弦合并窗口 */

    /* 节奏空隙处主动生成 hold：音乐自然停顿的地方，正好让玩家「按住等下一拍」。
       MIDI 里真正的长音很少（单声部钢琴几乎都是断奏），靠这条才够用。
       单键的硬约束：hold 结束到下一个音之间，必须留出「松开再按下」的时间
       （约 0.12s，单键没有第二根手指，这是物理下限）。 */
    gapHoldMin: 0.42, /* 与下一个音的间隔 ≥ 此值才考虑（也是 hold 最短时长的来源） */
    gapHoldMax: 2.20, /* 间隔太长（段落间停顿）则不生成，避免按得莫名其妙 */
    holdMaxDur: 1.10, /* 自动生成的 hold 最长按住时长 */
    holdMinDur: 0.28, /* 按住至少要这么久，否则和点按区分不出来 */
    holdGap: 0.12     /* hold 结束 → 下一个音之间留的「松开再按」时间 */
  };

  function skeleton(chart, opt) {
    var o = {};
    for (var k in OPT) o[k] = OPT[k];
    if (opt) for (var k in opt) o[k] = opt[k];

    var ti = chart.player || 0;
    var src = chart.notes[ti] || [];
    var raw = [];
    for (var i = 0; i < src.length; i++) {
      var n = src[i];
      raw.push({ t: n[0], dur: Math.max(0.03, n[1] - n[0]), pitch: n[2], vel: n[3] });
    }
    raw.sort(function (a, b) { return a.t - b.t; });

    /* 和弦合并：同一瞬间的多个音只算一次击打 */
    var groups = [], cur = null;
    for (var i = 0; i < raw.length; i++) {
      var n = raw[i];
      if (!cur || n.t - cur.t > o.chordWin) { cur = { t: n.t, ns: [] }; groups.push(cur); }
      cur.ns.push(n);
    }
    var G = groups.map(function (g) {
      var vel = 0, dur = 0, sum = 0, lo = 999, hi = 0;
      for (var k = 0; k < g.ns.length; k++) {
        var n = g.ns[k];
        if (n.vel > vel) vel = n.vel;
        if (n.dur > dur) dur = n.dur;
        sum += n.pitch;
        if (n.pitch < lo) lo = n.pitch;
        if (n.pitch > hi) hi = n.pitch;
      }
      return { t: g.t, dur: dur, vel: vel, pitch: sum / g.ns.length, lo: lo, hi: hi, cnt: g.ns.length };
    });

    /* 音域只算一次，是静态的 —— 横向映射不会随时间变，从根上避免音符闪烁 */
    var pLo = 999, pHi = 0;
    for (var i = 0; i < G.length; i++) {
      if (G[i].pitch < pLo) pLo = G[i].pitch;
      if (G[i].pitch > pHi) pHi = G[i].pitch;
    }

    var out = [], lastT = -99, dropDeco = 0, dropDens = 0;
    for (var i = 0; i < G.length; i++) {
      var g = G[i];
      var gap = g.t - lastT;

      /* 规则 1：装饰音 */
      if (g.dur < o.minDur && gap < o.minGap) { dropDeco++; continue; }

      /* 规则 2：密度限流（重音可插进间隙，但也要留一点最小间距） */
      if (gap < o.minGap && !(g.vel >= o.accentVel && gap >= o.minGap * 0.55)) {
        dropDens++; continue;
      }

      out.push({
        t: g.t, dur: g.dur, pitch: g.pitch, vel: g.vel,
        lo: g.lo, hi: g.hi, cnt: g.cnt, hold: g.dur >= o.holdMin, auto: false
      });
      lastT = g.t;
    }

    /* 规则 3：节奏空隙 → 主动生成 hold。
       落在音乐自然停住的地方，玩家按住的这段时间正好「等下一拍」，
       比硬塞长音自然。
       阈值取「这首歌自己间隔分布的第 78 百分位」：
       不用中位数是因为密集曲（badapple/pupa）的间隔普遍很短，
       按中位数放大还是触发不了；取分位数则无论多密都有约两成的间隔够长。
       再限制 hold 占比（≤22%）和连续数量（≤2），避免满屏长音。 */
    var ivs = [];
    for (var i = 1; i < out.length; i++) ivs.push(out[i].t - out[i - 1].t);
    ivs.sort(function (a, b) { return a - b; });
    var q = ivs.length ? ivs[Math.min(ivs.length - 1, Math.floor(ivs.length * 0.78))] : 0.6;
    var gapMin = Math.min(o.gapHoldMax, Math.max(o.gapHoldMin, q));
    var maxHolds = Math.floor(out.length * 0.13);

    var holds = 0, run = 0, autoHolds = 0;
    for (var i = 0; i < out.length; i++) {
      var cur0 = out[i];
      var nxt = out[i + 1];
      if (cur0.hold) { holds++; run++; continue; }
      if (!nxt || run >= 2 || autoHolds >= maxHolds) { run = 0; continue; }
      var span = nxt.t - cur0.t;
      if (span >= gapMin && span <= o.gapHoldMax) {
        /* 留出松开再按的时间；按不到最短时长就不生成 */
        var hd = Math.min(o.holdMaxDur, span - o.holdGap);
        if (hd < o.holdMinDur) { run = 0; continue; }
        cur0.hold = true;
        cur0.auto = true;
        cur0.dur = hd;
        holds++; run++; autoHolds++;
      } else {
        run = 0;
      }
    }

    return {
      notes: out, pLo: pLo, pHi: pHi,
      rawTaps: G.length, kept: out.length, holds: holds,
      autoHolds: autoHolds, gapMin: gapMin,
      dropDeco: dropDeco, dropDens: dropDens
    };
  }

  /* 密度统计：平均 + 峰值（1 秒滑窗）+ 超过 n/s 的时间占比 */
  function density(notes, duration, over) {
    if (!notes.length || !(duration > 0)) return { avg: 0, peak: 0, overRatio: 0 };
    var n = notes.length;
    var peak = 0, overCnt = 0;
    var thr = over || 5;
    for (var i = 0, j = 0; i < n; i++) {
      while (notes[i].t - notes[j].t > 1.0) j++;
      var c = i - j + 1;
      if (c > peak) peak = c;
      if (c > thr) overCnt++;
    }
    return {
      avg: n / duration,
      peak: peak,
      overRatio: overCnt / n
    };
  }

  root.LAMDA_SKELETON = { skeleton: skeleton, OPT: OPT, density: density };
})(typeof window !== 'undefined' ? window : globalThis);

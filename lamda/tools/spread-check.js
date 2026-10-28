/* 横向铺开度测量：每首曲子按秒推进，统计「屏幕上同时可见的音符」横跨了多用宽度 */
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const ROOT = path.resolve(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

const html = read('index.html').replace(/<script[\s\S]*?<\/script>/g, '');
const dom = new JSDOM(html, {
  url: 'http://localhost/index.html',
  runScripts: 'dangerously',
  pretendToBeVisual: true,
  beforeParse(win) {
    const noop = function () {};
    const grad = { addColorStop() {} };
    const ctx = {
      globalAlpha: 1, fillStyle: '#000', strokeStyle: '#000', lineWidth: 1,
      font: '10px sans', textAlign: 'left', textBaseline: 'alphabetic',
      letterSpacing: '0px', lineCap: 'butt',
      save: noop, restore: noop, beginPath: noop, closePath: noop, moveTo: noop,
      lineTo: noop, arc: noop, rect: noop, stroke: noop, fill: noop,
      fillRect: noop, strokeRect: noop, clearRect: noop, clip: noop,
      translate: noop, rotate: noop, scale: noop, setTransform: noop,
      fillText: noop, strokeText: noop,
      measureText: (s) => ({ width: (s || '').length * 6 }),
      createLinearGradient: () => grad, createRadialGradient: () => grad,
      getImageData: (x, y, w, h) => ({ data: new Uint8ClampedArray(Math.max(4, w * h * 4)) }),
      putImageData: noop, drawImage: noop
    };
    win.HTMLCanvasElement.prototype.getContext = function () { ctx.canvas = this; return ctx; };
    Object.defineProperty(win.HTMLCanvasElement.prototype, 'clientWidth', { configurable: true, get: () => 1280 });
    Object.defineProperty(win.HTMLCanvasElement.prototype, 'clientHeight', { configurable: true, get: () => 720 });
    win.requestAnimationFrame = () => 0;
    win.cancelAnimationFrame = () => {};

    const param = () => ({ value: 0, setValueAtTime() { return this; }, linearRampToValueAtTime() { return this; },
      exponentialRampToValueAtTime() { return this; }, cancelScheduledValues() { return this; }, setTargetAtTime() { return this; } });
    const node = () => ({ connect(a) { return a; }, disconnect() {}, start() {}, stop() {},
      gain: param(), frequency: param(), detune: param(), Q: param(), threshold: param(), knee: param(),
      ratio: param(), attack: param(), release: param(), type: '', buffer: null, loop: false });
    function FakeAC() { this.sampleRate = 48000; this.state = 'running'; this.destination = node(); this.T = 0; }
    FakeAC.prototype = {
      get currentTime() { return this.T; },
      createGain: node, createBiquadFilter: node, createOscillator: node, createBufferSource: node,
      createDynamicsCompressor: node, createWaveShaper: node,
      createBuffer(ch, len) { return { getChannelData: () => new Float32Array(len) }; },
      resume() { return Promise.resolve(); }, suspend() { return Promise.resolve(); }
    };
    win.AudioContext = function () { return new FakeAC(); };
  }
});
const win = dom.window;
win.eval(read('charts/index.js'));
['badapple', 'pupa', 'amidst-the-jungle', 'the-earth', 'the-field-of-hopes-and-dreams']
  .forEach((id) => win.eval(read('charts/' + id + '.js')));
win.eval(read('js/synth.js'));
win.eval(read('js/game.js'));
const M = win.__MR;

setTimeout(() => {
  const L = M.L;
  const rows = [];
  M.App.songs.forEach((song, si) => {
    M.startSong(si, 0, true);
    M.computeLayout();
    const fieldW = L.right - L.left;
    const fr = [];
    let chordsSeen = 0;
    for (let t = 2; t < song.duration - 2; t += 0.5) {
      M.updateSpan(t, true);
      const gs = M.G.groups;
      let lo = 1e9, hi = -1e9, c = 0;
      for (let i = M.G.first; i < gs.length; i++) {
        const g = gs[i];
        const y = L.judgeY - (g.t - t) * L.pys;
        if (y < L.padY - 70) break;
        if (y > L.judgeY + 240) continue;
        const x = M.groupX(g);
        if (x < lo) lo = x;
        if (x > hi) hi = x;
        c++;
      }
      if (c >= 2) { fr.push((hi - lo) / fieldW); chordsSeen++; }
    }
    fr.sort((a, b) => a - b);
    const pc = (p) => fr.length ? (fr[Math.floor(fr.length * p)] * 100) : 0;
    rows.push({
      id: song.id,
      n: fr.length,
      p10: pc(0.10), p25: pc(0.25), med: pc(0.50), p75: pc(0.75), p90: pc(0.90),
      widthPx: fieldW
    });
  });
  console.log('可见音符横向占比（% of 可用宽度）');
  console.log('id'.padEnd(34), '  p10   p25   med   p75   p90');
  rows.forEach((r) => {
    console.log(r.id.padEnd(34),
      String(r.p10.toFixed(0)).padStart(4),
      String(r.p25.toFixed(0)).padStart(5),
      String(r.med.toFixed(0)).padStart(5),
      String(r.p75.toFixed(0)).padStart(5),
      String(r.p90.toFixed(0)).padStart(5));
  });
  console.log('\n可用宽度', rows[0].widthPx, 'px');
}, 300);

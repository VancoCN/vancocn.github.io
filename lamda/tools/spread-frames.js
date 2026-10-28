/* 模拟真实逐帧推进（不 force），检查音高窗是否跟得上、铺开度是否达标 */
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');
const ROOT = path.resolve(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

const html = read('index.html').replace(/<script[\s\S]*?<\/script>/g, '');
const dom = new JSDOM(html, {
  url: 'http://localhost/index.html', runScripts: 'dangerously', pretendToBeVisual: true,
  beforeParse(win) {
    const noop = function () {}, grad = { addColorStop() {} };
    const ctx = { globalAlpha: 1, fillStyle: '', strokeStyle: '', lineWidth: 1, font: '',
      textAlign: '', textBaseline: '', letterSpacing: '', lineCap: '',
      save: noop, restore: noop, beginPath: noop, closePath: noop, moveTo: noop, lineTo: noop,
      arc: noop, rect: noop, stroke: noop, fill: noop, fillRect: noop, strokeRect: noop,
      clearRect: noop, clip: noop, translate: noop, rotate: noop, scale: noop, setTransform: noop,
      fillText: noop, strokeText: noop, measureText: (s) => ({ width: (s || '').length * 6 }),
      createLinearGradient: () => grad, createRadialGradient: () => grad,
      getImageData: (x, y, w, h) => ({ data: new Uint8ClampedArray(Math.max(4, w * h * 4)) }),
      putImageData: noop, drawImage: noop };
    win.HTMLCanvasElement.prototype.getContext = function () { ctx.canvas = this; return ctx; };
    Object.defineProperty(win.HTMLCanvasElement.prototype, 'clientWidth', { configurable: true, get: () => 1280 });
    Object.defineProperty(win.HTMLCanvasElement.prototype, 'clientHeight', { configurable: true, get: () => 720 });
    win.requestAnimationFrame = () => 0; win.cancelAnimationFrame = () => {};
    const param = () => ({ value: 0, setValueAtTime() { return this; }, linearRampToValueAtTime() { return this; },
      exponentialRampToValueAtTime() { return this; }, cancelScheduledValues() { return this; }, setTargetAtTime() { return this; } });
    const node = () => ({ connect(a) { return a; }, disconnect() {}, start() {}, stop() {},
      gain: param(), frequency: param(), detune: param(), Q: param(), threshold: param(), knee: param(),
      ratio: param(), attack: param(), release: param(), type: '', buffer: null, loop: false });
    function FakeAC() { this.sampleRate = 48000; this.state = 'running'; this.destination = node(); this.T = 0; }
    FakeAC.prototype = { get currentTime() { return this.T; }, createGain: node, createBiquadFilter: node,
      createOscillator: node, createBufferSource: node, createDynamicsCompressor: node, createWaveShaper: node,
      createBuffer(c, l) { return { getChannelData: () => new Float32Array(l) }; },
      resume() { return Promise.resolve(); }, suspend() { return Promise.resolve(); } };
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
  console.log('逐帧推进（60fps，不 force），检查铺开度');
  M.App.songs.forEach((song, si) => {
    M.startSong(si, 0, true);
    M.computeLayout();
    /* 从 0 开始逐帧推进，模拟真实游玩 */
    const ratios = [];
    const dt = 1 / 60;
    for (let t = 0; t < song.duration; t += dt) {
      M.updateSpan(t, false);
      /* 每 0.5s 抽一帧统计 */
      if (Math.abs(t / 0.5 - Math.round(t / 0.5)) > dt / 2) continue;
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
      if (c >= 2) ratios.push((hi - lo) / (L.right - L.left));
    }
    ratios.sort((a, b) => a - b);
    const pc = (p) => (ratios[Math.floor(ratios.length * p)] * 100).toFixed(0);
    console.log('  ' + song.id.padEnd(34) +
      ' p10=' + pc(0.10).padStart(3) + '%  med=' + pc(0.50).padStart(3) +
      '%  p90=' + pc(0.90).padStart(3) + '%  worst=' + pc(0) + '%');
  });
}, 300);

/* 量化「音符闪动」：逐帧推进，统计每个音符在屏幕上的 x 位移量。
   闪动的根因是 x 依赖会随时间变化的全局音高窗（updateSpan），
   所以只要窗口一动，屏幕上所有音符都会横向滑动。 */
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
  console.log('音符横向漂移量（逐帧 60fps，同一音符相邻两帧的 x 变化）');
  console.log('曲目'.padEnd(34) + ' 平均|dx|  最大|dx|  >1px 帧占比  >6px(肉眼可见)帧占比');

  M.App.songs.forEach((song, si) => {
    M.startSong(si, 0, true);
    M.computeLayout();
    const dt = 1 / 60;
    let sum = 0, n = 0, max = 0, over1 = 0, over6 = 0;
    let prev = null;

    for (let t = 0; t < song.duration; t += dt) {
      M.updateSpan(t, false);
      /* 取当前屏幕上所有可见音符的 (t, x) 快照 */
      const cur = new Map();
      const gs = M.G.groups;
      for (let i = M.G.first; i < gs.length; i++) {
        const g = gs[i];
        const y = L.judgeY - (g.t - t) * L.pys;
        if (y < L.padY - 70) break;
        if (y > L.judgeY + 240) continue;
        cur.set(g, M.groupX(g));
      }
      if (prev) {
        for (const [g, x] of cur) {
          if (!prev.has(g)) continue;          // 新出现的音符不算漂移
          const d = Math.abs(x - prev.get(g));
          sum += d; n++;
          if (d > max) max = d;
          if (d > 1) over1++;
          if (d > 6) over6++;
        }
      }
      prev = cur;
    }
    const pct = (v) => (n ? (v / n * 100).toFixed(1) : '0.0').padStart(6) + '%';
    console.log(song.id.padEnd(34) +
      (n ? (sum / n).toFixed(2) : '0').padStart(7) + 'px' +
      max.toFixed(1).padStart(9) + 'px' +
      pct(over1) + pct(over6));
  });
}, 300);

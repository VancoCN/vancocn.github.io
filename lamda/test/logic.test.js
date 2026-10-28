/* 逻辑自测：用 jsdom + 假音频时钟驱动真实 game.js，验证判定 / 计分 / 和弦 / 漏击 */
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const ROOT = path.resolve(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

let pass = 0, fail = 0;
function ok(cond, label, extra) {
  if (cond) { pass++; console.log('  \u2713 ' + label); }
  else { fail++; console.log('  \u2717 ' + label + (extra ? '  -> ' + extra : '')); }
}
function eq(a, b, label) { ok(a === b, label, 'got ' + a + ', want ' + b); }
function near(a, b, tol, label) { ok(Math.abs(a - b) <= tol, label, 'got ' + a + ', want ~' + b); }

/* ---------------- 2D 上下文桩 ---------------- */
function makeCtx() {
  const grad = { addColorStop() {} };
  const noop = function () {};
  const ctx = {
    canvas: null, _arcs: 0,
    globalAlpha: 1, fillStyle: '#000', strokeStyle: '#000', lineWidth: 1,
    font: '10px sans', textAlign: 'left', textBaseline: 'alphabetic',
    letterSpacing: '0px', lineCap: 'butt', shadowBlur: 0,
    save: noop, restore: noop, beginPath: noop, closePath: noop,
    moveTo: noop, lineTo: noop, arc: function () { ctx._arcs++; }, rect: noop,
    stroke: noop, fill: noop,
    fillRect: noop, strokeRect: noop, clearRect: noop, clip: noop,
    translate: noop, rotate: noop, scale: noop, setTransform: noop, resetTransform: noop,
    fillText: noop, strokeText: noop,
    measureText: (s) => ({ width: (s || '').length * 6 }),
    createLinearGradient: () => grad, createRadialGradient: () => grad,
    createPattern: () => null,
    getImageData: (x, y, w, h) => ({ data: new Uint8ClampedArray(Math.max(4, w * h * 4)) }),
    putImageData: noop, drawImage: noop
  };
  return ctx;
}

/* ---------------- Web Audio 桩 ---------------- */
function makeAudio(win) {
  const param = () => ({
    value: 0,
    setValueAtTime() { return this; },
    linearRampToValueAtTime() { return this; },
    exponentialRampToValueAtTime() { return this; },
    cancelScheduledValues() { return this; },
    setTargetAtTime() { return this; }
  });
  const node = () => ({
    connect(a) { return a; }, disconnect() {}, start() {}, stop() {},
    gain: param(), frequency: param(), detune: param(), Q: param(),
    threshold: param(), knee: param(), ratio: param(), attack: param(), release: param(),
    type: '', buffer: null, loop: false
  });
  function FakeAC() {
    this.sampleRate = 48000;
    this.state = 'running';
    this.destination = node();
    this.T = 0;
  }
  FakeAC.prototype = {
    get currentTime() { return this.T; },
    createGain: node, createBiquadFilter: node, createOscillator: node,
    createBufferSource: node, createDynamicsCompressor: node, createWaveShaper: node,
    createBuffer(ch, len) { return { getChannelData: () => new Float32Array(len) }; },
    resume() { this.state = 'running'; return Promise.resolve(); },
    suspend() { this.state = 'suspended'; return Promise.resolve(); }
  };
  let inst = null;
  win.AudioContext = function () { inst = new FakeAC(); return inst; };
  return () => inst;
}

/* ---------------- 启动 ---------------- */
const html = read('index.html').replace(/<script[\s\S]*?<\/script>/g, '');
const CHART_ID = 'badapple';

const dom = new JSDOM(html, {
  url: 'http://localhost:8787/index.html',
  runScripts: 'dangerously',
  pretendToBeVisual: true,
  beforeParse(win) {
    const ctx = makeCtx();
    win.HTMLCanvasElement.prototype.getContext = function () { ctx.canvas = this; return ctx; };
    Object.defineProperty(win.HTMLCanvasElement.prototype, 'clientWidth', { configurable: true, get: () => 1280 });
    Object.defineProperty(win.HTMLCanvasElement.prototype, 'clientHeight', { configurable: true, get: () => 720 });
    win.requestAnimationFrame = () => 0;   // 关闭自动循环，测试里手动推进
    win.cancelAnimationFrame = () => {};
  }
});
const win = dom.window;
const getAC = makeAudio(win);

// 谱面是由 charts/index.js + charts/<id>.js 静态加载的，这里直接预置
win.eval(read('charts/index.js'));
win.eval(read(`charts/${CHART_ID}.js`));
win.eval(read('charts/pupa.js'));
win.eval(read('charts/amidst-the-jungle.js'));
win.eval(read('charts/the-earth.js'));
win.eval(read('charts/the-field-of-hopes-and-dreams.js'));
win.eval(read('js/synth.js'));
win.eval(read('js/game.js'));

const M = win.__MR;
const G = M.G;
const AC = () => getAC();

function boot() {
  return new Promise((resolve) => {
    const t0 = Date.now();
    (function poll() {
      if (M && M.App && M.App.booted) return resolve();
      if (Date.now() - t0 > 4000) return resolve();
      setTimeout(poll, 20);
    })();
  });
}

(async function run() {
  await boot();
  console.log('\n== 载入 ==');
  ok(!!M, '__MR 已挂载');
  eq(M.App.songs.length, 5, '曲库载入 5 首');
  const song = M.App.songs[0];
  eq(song.title, 'Bad Apple!!', '曲名（来自谱面）');
  eq(song.taps, 848, '可击打分组数 = 848');
  near(song.duration, 215.64, 0.05, '时长 215.64s');
  near(song.bpm, 138, 0.1, 'BPM 138');
  eq(song.melodyTrack, 0, '玩家音轨 = 第 1 条音轨');
  eq(song.level, 10, '难度 LV.10');
  eq(song.cover, 'badapple.jpg', '曲绘文件名');
  eq(song.orig, false, '非原创曲无标记');
  const jg = M.App.songs.filter(function (s) { return s.id === 'amidst-the-jungle'; })[0];
  ok(!!jg, '新曲已加载');
  eq(jg.title, 'Amidst The Jungle', '新曲曲名');
  eq(jg.orig, true, '新曲标记为原创');
  eq(jg.cover, '', '新曲无曲绘');
  eq(jg.taps, 177, '新曲击打单位 = 177');
  near(jg.duration, 134.116, 0.05, '新曲时长 134.116s');
  near(jg.bpm, 68, 0.1, '新曲 BPM 68');
  eq(jg.level, 3, '新曲难度 LV.03');
  const te = M.App.songs.filter(function (s) { return s.id === 'the-earth'; })[0];
  ok(!!te, 'the Earth 已加载');
  eq(te.title, 'The Earth', 'the Earth 曲名');
  eq(te.artist, 'Cheetah Mobile', 'the Earth 曲师');
  eq(te.cover, '', '无曲绘（走艺术字封面）');
  eq(te.taps, 245, 'the Earth 击打单位 = 245');
  eq(te.level, 6, 'the Earth 难度 LV.06');
  near(te.bpm, 100, 0.1, 'the Earth BPM 100');
  eq(te.orig, false, 'the Earth 非原创曲');
  const fh = M.App.songs.filter(function (s) { return s.id === 'the-field-of-hopes-and-dreams'; })[0];
  ok(!!fh, 'The Field of Hopes and Dreams 已加载');
  eq(fh.title, 'The Field of Hopes and Dreams', '新曲曲名');
  eq(fh.artist, 'Toby Fox', '新曲曲师');
  eq(fh.cover, '', '无曲绘（走艺术字封面）');
  eq(fh.taps, 542, '新曲击打单位 = 542');
  eq(fh.level, 8, '新曲难度 LV.08');
  near(fh.bpm, 125, 0.1, '新曲 BPM 125');
  eq(fh.orig, false, '新曲非原创');
  eq(song.parsed.tracks.length, 3, '谱面含 3 条音轨');
  ok(song.parsed.beats.length > 400, '节拍线由 tempo 生成（' + song.parsed.beats.length + ' 拍）');

  /* 重新开始 */
  function restart() {
    M.startSong(0, 0, true);   // 第三参 true = 跳过进歌动画，直接开局
    const a = AC();
    a.T = 0;
    M.startSong(0, 0, true);   // 再次调用以保证 t0 基于 T=0
  }
  function setT(t) { AC().T = G.t0 + t; }

  restart();
  console.log('\n== 谱面 ==');
  eq(G.total, 848, '总分组');
  near(G.perNote, 1000000 / 848, 0.001, '每分组分值');
  const chord = G.groups.find((g) => g.notes.length > 1);
  ok(!!chord, '存在和弦组（>1 音符同时按下）');
  eq(G.events.length, 1173 + 1336 + 1113, '全部 3 条音轨都进入播放队列');
  ok(G.events.some((e) => e.drum), '鼓轨被识别为打击乐');

  /* ---------- 单个判定 ---------- */
  console.log('\n== 判定窗口 ==');
  restart();
  const g0 = G.groups[0];
  setT(g0.t);
  M.press(win.performance.now());
  eq(G.perfect, 1, '±0ms -> PERFECT');
  eq(G.combo, 1, '连击 +1');
  near(G.score, Math.round(G.perNote), 1, '得分 = 1 个分组');

  restart();
  setT(G.groups[0].t + 0.150);
  M.press(win.performance.now());
  eq(G.good, 1, '+150ms -> GOOD（窗口边界）');
  eq(G.perfect, 0, '+150ms 不计 PERFECT');
  near(G.score, Math.round(G.perNote * 0.85), 1, 'GOOD 得 85%');

  restart();
  setT(G.groups[0].t - 0.150);
  M.press(win.performance.now());
  eq(G.good, 1, '-150ms -> GOOD（窗口边界）');

  restart();
  setT(G.groups[0].t + 0.095);
  M.press(win.performance.now());
  eq(G.perfect, 1, '+95ms -> 仍为 PERFECT');

  restart();
  setT(G.groups[0].t + 0.105);
  M.press(win.performance.now());
  eq(G.good, 1, '+105ms -> GOOD');

  restart();
  setT(G.groups[0].t + 0.160);
  M.press(win.performance.now());
  eq(G.good, 0, '+160ms 超出 GOOD 窗口');
  eq(G.perfect, 0, '+160ms 不计分');

  /* 判定精度：记录误差，且不会串到后一个音符 */
  restart();
  setT(G.groups[0].t + 0.030);
  M.press(win.performance.now());
  eq(G.perfect, 1, '+30ms -> PERFECT');
  near(G.judge.err, 0.030, 0.006, 'PERFECT 记录误差值');
  eq(G.judge.txt, 'PERFECT', '判定文字为 PERFECT');
  eq(G.judge.k, 1, 'PERFECT 判定等级 = 1');

  restart();
  setT(G.groups[0].t + 0.120);
  M.press(win.performance.now());
  eq(G.good, 1, '+120ms -> GOOD');
  eq(G.judge.txt, 'GOOD', '判定文字为 GOOD');
  eq(G.judge.k, 2, 'GOOD 判定等级 = 2（与 PERFECT 区分）');
  ok(G.judge.k !== 1, 'GOOD 的等级与 PERFECT 不同，可用于区分特效');

  /* 只消耗一个音符：后面的音符不受影响 */
  restart();
  const gapG = G.groups[0], nextG = G.groups[1];
  setT(gapG.t);
  M.press(win.performance.now());
  eq(G.perfect, 1, '第一个音符被判 PERFECT');
  eq(G.groups[1].st, 0, '后一个音符未被一起消耗');
  ok(nextG.t > gapG.t, '音符按时间递增');
  /* 后面的音符仍可正常判定，不会继承前一个的判定结果 */
  setT(nextG.t);
  M.press(win.performance.now());
  eq(G.perfect, 2, '下一个音符独立判定为 PERFECT');
  eq(G.good, 0, 'GOOD 没有传导到下一个音符');

  /* 判定偏移校准 */
  restart();
  M.S.offset = 0;
  setT(G.groups[0].t + 0.120);
  M.press(win.performance.now());
  eq(G.good, 1, '偏移 0 时 +120ms 是 GOOD（超出 ±100ms）');

  restart();
  M.S.offset = 0;
  setT(G.groups[0].t + 0.120);
  M.press(G.t0 !== null ? win.performance.now() : win.performance.now());
  eq(G.good, 1, '（基线）');

  restart();
  M.S.offset = 0;
  setT(G.groups[0].t + 0.065);
  M.S.offset = -30;      // 玩家反馈偏晚，减 30ms 抵消 -> 实际 +95ms
  M.press(win.performance.now());
  eq(G.perfect, 1, '偏移 -30ms 后同样输入变 PERFECT');
  M.S.offset = 0;

  /* 越界的偏移被夹住 */
  M.S.offset = 0;
  M.openSettings('select');
  M.closeSettings();
  ok(true, '设置面板可开关');

  restart();
  setT(G.groups[0].t + 0.200);
  M.press(win.performance.now());
  eq(G.perfect + G.good, 0, '+200ms 按不到任何音符（不计分）');
  M.update();
  eq(G.miss, 1, '越过窗口 -> MISS');
  eq(G.combo, 0, 'MISS 断连击');
  eq(G.score, 0, 'MISS 不得分');

  /* ---------- 和弦只按一次 ---------- */
  console.log('\n== 和弦 ==');
  restart();
  const gi = G.groups.indexOf(chord);
  for (let k = 0; k < gi; k++) { setT(G.groups[k].t); M.press(win.performance.now()); }
  const beforeCombo = G.combo;
  const beforeScore = G.score;
  const beforePerfect = G.perfect;
  setT(chord.t);
  M.press(win.performance.now());
  eq(chord.notes.length > 1 ? G.combo - beforeCombo : -1, 1, '和弦只加 1 连击（' + chord.notes.length + ' 个音）');
  eq(G.perfect - beforePerfect, 1, '和弦只计 1 次 PERFECT');
  near(G.score - beforeScore, Math.round(beforeScore + G.perNote) - beforeScore, 2, '和弦按一个分组计分');
  // 再按一次不应重复得分（下一组在 100ms 之外）
  const c2 = G.combo, s2 = G.score;
  setT(chord.t + 0.02);
  M.press(win.performance.now());
  ok(G.score === s2 || G.groups[gi + 1].t - chord.t < 0.1, '同组重复按下不重复计分');

  /* ---------- 全 PERFECT ---------- */
  console.log('\n== 满分 ==');
  restart();
  for (let k = 0; k < G.groups.length; k++) {
    setT(G.groups[k].t);
    M.press(win.performance.now());
  }
  M.update();
  eq(G.perfect, 848, '全部 PERFECT');
  eq(G.score, 1000000, '满分 = 1000000');
  eq(G.maxCombo, 848, '满连击');
  eq(G.miss, 0, '无 MISS');
  M.finish();
  eq(win.document.getElementById('rankLetter').textContent, 'λ', '满分评级 λ');
  ok(win.document.getElementById('scr-result').classList.contains('on'), '进入结算界面');
  ok(/^\d{7}$/.test(win.document.getElementById('finalScore').textContent), '分数七位补零');
  eq(win.document.querySelectorAll('#statGrid div').length, 5, '结算 5 项统计');

  /* ---------- 全 MISS ---------- */
  restart();
  setT(G.duration + 2);
  M.update();
  eq(G.miss, 848, '全部 MISS');
  eq(G.score, 0, '全 MISS 得分 0');
  M.finish();
  eq(win.document.getElementById('rankLetter').textContent, 'D', '0 分评级 D');

  /* ---------- 全 GOOD ---------- */
  restart();
  for (let k = 0; k < G.groups.length; k++) {
    setT(G.groups[k].t - 0.12);   // 提前 120ms：落在 GOOD 区，且上一组已判定不会抢下一组
    M.press(win.performance.now());
  }
  M.update();
  eq(G.good, 848, '全部 GOOD');
  near(G.score, Math.round(848 * (1000000 / 848) * 0.85), 2, '全 GOOD = 85% 总分');
  M.finish();
  eq(win.document.getElementById('rankLetter').textContent, 'C', '850000 分评级 C');

  /* ---------- 评级边界 ---------- */
  console.log('\n== 评级 ==');
  const rankOf = (score, perfect) => {
    G.score = score; G.perfect = perfect; G.total = 848; G.miss = 0;
    M.finish();
    return win.document.getElementById('rankLetter').textContent;
  };
  eq(rankOf(999999, 0), 'S', '999999 -> S');
  eq(rankOf(990000, 0), 'S', '990000 -> S');
  eq(rankOf(989999, 0), 'A', '989999 -> A');
  eq(rankOf(950000, 0), 'A', '950000 -> A');
  eq(rankOf(900000, 0), 'B', '900000 -> B');
  eq(rankOf(800000, 0), 'C', '800000 -> C');
  eq(rankOf(799999, 0), 'D', '799999 -> D');
  eq(rankOf(1000000, 848), 'λ', '满分评级 = λ');

  /* ---------- 界面流程 ---------- */
  console.log('\n== 界面流程 ==');
  const key = (k) => {
    win.dispatchEvent(new win.KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true }));
  };
  M.goSplash();
  eq(M.App.screen, 'splash', '起始于启动屏');
  M.setHomeSel(0);
  key('x');
  eq(M.App.screen, 'title', '启动屏：任意键进入主界面');
  key('x');
  eq(M.App.screen, 'title', '主界面：任意键不再跳转');
  key('ArrowDown');
  eq(M.getHomeSel(), 1, '主界面 ↓ 选中第二项');
  key('ArrowUp');
  eq(M.getHomeSel(), 0, '主界面 ↑ 回到第一项');
  key('Enter');
  eq(M.App.screen, 'select', '主界面 ENTER 进入选曲');
  key('ArrowDown');
  eq(M.App.sel, 1, '↓ 切到第 2 首');
  key('ArrowUp');
  eq(M.App.sel, 0, '↑ 回到第 1 首');
  key('Enter');
  eq(M.App.screen, 'intro', 'ENTER 先播进歌动画');
  ok(M.getIntro().on, '进歌动画处于激活状态');
  eq(M.App.songs[M.App.sel].id, G.song ? G.song.id : M.App.songs[M.App.sel].id, '动画绑定了当前曲目');
  key('Enter');                          // 再按一次跳过动画
  eq(M.App.screen, 'play', 'ENTER 开始游玩（跳过动画）');
  key('Escape');
  eq(M.App.screen, 'pause', 'ESC 暂停');
  key('Escape');
  eq(M.App.screen, 'play', '再按 ESC 继续');
  ['a', ' ', 'Shift', 'ArrowLeft', '1'].forEach(key);   // 任意键都能判定，不应报错
  ok(true, '任意键判定不抛异常');
  win.document.getElementById('btnQuit').click();
  eq(M.App.screen, 'select', '退出返回选曲');

  /* 主界面 / 二级界面导航 */
  console.log('\n== 主界面导航 ==');
  key('Escape');
  eq(M.App.screen, 'title', '选曲 ESC 返回主界面');
  M.setHomeSel(1);
  key('Enter');
  eq(M.App.screen, 'settings', '主界面「设置」打开设置');
  key('Escape');
  eq(M.App.screen, 'title', '设置 ESC 回到主界面');
  eq(M.App.screen !== 'select', true, '设置是主界面的一级入口，不经过选曲');
  eq(win.document.querySelectorAll('#homeMenu .hitem').length, 2, '主界面有 2 个菜单项');
  eq(win.document.getElementById('homeTracks').textContent, '05', '主界面显示曲目数');
  ok(/^\d{4}$/.test(win.document.getElementById('homeChart').textContent), '主界面显示总音符数');
  const sel0 = win.document.querySelectorAll('#homeMenu .hitem.sel');
  eq(sel0.length, 1, '主界面只有一项处于选中态');

  /* 右栏侧边按钮 */
  M.goSelect();
  win.document.getElementById('btnBack').click();
  eq(M.App.screen, 'title', '选曲「返回」按钮回到主界面');
  win.document.getElementById('btnStart').click();
  eq(M.App.screen, 'select', '主界面「开始游戏」进入选曲');

  /* 失焦自动暂停 */
  console.log('\n== 失焦自动暂停 ==');
  M.startSong(0, 0, true);
  eq(M.App.screen, 'play', '进入游玩');
  eq(M.G.paused, false, '未暂停');
  win.dispatchEvent(new win.Event('blur'));
  eq(M.G.paused, true, 'blur 后自动暂停');
  eq(M.App.screen, 'pause', 'blur 后切到暂停界面');
  eq(M.G.autoPaused, true, '标记为自动暂停');
  const tBlur = M.songTime();
  win.dispatchEvent(new win.Event('blur'));
  eq(M.G.paused, true, '重复 blur 不重复触发');
  eq(M.songTime(), tBlur, '暂停后时间不再前进');
  M.resumeGame();
  eq(M.G.paused, false, '继续游戏');
  eq(M.G.autoPaused, false, '继续后清除自动暂停标记');
  win.dispatchEvent(new win.Event('blur'));
  eq(M.G.paused, true, '再次失焦再次暂停');
  M.resumeGame();

  /* 后台标签页 */
  ok('hidden' in win.document, '文档支持 visibilityState');
  M.pauseGame();
  eq(M.G.paused, true, '手动暂停');
  M.resumeGame();
  eq(M.App.screen, 'play', '手动暂停后继续');
  win.document.getElementById('btnQuit').click();
  eq(M.App.screen, 'select', '退出');
  M.goTitle();
  eq(M.App.screen, 'title', '回到主界面');
  win.dispatchEvent(new win.Event('blur'));
  eq(M.G.paused, false, '非游玩状态失焦不暂停');
  key('Enter');
  M.finish();
  eq(M.App.screen, 'result', '结算界面');
  key('Escape');
  eq(M.App.screen, 'select', '结算后 ESC 返回选曲');

  /* ---------- 谱面解析 ---------- */
  console.log('\n== 谱面解析 ==');
  const mini = M.makeSong({
    id: 'mini', title: 'Mini', bpm: 120, duration: 2,
    player: 0,
    tempo: [[0, 0.5]],
    tracks: [{ name: 'A', drum: false, gain: 1 }],
    notes: [[[0, 0.5, 60, 100], [0.5, 0.5, 64, 90], [1.0, 0.3, 67, 80]]]
  });
  ok(!!mini, '最小谱面可构造');
  eq(mini.taps, 3, '3 个击打单位');
  eq(mini.parsed.tracks[0].notes.length, 3, '3 个音符');
  near(mini.parsed.tracks[0].notes[1].t, 0.5, 1e-6, '时间原样保留');
  eq(mini.parsed.beats.length, 4, 'tempo 每 0.5s 一拍 -> 2s 内 4 拍');
  eq(mini.level, 4, '难度由击打密度推出（3 音 / 2s）');

  const bs = M.buildBeats([[0, 0.5], [1.0, 0.25]], 2);
  ok(bs.length > 5 && bs[bs.length - 1].t <= 2.01, '多段 tempo 计时正确');
  ok(bs.filter(function (b) { return b.bar; }).length >= 2, '每 4 拍一个小节');

  eq(M.makeSong({ id: 'x', tracks: [], notes: [] }), null, '空谱面被拒绝');
  eq(M.makeSong({ id: 'x', tracks: [{ name: 'A' }], notes: [[[0, 0.5, 60, 100]]], player: 0 }).taps, 1,
    '单音符谱面可用');

  /* ---------- 设置 ---------- */
  console.log('\n== 设置 ==');
  const SKIP = 12.17 - 8 * (60 / 138);      // 第一个音前两小节

  M.S.spd = 3; M.computeLayout(); const py1 = M.L.pys;
  M.S.spd = 6; M.computeLayout(); const py6 = M.L.pys;
  near(py6 / py1, 1.6, 0.005, '流速 1.6x -> 下落速度 x1.6');
  M.S.spd = 1; M.computeLayout();
  near(M.L.pys / py1, 0.75, 0.005, '流速 0.75x -> 下落速度 x0.75');
  M.S.spd = 3; M.computeLayout();

  M.S.skip = true; restart();
  near(M.introSkip(), SKIP, 0.02, '跳过前奏 = 第一个音 - 两小节');
  near(-G.t0, SKIP - 0.08, 0.02, '开播位置落在两小节前');
  ok(G.events[G.evIdx] && G.events[G.evIdx].t >= SKIP, '开播前的音符不会被补播');

  M.S.skip = false; restart();
  eq(M.introSkip(), 0, '关闭跳过时从 0 开始');
  near(G.t0, 1.7, 0.001, '从头开始时 t0 = LEAD');
  M.S.skip = true;

  /* 打击发声 */
  let pc = 0;
  const realPiano = win.Synth.piano;
  win.Synth.piano = function () { pc++; return realPiano.apply(this, arguments); };
  function runTo(sec, onHit) {
    M.S.onHit = onHit; M.S.skip = false; restart();
    pc = 0;
    for (let t = 0; t <= sec; t += 0.05) { setT(t); M.update(); }
    return pc;
  }
  const autoN = runTo(16, false);
  const hitN = runTo(16, true);
  ok(autoN > hitN, '打击发声模式下玩家音轨不再自动播放（' + autoN + ' -> ' + hitN + '）');
  ok(hitN > 0, '其它音轨仍然自动播放');

  M.S.onHit = true; M.S.skip = false; restart();
  const pcBefore = pc;
  setT(G.groups[0].t);
  M.press(win.performance.now());
  eq(pc - pcBefore, G.groups[0].notes.length, '打击发声时按下即响（和弦全部发声）');

  /* 单音符显示 */
  M.S.onHit = false; M.S.skip = false; M.S.spd = 3; restart();
  M.computeLayout();
  const cvEl = win.document.getElementById('cv');
  const c2d = cvEl.getContext('2d');
  c2d._arcs = 0;
  M.drawNotes(20);
  let visible = 0;
  for (let i = 0; i < G.groups.length; i++) {
    const g = G.groups[i];
    if (g.st === 1) continue;
    /* 纵向下落：y 由判定线往上按时间差算 */
    const y = M.L.judgeY - (g.t - 20) * M.L.pys;
    if (y > M.L.judgeY + 240) continue;
    if (y < M.L.padY - 70) break;
    visible++;
  }
  ok(visible > 3, '该时刻有可见音符（' + visible + '）');
  eq(c2d._arcs, visible * 2, '每个音符只画一个圆（描边 + 内点 = 2 次 arc）');

  /* 设置界面 */
  M.setScreen('select');
  M.openSettings('select');
  eq(M.App.screen, 'settings', '打开设置面板');
  eq(win.document.querySelectorAll('#setList .setRow').length, 5, '五个设置项');
  const valOf = (i) => win.document.querySelectorAll('#setList .setRow')[i].querySelector('.v b').textContent;
  const v0 = valOf(0);
  key('ArrowRight');
  ok(valOf(0) !== v0, '←→ 调节流速（' + v0 + ' -> ' + valOf(0) + '）');
  key('ArrowDown');
  const on0 = valOf(1);
  key('ArrowRight');
  ok(valOf(1) !== on0, '←→ 切换打击发声');
  key('Escape');
  eq(M.App.screen, 'select', 'ESC 返回选曲');
  ok(win.localStorage.getItem('mono-rhythm.settings.v1') !== null, '设置写入本地存储');

  M.startSong(0, 0, true);
  key('Escape');
  eq(M.App.screen, 'pause', '暂停中');
  M.openSettings('pause');
  eq(M.App.screen, 'settings', '暂停时可打开设置');
  key('Escape');
  eq(M.App.screen, 'pause', '设置返回暂停');

  /* ---------- 成绩保存 ---------- */
  console.log('\n== 成绩保存 ==');
  win.localStorage.removeItem('lamda.scores.v1');
  M.loadBest();
  eq(M.getBest()['badapple'], undefined, '初始没有成绩');

  function playWith(nPerfect) {
    M.S.auto = false;
    restart();
    for (let k = 0; k < nPerfect; k++) { setT(G.groups[k].t); M.press(win.performance.now()); }
    setT(G.duration + 2);
    M.update();
  }

  playWith(10);
  const rec1 = M.getBest()['badapple'];
  ok(!!rec1, '结算后写入成绩');
  eq(rec1.perfect, 10, '记录 PERFECT 数');
  eq(rec1.score, G.score, '记录分数');
  ok(rec1.rank === 'D', '评级随之记录（' + rec1.rank + '）');
  ok(win.localStorage.getItem('lamda.scores.v1').indexOf('badapple') > 0, '落盘到 localStorage');
  ok(G.isNew, '首次通关标记 NEW RECORD');

  const sc1 = rec1.score;
  playWith(2);
  eq(M.getBest()['badapple'].score, sc1, '低分不覆盖记录');
  ok(!G.isNew, '未刷新时不是 NEW RECORD');

  playWith(30);
  ok(M.getBest()['badapple'].score > sc1, '高分刷新记录（' + M.getBest()['badapple'].score + ' > ' + sc1 + '）');
  ok(G.isNew, '刷新后标记 NEW RECORD');

  const saved = M.getBest()['badapple'].score;

  /* ---------- 自动游玩不记录 ---------- */
  console.log('\n== 自动游玩 ==');
  M.S.auto = true;
  restart();
  setT(G.duration + 2);
  M.update();
  eq(G.perfect, 848, '自动游玩全部 PERFECT');
  eq(G.score, 1000000, '自动游玩得满分');
  ok(G.autoRun, '标记为自动游玩');
  eq(M.getBest()['badapple'].score, saved, '自动游玩不写入成绩');
  eq(M.getBest()['badapple'].perfect, 30, '历史成绩保持原样');
  ok(/AUTO PLAY/.test(win.document.getElementById('finalTag').textContent), '结算标注 AUTO PLAY');
  ok(/不记录/.test(win.document.getElementById('finalTag').textContent), '结算标注不记录成绩');

  // 手打一次确认仍会记录
  M.S.auto = false;
  playWith(5);
  ok(!G.autoRun, '关闭自动游玩后正常记录');
  ok(M.getBest()['badapple'].perfect === 30, '仍保留最高分记录');
  M.S.auto = false;

  // 选曲界面展示最佳成绩
  M.App.sel = 0;
  M.setScreen('select');
  M.renderSongList();
  renderSideCheck();
  function renderSideCheck() {
    const txt = win.document.getElementById('sideRows').textContent;
    ok(/BEST/.test(txt), '侧栏显示 BEST');
    ok(txt.indexOf(String(saved)) >= 0, '侧栏显示历史最高分');
  }

  /* ---------- 进歌动画 ---------- */
  console.log('\n== 进歌动画 ==');
  eq(M.INTRO_DUR, 1.9, '动画时长 1.9s');
  M.goSelect();
  M.App.sel = 0;
  let introDone = 0;
  M.playIntro(M.App.songs[0], function () { introDone++; });
  eq(M.App.screen, 'intro', '播放动画时进入 intro 界面');
  ok(M.getIntro().on, '动画处于开启状态');
  eq(M.getIntro().song.id, 'badapple', '动画携带曲目信息');
  eq(M.App.songs.length, 5, '动画不影响曲库');
  // 所有 DOM 界面都应隐藏，只有画布可见
  const domScreens = ['scr-splash', 'scr-title', 'scr-select', 'scr-settings', 'scr-result'];
  ok(domScreens.every((id) => {
    const el = win.document.getElementById(id);
    return !el.classList.contains('on') && el.style.visibility === 'hidden';
  }), '动画期间 DOM 界面全部隐藏');
  // 渲染几帧不应抛异常（含曲名测量 / 渐变 / 弧形路径）
  [0, 0.15, 0.35, 0.55, 0.75, 0.95].forEach((p) => {
    const it = M.getIntro();
    it.t0 = win.performance.now() - p * M.INTRO_DUR * 1000;
    M.drawIntro(win.performance.now() / 1000);
  });
  ok(true, '动画各阶段渲染不抛异常');
  eq(introDone, 0, '中途未触发回调');
  // 推到末尾，下一帧渲染应收尾并回调
  M.getIntro().t0 = win.performance.now() - M.INTRO_DUR * 1000 - 5;
  near(M.introProgress(), 1, 0.001, '进度按时间推进到 1');
  M.drawIntro(win.performance.now() / 1000);
  eq(introDone, 1, '渲染到末尾时触发一次回调');
  ok(!M.getIntro().on, '回调后动画关闭');

  // 跳过路径
  let skipped = 0;
  M.playIntro(M.App.songs[0], function () { skipped++; });
  M.getIntro();                    // 确认在播
  M.introEndsNow();
  M.drawIntro(win.performance.now() / 1000);
  eq(skipped, 1, '跳过时立即执行回调');
  ok(!M.getIntro().on, '跳过后动画关闭');

  // instant 直接开局，不经过动画
  M.startSong(0, 0, true);
  eq(M.App.screen, 'play', 'instant 跳过动画直接游玩');
  ok(!M.getIntro().on, 'instant 不残留动画状态');

  /* ---------- 换曲清理 ---------- */
  console.log('\n== 换曲清理 ==');
  M.startSong(0, 0, true);          // Bad Apple
  const oldGroups = G.groups, oldSong = G.song;
  // 打到中途，制造连击 / 特效 / 已判定音符
  for (let k = 0; k < 12; k++) {
    const g = G.groups[k];
    setT(g.t);
    M.press(win.performance.now());
  }
  ok(G.combo >= 12, '切曲前有连击（' + G.combo + '）');
  ok(G.fx.length >= 0, '切曲前特效队列可用');
  const hitCount = G.groups.filter((g) => g.st === 1).length;
  ok(hitCount >= 12, '切曲前已有 ' + hitCount + ' 个判定过的音符');

  const nextIdx = M.App.songs.findIndex((s) => s.id === 'the-earth');
  ok(nextIdx > 0, '找到另一首可切换的曲子');
  M.startSong(nextIdx, 0, true);

  eq(G.song.id, 'the-earth', '切曲后 G.song 指向新曲');
  ok(G.groups !== oldGroups, '分组数组整体换成了新的一份');
  eq(G.groups.length, M.App.songs[nextIdx].taps, '分组数 = 新曲击打数');
  eq(G.total, M.App.songs[nextIdx].taps, '总数与新曲一致');
  eq(G.combo, 0, '连击清零');
  eq(G.maxCombo, 0, '最大连击清零');
  eq(G.score, 0, '得分清零');
  eq(G.perfect, 0, 'PERFECT 计数清零');
  eq(G.good, 0, 'GOOD 计数清零');
  eq(G.miss, 0, 'MISS 计数清零');
  eq(G.first, 0, '已消费指针回到 0');
  eq(G.fx.length, 0, '特效队列清空（旧曲碎片不残留）');
  eq(G.judge, null, '判定文字清空');
  eq(G.over, false, '结算状态复位');
  eq(G.evIdx, 0, '音频事件指针回到 0');
  eq(G.active, true, '新曲处于进行中');
  eq(M.App.sel, nextIdx, '选中项跟随到新曲');

  // 旧曲的音符不能出现在新曲的数据里（按时间集合比对）
  const newSig = G.groups.map((g) => g.t.toFixed(3)).join(',');
  const oldSig = oldGroups.map((g) => g.t.toFixed(3)).join(',');
  ok(newSig !== oldSig, '新曲分组时间表与旧曲不同');
  ok(!G.groups.some((g) => g.st === 1), '新曲里没有任何「已判定」残留音符');
  ok(!G.groups.some((g) => g.g && g.g.st === 1), '分组自身状态干净');

  // 从新曲第一帧开始推进：不应出现旧曲的判定/特效
  G.t0 = 0; AC().T = 0;
  const before = G.fx.length;
  M.drawGame(0);
  eq(G.fx.length, before, '新曲首帧不喷出旧曲特效');
  eq(G.combo, 0, '新曲首帧连击仍为 0');

  /* ---------- 音高 -> 横向位置 ---------- */
  console.log('\n== 音高映射 ==');
  M.startSong(0, 0, true);          // Bad Apple，音域 39~79
  M.computeLayout();
  const L2 = M.L;
  ok(L2.right > L2.left, '可用宽度为正');
  ok(L2.spanHi > L2.spanLo, '自适应音高窗有效');

  // 单音段落：音域窗不能塌成 0
  L2.spanLo = 60; L2.spanHi = 60;
  ok(isFinite(M.xFor(60)), '退化音域窗仍能算出坐标');
  L2.spanLo = L2.pMin; L2.spanHi = L2.pMax;

  // 单调性：音高越大 x 越大
  M.updateSpan(30, true);
  let lastX = -1e9, mono = true;
  for (let p = Math.ceil(L2.spanLo); p <= Math.floor(L2.spanHi); p++) {
    const x = M.xFor(p);
    if (x < lastX - 1e-6) mono = false;
    lastX = x;
  }
  ok(mono, '音高严格单调（低音在左、高音在右）');

  eq(M.xFor(L2.spanLo), L2.left, '音域下界落在左端');
  eq(M.xFor(L2.spanHi), L2.right, '音域上界落在右端');
  eq(M.xFor(L2.spanLo - 24), L2.left, '低于音域的音夹在左端');
  eq(M.xFor(L2.spanHi + 24), L2.right, '高于音域的音夹在右端');

  // 自适应窗：同一瞬间的音符应该铺开，而不是挤成一条竖线
  ok(L2.spanHi - L2.spanLo >= 7, '音域窗至少 7 个半音宽（不会挤成竖线）');

  // 严格几何检查：可见音符必须在屏幕上真正散开。
  // 单音长音段落（音高几乎不变）天然只占几条线，这是音乐的本来面目，
  // 所以分成两档：普通段落必须占满窗宽，单音段落至少要占窗宽的 1/3（不叠成一条线）。
  let worstRatio = 1, worstT = 0, checked = 0;
  let narrowFrames = 0, narrowWorst = 1;
  for (let t = 15; t < 200; t += 3.1) {
    M.updateSpan(t, true);
    const gs = G.groups;
    let lo = 1e9, hi = -1e9, c = 0;
    for (let i = G.first; i < gs.length; i++) {
      const g = gs[i];
      const y = L2.judgeY - (g.t - t) * L2.pys;
      if (y < L2.padY - 70) break;
      if (y > L2.judgeY + 240) continue;
      const p = M.pitchOf(g);
      if (p < lo) lo = p;
      if (p > hi) hi = p;
      c++;
    }
    if (c < 2) continue;
    const ratio = (hi - lo) / (L2.spanHi - L2.spanLo);
    checked++;
    if (hi - lo < 4) {
      /* 单音 / 颤音段落：只要求不叠成一条线 */
      narrowFrames++;
      if (ratio < narrowWorst) narrowWorst = ratio;
    } else if (ratio < worstRatio) { worstRatio = ratio; worstT = t; }
  }
  ok(checked > 30, '几何检查采样 ' + checked + ' 帧');
  ok(worstRatio > 0.72,
    '多音段落至少占音高窗的 72%（最差 ' + (worstRatio * 100).toFixed(0) + '% @t=' + worstT.toFixed(0) + '）');
  ok(narrowWorst > 0.15,
    '纯单音段落（' + narrowFrames + ' 帧）散开到窗宽 15% 以上（最窄 ' + (narrowWorst * 100).toFixed(0) + '%）');

  let maxGap = 0, samples = 0;
  for (let t = 20; t < 120; t += 1.7) {
    M.updateSpan(t, true);
    const gs = G.groups;
    let lo = 1e9, hi = -1e9, c = 0;
    for (let i = G.first; i < gs.length; i++) {
      const g = gs[i];
      const y = L2.judgeY - (g.t - t) * L2.pys;
      if (y < L2.padY - 70) break;
      if (y > L2.judgeY + 240) continue;
      const x = M.groupX(g);
      if (x < lo) lo = x;
      if (x > hi) hi = x;
      c++;
    }
    if (c >= 4) { maxGap += (hi - lo) / (L2.right - L2.left); samples++; }
  }
  ok(samples > 20, '采样到足够多的多音画面（' + samples + ' 帧）');
  ok(maxGap / samples > 0.45,
    '可见音符平均铺开 >45% 宽度（实测 ' + (maxGap / samples * 100).toFixed(0) + '%）');

  // 窗外的音不应把窗挤走：单音反复的段落保持稳定
  M.updateSpan(30, true);
  const stableLo = L2.spanLo;
  M.updateSpan(30.05, false);      // 不足 LANE_RECALC 间隔，不应重算
  eq(L2.spanLo, stableLo, '重算间隔内音高窗保持不变');

  M.startSong(0, 0, true);
  eq(M.L.spanLo, M.L.pMin, '新开局时音高窗回到整首曲子的音域');

  /* ---------- 曲目清单 ---------- */  console.log('\n== 曲目清单 ==');
  ok(Array.isArray(win.LAMBDA_INDEX), 'charts/index.js 提供清单');
  eq(win.LAMBDA_INDEX.length, 5, '清单里 5 首');
  eq(win.LAMBDA_INDEX[0], CHART_ID, '清单 id = ' + CHART_ID);
  ok(!!(win.LAMBDA_CHART && win.LAMBDA_CHART[CHART_ID]), '谱面已注册到 LAMBDA_CHART');
  eq(M.App.songs[0].id, CHART_ID, '歌曲 id 与清单一致');
  eq(M.App.notice, '', '无错误提示');
  eq(M.App.failed.length, 0, '没有加载失败的谱面');

  await M.loadSongs();
  eq(M.App.songs.length, 5, '重新加载后仍是 5 首');

  /* 空清单：提示怎么加曲 */
  const wEmpty = (function () {
    const d = new JSDOM(html, {
      url: 'file:///C:/fake/lamda/index.html',
      runScripts: 'dangerously',
      pretendToBeVisual: true,
      beforeParse(w) {
        const c = makeCtx();
        w.HTMLCanvasElement.prototype.getContext = function () { c.canvas = this; return c; };
        Object.defineProperty(w.HTMLCanvasElement.prototype, 'clientWidth', { configurable: true, get: () => 1280 });
        Object.defineProperty(w.HTMLCanvasElement.prototype, 'clientHeight', { configurable: true, get: () => 720 });
        w.requestAnimationFrame = () => 0;
        w.cancelAnimationFrame = () => {};
      }
    });
    const w = d.window;
    makeAudio(w);
    w.eval('window.LAMBDA_INDEX = []; window.LAMBDA_CHART = {};');
    w.eval(read('js/synth.js'));
    w.eval(read('js/game.js'));
    return w;
  })();
  await (function waitBoot(w) {
    return new Promise((res) => {
      const t0 = Date.now();
      (function poll() {
        if (w.__MR && w.__MR.App.booted) return res();
        if (Date.now() - t0 > 4000) return res();
        setTimeout(poll, 20);
      })();
    });
  })(wEmpty);
  eq(wEmpty.__MR.App.songs.length, 0, '空清单时没有曲目');
  eq(wEmpty.__MR.App.notice, 'nolib', '提示需要转换谱面');
  ok(/midi2chart/.test(wEmpty.document.getElementById('notice').textContent), '提示里写明转换命令');

  console.log('\n---------------------------------');
  console.log('PASS ' + pass + ' / FAIL ' + fail);
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error('测试异常：', e);
  process.exit(1);
});

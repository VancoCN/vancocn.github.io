/* game.js — LAMDA
 * 单键节奏游戏：谱面的 player 轨 = 玩家音轨，其余音轨自动演奏。
 * 谱面由 tools/midi2chart.py 从 .mid 离线转换而来，运行时只加载 charts/*.js。
 */
(function () {
  'use strict';

  var $ = function (id) { return document.getElementById(id); };
  function clamp(v, a, b) { return v < a ? a : (v > b ? b : v); }
  function padn(n, w) { var s = '' + n; while (s.length < w) s = '0' + s; return s; }
  function fmtTime(s) { return padn(Math.floor(s / 60), 2) + ':' + padn(Math.floor(s % 60), 2); }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  var APPROACH = 2.05;      // 音符从出现到判定线的时间（纵向视野长度；只影响观感，不影响判定）
  var WIN_PERFECT = 0.100;  // ±100ms
  var WIN_GOOD = 0.150;     // ±150ms
  var LEAD = 1.7;           // 开场预备时间
  var LOOKAHEAD = 0.30;     // 音频提前调度窗口
  var CHORD_WIN = 0.028;    // 视为「同时按下」的时间窗
  var MONO = 'ui-monospace,"SF Mono",Menlo,Consolas,monospace';
  var SANS = '-apple-system,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif';

  /* ------------------------------------------------------------------ 画布 */
  var cv = $('cv'), ctx = cv.getContext('2d', { alpha: false });
  var W = 0, H = 0, DPR = 1;

  function resize() {
    var w = cv.clientWidth || window.innerWidth;
    var h = cv.clientHeight || window.innerHeight;
    var d = Math.min(window.devicePixelRatio || 1, 2);
    if (w === W && h === H && d === DPR) return;
    W = w; H = h; DPR = d;
    cv.width = Math.round(w * d);
    cv.height = Math.round(h * d);
    ctx.setTransform(d, 0, 0, d, 0, 0);
  }

  /* 侧落式：X 轴 = 时间（音符从右往左流），Y 轴 = 音高（低音在下、高音在上）。
     judgeX 是判定线所在的 X，pxs 是「每秒多少像素」的横向速度。
     音高 -> 纵坐标的映射是**静态**的（整首曲子只算一次），
     所以音符在屏幕上只会横向移动，绝不会上下漂移 —— 这是不闪动的前提。 */
  var L = {
    judgeX: 220, pxs: 500,
    top: 40, bottom: 680,        /* 音高映射的纵向范围 */
    pMin: 40, pMax: 80,          /* 音高范围（静态，buildChart 时算定） */
    padY: 40, padX: 40,
    laneGap: 34                  /* 分轨时相邻轨道的纵向间距 */
  };
  function computeLayout() {
    L.padY = Math.max(14, H * 0.022);
    L.padX = Math.max(18, W * 0.035);
    L.top = L.padY;
    L.bottom = H - L.padY;
    /* 判定线靠左，右侧整片留给下落区，左侧留出 HUD */
    L.judgeX = Math.round(W * 0.17);
    /* 横向速度：整段下落区在 APPROACH 秒内走完（流速越快，APPROACH 越短） */
    L.pxs = Math.max(120, (W - L.judgeX - L.padY) * speedFactor() / APPROACH);
    L.laneGap = clamp((L.bottom - L.top) * 0.055, 24, 44);
  }
  function pitchOf(g) {
    var s = 0;
    for (var i = 0; i < g.notes.length; i++) s += g.notes[i].pitch;
    return s / g.notes.length;
  }
  /* 音高 -> 纵坐标：高音在上（钢琴卷帘的常规朝向）。
     严格单调、且不随时间变化，所以同一时刻的音高关系永远稳定。 */
  function yFor(p) {
    var span = Math.max(1, L.pMax - L.pMin);
    var u = (p - L.pMin) / span;
    if (u < 0) u = 0; else if (u > 1) u = 1;
    return L.bottom - u * (L.bottom - L.top);
  }
  /* 分轨偏移：lane 0 保持原位，1 上移、2 下移。
     密集段的音高被压平到「该段平均音高」上，只在 3 条轨之间跳 ——
     这样轨道线是整齐的水平线，读谱一眼就能分出先后。 */
  var LANE_OFF = [0, -1, 1];
  function groupY(g) {
    if (g.laned) {
      var base = yFor(g.laneBase);
      return clamp(base + LANE_OFF[g.lane] * L.laneGap, L.top + 9, L.bottom - 9);
    }
    return yFor(pitchOf(g));
  }
  function groupDur(g) {
    var d = 0;
    for (var i = 0; i < g.notes.length; i++) if (g.notes[i].dur > d) d = g.notes[i].dur;
    return d;
  }

  /* ------------------------------------------------------------------ 存档 */
  var App = { screen: 'splash', songs: [], sel: 0, booted: false,
    loading: true, notice: '', failed: [] };
  var AUTO = false;   // 自动演奏（演示 / 调试用，?auto=1 开启）

  /* ------------------------------------------------------------------ 设置 */
  var SPEEDS = [0.6, 0.75, 0.9, 1.0, 1.15, 1.35, 1.6, 2.0];
  var SET_KEY = 'mono-rhythm.settings.v1';
  var S = { spd: 3, onHit: false, skip: true, auto: false, offset: 0 };  // offset: 判定偏移(ms)
  var setRow = 0, setFrom = 'select';

  function loadSettings() {
    try {
      var raw = JSON.parse(localStorage.getItem(SET_KEY) || 'null');
      if (raw && typeof raw === 'object') {
        if (typeof raw.spd === 'number') S.spd = clamp(raw.spd | 0, 0, SPEEDS.length - 1);
        if (typeof raw.onHit === 'boolean') S.onHit = raw.onHit;
        if (typeof raw.skip === 'boolean') S.skip = raw.skip;
        if (typeof raw.auto === 'boolean') S.auto = raw.auto;
        if (typeof raw.offset === 'number' && isFinite(raw.offset)) {
          S.offset = clamp(Math.round(raw.offset / 5) * 5, -150, 150);
        }
      }
    } catch (e) {}
  }
  function saveSettings() {
    try { localStorage.setItem(SET_KEY, JSON.stringify(S)); } catch (e) {}
  }
  function speedFactor() { return SPEEDS[S.spd] || 1; }

  /* ------------------------------------------------------------------ 最佳成绩 */
  var SCORE_KEY = 'lamda.scores.v1';
  var Best = {};

  function loadBest() {
    try {
      var raw = JSON.parse(localStorage.getItem(SCORE_KEY) || '{}');
      Best = (raw && typeof raw === 'object' && !Array.isArray(raw)) ? raw : {};
    } catch (e) { Best = {}; }
  }
  function saveBest() {
    try { localStorage.setItem(SCORE_KEY, JSON.stringify(Best)); } catch (e) {}
  }
  function bestOf(id) { return (id && Best[id]) || null; }

  function commitBest(id) {
    if (!id) return { rec: null, fresh: false };
    var judged = G.perfect + G.good + G.miss;
    var acc = judged ? (G.perfect + G.good * 0.85) / judged * 100 : 0;
    var rec = {
      score: G.score,
      rank: rankOf(G.score),
      perfect: G.perfect, good: G.good, miss: G.miss,
      maxCombo: G.maxCombo,
      acc: Math.round(acc * 100) / 100,
      ts: Date.now()
    };
    var old = Best[id];
    if (old && old.score >= rec.score) return { rec: old, fresh: false };
    Best[id] = rec;
    saveBest();
    return { rec: rec, fresh: true };
  }

  /* ------------------------------------------------------------------ 状态 */
  var G = {
    songIndex: 0, song: null, parsed: null, melodyTrack: 0,
    groups: [], events: [], evIdx: 0, beats: [],
    t0: 0, active: false, paused: false, over: false, duration: 0,
    total: 0, perNote: 0, first: 0,
    perfect: 0, good: 0, miss: 0, combo: 0, maxCombo: 0, score: 0,
    fx: [], judge: null, beatDur: 0.5
  };

  function songTime() {
    var c = Synth.ctx;
    if (!c) return 0;
    return c.currentTime - G.t0;
  }

  /* ------------------------------------------------------------------ 屏幕 */
  var SCREENS = { 'scr-splash': 1, 'scr-title': 1, 'scr-select': 1, 'scr-result': 1, 'scr-pause': 1, 'scr-settings': 1 };
  function setScreen(name) {
    App.screen = name;
    var map = { splash: 'scr-splash', title: 'scr-title', select: 'scr-select', result: 'scr-result', pause: 'scr-pause', settings: 'scr-settings' };
    Object.keys(SCREENS).forEach(function (id) {
      var el = $(id), on = (map[name] === id);
      el.classList.toggle('on', on);
      // 非当前界面立刻隐形（不依赖透明度过渡），避免淡出期间盖住游玩画面
      el.style.visibility = on ? 'visible' : 'hidden';
    });
  }

  /* 进歌动画期间所有 DOM 界面都隐藏，交给画布自己的 drawIntro 绘制 */
  function hideScreens() {
    App.screen = 'intro';
    Object.keys(SCREENS).forEach(function (id) {
      var el = $(id);
      el.classList.remove('on');
      el.style.visibility = 'hidden';
    });
  }

  var toastTimer = 0;
  function toast(msg, ms) {
    var el = $('toast');
    el.textContent = msg;
    el.classList.add('on');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { el.classList.remove('on'); }, ms || 2400);
  }

  /* ------------------------------------------------------------------ 曲库：扫描 midi/ 目录 */
  var CHART_DIR = 'charts/';

  function countGroups(track, win) {
    var c = 0, last = -1e9;
    for (var i = 0; i < track.notes.length; i++) {
      var t = track.notes[i].t;
      if (t - last > win) { c++; last = t; }
    }
    return c;
  }

  /* 由 [起点秒, 每拍秒] 段生成节拍线 */
  function buildBeats(tempo, duration) {
    var segs = (tempo && tempo.length) ? tempo : [[0, 0.5]];
    var beats = [], idx = 0;
    for (var i = 0; i < segs.length; i++) {
      var st = segs[i][0] || 0;
      var spb = segs[i][1] > 0 ? segs[i][1] : 0.5;
      var end = (i + 1 < segs.length) ? segs[i + 1][0] : Math.max(duration, st);
      for (var k = 0; ; k++) {
        var t = st + k * spb;
        if (t >= end - 1e-6) break;
        beats.push({ t: t, bar: (idx % 4) === 0 });
        idx++;
      }
    }
    return beats;
  }

  /* 谱面对象 -> 运行时歌曲 */
  function makeSong(c) {
    if (!c || !c.notes) return null;
    var tracks = [], dur = 0;
    (c.tracks || []).forEach(function (t, i) {
      var arr = c.notes[i] || [];
      var notes = [];
      for (var j = 0; j < arr.length; j++) {
        var n = arr[j];
        var d = Math.max(0.04, n[1]);
        notes.push({ t: n[0], dur: d, end: n[0] + d, pitch: n[2], vel: n[3] });
        if (n[0] + d > dur) dur = n[0] + d;
      }
      notes.sort(function (a, b) { return a.t - b.t; });
      tracks.push({
        name: t.name || ('track' + (i + 1)),
        isDrum: !!t.drum,
        gain: (typeof t.gain === 'number') ? t.gain : 0.6,
        notes: notes
      });
    });
    if (!tracks.length) return null;

    var ti = (typeof c.player === 'number' && tracks[c.player]) ? c.player : 0;
    var taps = countGroups(tracks[ti], CHORD_WIN);
    if (taps < 1) return null;

    var duration = c.duration > 0 ? c.duration : dur;
    var bpm = c.bpm > 0 ? c.bpm : 120;
    return {
      id: c.id || ('c' + Date.now().toString(36)),
      title: c.title || 'UNTITLED',
      artist: c.artist || '',
      orig: !!c.orig,
      cover: c.cover || '',
      bpm: bpm,
      duration: duration,
      level: c.level || clamp(Math.round(taps / Math.max(1, duration) * 2.5), 1, 15),
      taps: taps,
      melodyTrack: ti,
      parsed: {
        tracks: tracks,
        beats: buildBeats(c.tempo, duration),
        bpm: bpm,
        duration: duration
      }
    };
  }

  /* 动态注入谱面脚本（file:// 下也能用，不依赖 fetch） */
  function injectScript(src) {
    return new Promise(function (res) {
      var s = document.createElement('script');
      s.src = src;
      s.onload = function () { res(true); };
      s.onerror = function () { res(false); };
      document.head.appendChild(s);
    });
  }

  /* 把已注册到 LAMBDA_CHART 的谱面收进曲库；返回还需要注入脚本的 id 列表。 */
  function absorb(id) {
    var c = (window.LAMBDA_CHART || {})[id];
    if (!c) return false;
    try {
      var s = makeSong(c);
      if (s) { App.songs.push(s); return true; }
      App.failed.push(id + ' — 没有可用音符');
    } catch (e) {
      App.failed.push(id + ' — ' + (e && e.message || e));
    }
    return false;
  }

  function loadSongs() {
    /* 首次加载：清空后逐个注入谱面脚本。
       之后的重复调用（刷新清单 / 测试里再次加载）走「增量」路径：
       已经注册过的谱面直接就位，不清空已有曲库，避免界面闪空。 */
    var already = App.booted;
    App.loading = true;
    App.notice = '';
    App.failed = [];
    if (!already) App.songs = [];
    renderSongList();

    var ids = (window.LAMBDA_INDEX || []).slice();
    if (!ids.length) {
      App.loading = false;
      App.songs = [];
      App.notice = 'nolib';
      renderSongList();
      return Promise.resolve();
    }

    var loaded = {};
    for (var k = 0; k < App.songs.length; k++) loaded[App.songs[k].id] = 1;

    /* 已在内存里的谱面直接同步收下（jsdom 等无脚本注入的环境也能跑通） */
    var pending = [];
    ids.forEach(function (id) {
      if ((window.LAMBDA_CHART || {})[id]) {
        if (!loaded[id]) { if (absorb(id)) loaded[id] = 1; }
      } else {
        pending.push(id);
      }
    });

    function settle() {
      App.loading = false;
      if (App.songs.length) App.sel = clamp(App.sel, 0, App.songs.length - 1);
      else App.notice = 'nolib';
      renderSongList();
      if (App.failed.length) console.warn('[charts] 跳过：', App.failed);
    }

    if (!pending.length) { settle(); return Promise.resolve(); }

    var chain = Promise.resolve();
    pending.forEach(function (id) {
      chain = chain.then(function () {
        return injectScript(CHART_DIR + encodeURIComponent(id) + '.js').then(function (ok) {
          if (!ok) { App.failed.push(id + ' — 谱面文件缺失'); return; }
          if (!(window.LAMBDA_CHART || {})[id]) { App.failed.push(id + ' — 未注册'); return; }
          if (!loaded[id] && absorb(id)) loaded[id] = 1;
        });
      });
    });

    return chain.then(settle);
  }

  /* ------------------------------------------------------------------ 选曲界面 */
  var coverToken = 0;
  function renderCover(s) {
    var wrap = $('coverWrap'), img = $('coverImg');
    var token = ++coverToken;
    img.classList.remove('on');
    img.removeAttribute('src');
    wrap.classList.add('empty');
    if (!s) return;
    var list = [];
    if (s.cover) list.push('covers/' + s.cover);
    ['jpg', 'jpeg', 'png', 'webp'].forEach(function (e) { list.push('covers/' + s.id + '.' + e); });
    (function probe(i) {
      if (i >= list.length || token !== coverToken) return;
      var im = new Image();
      im.onload = function () {
        if (token !== coverToken) return;
        img.src = list[i];
        img.classList.add('on');
        wrap.classList.remove('empty');
      };
      im.onerror = function () { probe(i + 1); };
      im.src = list[i];
    })(0);
    /* 没有曲绘时不放占位符，直接用曲名做艺术字封面 */
    var art = $('coverArt');
    if (art) renderCoverArt(art, s);
  }

  /* 曲名艺术字：按最长单词自动缩放，堆叠排版，保持黑白几何风 */
  function renderCoverArt(el, s) {
    el.innerHTML = '';
    var words = String(s.title || '').toUpperCase().split(/\s+/).filter(Boolean);
    if (!words.length) return;
    var longest = words.reduce(function (a, b) { return b.length > a.length ? b : a; }, '');
    /* 单行可用宽 ~ 100cqw，字宽经验值 0.62em，留 12% 边距 */
    var size = Math.max(11, Math.min(64, 88 / Math.max(1, longest.length) * 1.6));
    var box = document.createElement('div');
    box.className = 'coverArtBox';
    words.forEach(function (w) {
      var d = document.createElement('i');
      d.textContent = w;
      d.style.fontSize = size + 'px';
      box.appendChild(d);
    });
    var tag = document.createElement('span');
    tag.className = 'coverArtTag';
    tag.textContent = s.orig ? 'ORIGINAL' : (s.artist || '');
    if (tag.textContent) box.appendChild(tag);
    el.appendChild(box);
  }

  function renderSide(s) {
    renderCover(s);
    if (!s) { $('sideLv').textContent = '--'; $('sideRows').innerHTML = ''; return; }
    $('sideLv').textContent = padn(s.level, 2);
    var b = bestOf(s.id);
    var rows = [
      ['NOTES', s.taps],
      ['BPM', s.bpm],
      ['LENGTH', fmtTime(s.duration)],
      ['BEST', b ? padn(b.score, 7) : '—'],
      ['RANK', b ? b.rank : '—']
    ];
    $('sideRows').innerHTML = rows.map(function (r) {
      return '<div><span>' + r[0] + '</span><b>' + r[1] + '</b></div>';
    }).join('');
  }

  function renderSongList() {
    var ul = $('songList');
    ul.innerHTML = '';
    var nt = $('notice');
    if (App.notice) {
      nt.hidden = false;
      nt.innerHTML = noticeHtml(App.notice);
    } else {
      nt.hidden = true;
      nt.innerHTML = '';
    }

    if (App.loading) {
      var l0 = document.createElement('li');
      l0.className = 'song empty';
      l0.innerHTML = '<div class="idx">--</div><div class="ttl"><b>扫描中…</b>' +
        '<span>SCANNING midi/</span></div><div class="st"></div>';
      ul.appendChild(l0);
      $('libInfo').textContent = 'SCANNING…';
      renderSide(null);
      return;
    }

    if (!App.songs.length) {
      var li = document.createElement('li');
      li.className = 'song';
      li.innerHTML = '<div class="idx">--</div><div class="ttl"><b>没有可选曲目</b>' +
        '<span>把 .mid 放进 midi/ 目录，然后点「重新扫描」</span></div><div class="st"></div>';
      ul.appendChild(li);
      $('libInfo').textContent = '0 TRACK';
      renderSide(null);
      return;
    }
    App.songs.forEach(function (s, i) {
      var li = document.createElement('li');
      li.className = 'song' + (i === App.sel ? ' sel' : '');
      li.innerHTML =
        '<div class="idx">' + padn(i + 1, 2) + '</div>' +
        '<div class="ttl"><b>' + esc(s.title) + '</b><span>' +
        (s.artist ? esc(s.artist) : '') +
        (s.artist ? '　' : '') + 'LV.' + padn(s.level, 2) +
        (bestOf(s.id) ? '　BEST ' + padn(bestOf(s.id).score, 7) : '') + '</span></div>' +
        '<div class="st"><span>BPM <em>' + s.bpm + '</em></span>' +
        '<span><em>' + s.taps + '</em> NOTES</span>' +
        '<span><em>' + fmtTime(s.duration) + '</em></span>' +
        (s.orig ? '<span class="orig">ORIGINAL</span>' : '') + '</div>';
      li.addEventListener('click', function () { App.sel = i; renderSongList(); });
      li.addEventListener('dblclick', function () { App.sel = i; startSong(i); });
      ul.appendChild(li);
    });
    $('libInfo').textContent = App.songs.length + ' CHART' + (App.songs.length > 1 ? 'S' : '');
    renderSide(App.songs[App.sel]);
    /* 空槽位，保持列表结构感 */
    for (var k = App.songs.length; k < 4; k++) {
      var ph = document.createElement('li');
      ph.className = 'song empty';
      ph.innerHTML = '<div class="idx">' + padn(k + 1, 2) + '</div>' +
        '<div class="ttl"><b>—</b><span>EMPTY SLOT</span></div><div class="st"></div>';
      ul.appendChild(ph);
    }
    var cur = ul.children[App.sel];
    if (cur && cur.scrollIntoView) cur.scrollIntoView({ block: 'nearest' });
  }

  function noticeHtml(kind) {
    if (kind === 'nolib') {
      return '<b>还没有谱面</b>' +
        '用 <code>python tools/midi2chart.py 歌曲.mid</code> 把 MIDI 转成谱面，' +
        '生成的 <code>charts/&lt;id&gt;.js</code> 放进 <code>charts/</code> 目录，' +
        '然后双击 <code>更新谱面.bat</code> 重建清单。<br>' +
        '曲绘放到 <code>covers/&lt;id&gt;.jpg</code>（同名即可），转换时会自动识别。';
    }
    if (kind === 'empty') {
      return '<b>谱面清单是空的</b>' + '请先转换谱面，再双击 <code>更新谱面.bat</code>。';
    }
    return '<b>曲库加载失败</b>' + esc(String(kind));
  }

  function moveSel(d) {
    if (!App.songs.length) return;
    App.sel = (App.sel + d + App.songs.length) % App.songs.length;
    renderSongList();
  }

  function reloadSongs() {
    if (G.active) return;
    // 谱面是按清单静态加载的，刷新页面最可靠
    location.reload();
  }

  function goSelect() {
    setScreen('select');
    renderSongList();
  }

  function goSplash() {
    setScreen('splash');
  }

  function goTitle() {
    setScreen('title');
    renderHome();
  }

  /* 启动屏 -> 主界面 */
  function enterHome() {
    if (App.screen !== 'splash') return false;
    Synth.init();
    Synth.resume();
    goTitle();
    return true;
  }

  /* ------------------------------------------------------------------ 主菜单 */
  var HOME_ITEMS = ['start', 'settings'];
  var homeSel = 0;

  function renderHome() {
    var items = document.querySelectorAll('#homeMenu .hitem');
    for (var i = 0; i < items.length; i++) {
      items[i].classList.toggle('sel', i === homeSel);
    }
    var tr = $('homeTracks'), ch = $('homeChart');
    if (tr) tr.textContent = App.songs.length ? padn(App.songs.length, 2) : '--';
    if (ch) ch.textContent = App.songs.length ? padn(App.songs.reduce(function (a, s) { return a + s.taps; }, 0), 4) : '--';
  }

  function homeActivate() {
    Synth.init();
    Synth.resume();
    if (HOME_ITEMS[homeSel] === 'settings') openSettings('title');
    else goSelect();
  }

  /* ------------------------------------------------------------------ 设置面板 */
  var SET_ROWS = 5;
  var SET_KEYS = [
    ['流速', 'SCROLL SPEED'],
    ['打击发声', 'AUDIO ON HIT'],
    ['跳过前奏', 'SKIP INTRO'],
    ['自动游玩', 'AUTO PLAY'],
    ['判定偏移', 'TIMING OFFSET']
  ];
  function settingValue(i) {
    if (i === 0) return speedFactor().toFixed(2) + 'x';
    if (i === 1) return S.onHit ? 'ON' : 'OFF';
    if (i === 2) return S.skip ? 'ON' : 'OFF';
    if (i === 3) return S.auto ? 'ON' : 'OFF';
    return (S.offset > 0 ? '+' : '') + S.offset + 'ms';
  }
  function renderSettings() {
    var ul = $('setList');
    var keys = SET_KEYS;
    ul.innerHTML = '';
    for (var i = 0; i < SET_ROWS; i++) {
      var li = document.createElement('li');
      li.className = 'setRow' + (i === setRow ? ' sel' : '');
      li.innerHTML =
        '<div class="k"><b>' + keys[i][0] + '</b><span>' + keys[i][1] + '</span></div>' +
        '<div class="v"><i class="dec">&lt;</i><b>' + settingValue(i) + '</b><i class="inc">&gt;</i></div>';
      (function (idx) {
        li.addEventListener('click', function (e) {
          setRow = idx;
          var t = e.target;
          if (t.classList && t.classList.contains('dec')) adjustSetting(idx, -1);
          else if (t.classList && t.classList.contains('inc')) adjustSetting(idx, 1);
          else renderSettings();
        });
      })(i);
      ul.appendChild(li);
    }
  }
  function adjustSetting(i, d) {
    if (i === 0) S.spd = (S.spd + d + SPEEDS.length) % SPEEDS.length;
    else if (i === 1) S.onHit = !S.onHit;
    else if (i === 2) S.skip = !S.skip;
    else if (i === 3) S.auto = !S.auto;
    else S.offset = clamp(S.offset + (d > 0 ? 5 : -5), -150, 150);
    saveSettings();
    computeLayout();
    renderSettings();
  }
  function openSettings(from) {
    setFrom = from || 'select';
    setRow = 0;
    renderSettings();
    setScreen('settings');
  }
  function closeSettings() {
    if (setFrom === 'pause') setScreen('pause');
    else if (setFrom === 'title') goTitle();
    else goSelect();
  }

  /* ------------------------------------------------------------------ 建谱 */
  function buildChart(song) {
    var data = song.parsed;
    var ti = song.melodyTrack;
    var src = data.tracks[ti].notes;

    var notes = [];
    for (var i = 0; i < src.length; i++) {
      var n = src[i];
      notes.push({ t: n.t, dur: Math.max(0.06, n.end - n.t), pitch: n.pitch, vel: n.vel, st: 0, g: null });
    }
    notes.sort(function (a, b) { return a.t - b.t; });

    var groups = [], cur = null;
    for (var i = 0; i < notes.length; i++) {
      var n = notes[i];
      if (!cur || n.t - cur.t > CHORD_WIN) {
        cur = { t: n.t, notes: [], st: 0 };
        groups.push(cur);
      }
      cur.notes.push(n);
      n.g = cur;
    }

    var lo = 127, hi = 0;
    for (var i = 0; i < notes.length; i++) {
      if (notes[i].pitch < lo) lo = notes[i].pitch;
      if (notes[i].pitch > hi) hi = notes[i].pitch;
    }
    if (hi < lo) { lo = 48; hi = 72; }
    if (hi - lo < 7) { var mid = (hi + lo) / 2; lo = mid - 3.5; hi = mid + 3.5; }
    L.pMin = lo - 0.5;
    L.pMax = hi + 0.5;

    /* ---- 密集段分轨 ----
       侧落式里 X 就是时间，所以音符一密，屏幕上横向就挤在一起；
       如果音高又接近，两个圈会几乎重合，完全读不出「先按哪个」。
       做法：找出「挤在一起」的连续音，把它们在纵向错开成 3 条轨道。
       判定条件用「时间间隔」+「音高差」两个维度，因为要靠得近才算挤：
         · 时间很近但音高差得远 -> 纵向本来分开了，不用分轨
         · 音高很近但时间隔得远 -> 横向本来分开了，也不用分轨
       段内用「该段平均音高」当轨道中心，把音高压平到 3 条轨上 ——
       密集段本来就读不清音高，压平换来整齐的轨道线更划算；
       段与段之间仍按各自的平均音高上下移动，大范围的旋律走向不会丢。 */
    var DENSE_T = 0.19;      /* 相邻音间隔小于此值 -> 时间上挤 */
    var DENSE_P = 3.0;       /* 相邻音音高差小于此值 -> 纵向会撞 */
    var LANE_N = 3;
    var laneCount = 0, laneSegs = 0;
    var i = 0;
    while (i < groups.length) {
      var j = i;
      while (j + 1 < groups.length) {
        var dt = groups[j + 1].t - groups[j].t;
        var dp = Math.abs(pitchOf(groups[j + 1]) - pitchOf(groups[j]));
        if (dt < DENSE_T && dp < DENSE_P) j++;
        else break;
      }
      /* 至少 3 个连续才算一段，否则错开反而更乱 */
      if (j - i >= 2) {
        var sumP = 0;
        for (var k = i; k <= j; k++) sumP += pitchOf(groups[k]);
        var baseP = sumP / (j - i + 1);
        for (var k = i; k <= j; k++) {
          groups[k].lane = ((k - i) % LANE_N);
          groups[k].laneBase = baseP;
          groups[k].laned = true;      /* 注意用独立标记：lane 0 是 falsy */
          laneCount++;
        }
        groups[i].laneFirst = true;      /* 段的起止，用于画轨道线 */
        groups[j].laneLast = true;
        laneSegs++;
      }
      i = j + 1;
    }
    G.laneCount = laneCount;
    G.laneSegs = laneSegs;

    /* 低音 / 鼓轨自动演奏；玩家音轨在「打击发声」模式下改为按键时发声 */
    var evs = [];
    data.tracks.forEach(function (t, idx) {
      if (!t.notes.length) return;
      var gain = (idx === ti) ? 1.0 : 0.6;
      for (var i = 0; i < t.notes.length; i++) {
        var n = t.notes[i];
        evs.push({
          t: n.t, p: n.pitch, d: Math.max(0.07, n.end - n.t),
          v: n.vel, drum: t.isDrum, g: gain, player: (idx === ti)
        });
      }
    });
    evs.sort(function (a, b) { return a.t - b.t; });

    G.song = song;
    G.parsed = data;
    G.melodyTrack = ti;
    G.playerDrum = !!data.tracks[ti].isDrum;
    G.groups = groups;
    G.events = evs;
    G.evIdx = 0;
    G.beats = data.beats;
    G.duration = data.duration;
    G.beatDur = 60 / (data.bpm || 120);
    G.total = groups.length;
    G.perNote = 1000000 / Math.max(1, G.total);
    G.perfect = 0; G.good = 0; G.miss = 0;
    G.combo = 0; G.maxCombo = 0; G.score = 0;
    G.first = 0; G.fx = []; G.judge = null;
    G.over = false; G.paused = false;
  }

  /* ------------------------------------------------------------------ 开始 / 结束 */
  /* 跳过开头空白：从玩家音轨第一个音的前两小节开始（4/4） */
  function introSkip() {
    if (!S.skip || !G.groups.length) return 0;
    var twoBars = G.beatDur * 8;
    return Math.max(0, G.groups[0].t - twoBars);
  }

  function startSong(i, skip, instant) {
    var s = App.songs[i];
    if (!s) return;

    /* 进歌动画：先播 ~1.9s，结束后再真正开始计时与发声。
       再次按键/点击可直接跳过；?instant=1 时完全跳过（测试与截图用）。 */
    if (!instant && !DEV.instant) {
      playIntro(s, function () { startSong(i, skip, true); });
      return;
    }

    Synth.init();
    Synth.resume();
    var c = Synth.ctx;
    if (!c) { toast('当前浏览器不支持 Web Audio'); return; }

    buildChart(s);
    G.songIndex = i;
    App.sel = i;
    G.active = true;
    G.paused = false;
    G.autoPaused = false;
    AUTO = !!(S.auto || DEV.auto === '1');
    G.t0 = c.currentTime + LEAD;

    var sk = 0;
    if (typeof skip === 'number' && skip > 0) sk = skip;
    else sk = introSkip();

    if (sk > 0.02) {
      G.t0 = c.currentTime + 0.08 - sk;
      while (G.evIdx < G.events.length && G.events[G.evIdx].t < sk) G.evIdx++;
      while (G.first < G.groups.length && G.groups[G.first].t + WIN_GOOD < sk) G.first++;
    }
    setScreen('play');
  }

  function finish() {
    G.active = false;
    if (G.perfect === G.total) G.score = 1000000;
    G.autoRun = !!AUTO;
    G.isNew = false;
    G.best = G.song ? bestOf(G.song.id) : null;
    if (!AUTO && G.song) {
      var r = commitBest(G.song.id);
      if (r.rec) G.best = r.rec;
      G.isNew = r.fresh && G.score > 0;
    }
    showResultScreen();
  }

  function rankOf(score) {
    if (G.perfect === G.total && G.total > 0) return 'λ';
    if (score >= 990000) return 'S';
    if (score >= 950000) return 'A';
    if (score >= 900000) return 'B';
    if (score >= 800000) return 'C';
    return 'D';
  }

  function showResultScreen() {
    var judged = G.perfect + G.good + G.miss;
    var acc = judged ? (G.perfect + G.good * 0.85) / judged * 100 : 0;
    var rank = rankOf(G.score);

    $('rankLetter').textContent = rank;
    $('rankLetter').classList.toggle('lam', rank === 'λ');
    $('resSong').textContent = G.song ? String(G.song.title) : '';
    $('finalScore').textContent = padn(0, 7);
    var tags = [];
    if (G.autoRun) tags.push('AUTO PLAY');
    else if (G.total > 0 && G.perfect === G.total) tags.push('ALL PERFECT');
    else if (G.miss === 0 && G.total > 0) tags.push('FULL COMBO');
    if (G.autoRun) tags.push('成绩不记录');
    else if (G.isNew) tags.push('NEW RECORD');
    $('finalTag').textContent = tags.join(' · ');

    var bb = G.best;
    $('resBest').textContent = bb ? ('BEST　' + padn(bb.score, 7) + '　' + bb.rank) : '';

    var items = [
      ['PERFECT', G.perfect], ['GOOD', G.good], ['MISS', G.miss],
      ['MAX COMBO', G.maxCombo], ['ACCURACY', acc.toFixed(2) + '%']
    ];
    $('statGrid').innerHTML = items.map(function (it) {
      return '<div><b>' + it[1] + '</b><span>' + it[0] + '</span></div>';
    }).join('');

    setScreen('result');

    var el = $('rankLetter');
    el.classList.remove('in');
    void el.offsetWidth;
    el.classList.add('in');

    var t0 = performance.now(), target = G.score;
    (function up() {
      var p = Math.min(1, (performance.now() - t0) / 950);
      var e = 1 - Math.pow(1 - p, 3);
      $('finalScore').textContent = padn(Math.round(target * e), 7);
      if (p < 1) requestAnimationFrame(up);
    })();
  }

  function pauseGame() {
    if (!G.active || G.paused) return;
    G.paused = true;
    Synth.suspend();
    setScreen('pause');
  }
  function resumeGame() {
    if (!G.paused) return;
    G.paused = false;
    G.autoPaused = false;
    Synth.resume();
    setScreen('play');
  }
  function quitGame() {
    G.active = false;
    G.paused = false;
    Synth.suspend();
    goSelect();
  }

  /* 失焦 / 切到后台时自动暂停：只认游玩中的状态，暂停后不会被重复触发 */
  function autoPause() {
    if (!G.active || G.paused || G.over) return false;
    if (App.screen !== 'play') return false;
    pauseGame();
    G.autoPaused = true;
    return true;
  }
  /* ------------------------------------------------------------------ 判定 */
  function addFx(o) {
    o.t0 = songTime();
    G.fx.push(o);
    if (G.fx.length > 300) G.fx.splice(0, 80);
  }

  function hitFx(g, kind) {
    var jx = L.judgeX;
    var strong = kind === 1;
    var y = groupY(g);
    addFx({ k: 'ring', x: jx, y: y, life: strong ? 0.5 : 0.26, r0: 8, r1: strong ? 78 : 44, w: strong ? 1.8 : 1 });
    if (strong) {
      addFx({ k: 'sq', x: jx, y: y, life: 0.45, s0: 16, s1: 58, rot: Math.PI / 4 });
      addFx({ k: 'ring', x: jx, y: y, life: 0.34, r0: 12, r1: 34, w: 2.4 });
    }
    var cnt = strong ? 7 : 2;
    for (var j = 0; j < cnt; j++) {
      /* 碎片朝右飞散：音符是从右边过来的，打碎后逆着来向溅开 */
      addFx({
        k: 'shard', x: jx, y: y, life: strong ? 0.42 : 0.24,
        a: (j / cnt - 0.5) * 1.8 + Math.random() * 0.3,
        sp: 120 + Math.random() * (strong ? 160 : 60),
        len: 7 + Math.random() * 11
      });
    }
    /* 水平光刃：从判定线向右拉出 */
    if (strong) addFx({ k: 'blade', x1: jx, x2: Math.max(70, W * 0.30), y: y, life: 0.28 });
  }

  function missFx(g) {
    addFx({ k: 'xm', x: L.judgeX, y: groupY(g), life: 0.5 });
  }

  function ghostFx() {
    addFx({ k: 'ring', x: L.judgeX, y: (L.top + L.bottom) / 2, life: 0.22, r0: 3, r1: 20, w: 1 });
  }

  function judgeHit(g, kind, err) {
    g.st = kind;
    for (var i = 0; i < g.notes.length; i++) g.notes[i].st = 1;
    G.combo++;
    if (G.combo > G.maxCombo) G.maxCombo = G.combo;
    if (kind === 1) G.perfect++; else G.good++;
    if (G.perfect === G.total) G.score = 1000000;
    else G.score = Math.round(G.perNote * (G.perfect + G.good * 0.85));
    G.judge = {
      txt: kind === 1 ? 'PERFECT' : 'GOOD',
      k: kind,
      err: (typeof err === 'number') ? err : 0,
      t0: songTime()
    };
    hitFx(g, kind);
    if (S.onHit) playGroupNow(g);          // 打击发声：和弦里的所有音一起响
    /* 声音也要区分：PERFECT 清脆高音，GOOD 闷一点、短一点 */
    Synth.tick(Synth.ctx.currentTime, kind === 1 ? 0.055 : 0.028);
  }

  function playGroupNow(g) {
    var c = Synth.ctx;
    if (!c) return;
    var when = c.currentTime;
    for (var i = 0; i < g.notes.length; i++) {
      var n = g.notes[i];
      if (G.playerDrum) {
        Synth.drum(when, n.pitch, n.vel);
      } else {
        Synth.piano(when, 440 * Math.pow(2, (n.pitch - 69) / 12), n.vel, Math.max(0.07, n.dur), 1.0);
      }
    }
  }

  function press(ts) {
    if (AUTO) return;
    if (!G.active || G.paused || G.over) return;
    var c = Synth.ctx;
    if (!c) return;
    if (c.state === 'suspended') Synth.resume();   // 某些浏览器首次需在按键回调里解锁

    /* 事件时间戳可能早于回调（事件排队 / 掉帧），用两者中更早的作为输入时刻，
       再把“输入时刻”换算到音频时钟，减去输出延迟与采样精度带来的固定偏差。
       偏差由玩家在设置里自行校准（OFFSET），不再猜测。 */
    var now = performance.now();
    var tEvt = (typeof ts === 'number' && isFinite(ts) && ts > 0) ? Math.min(ts, now) : now;
    var age = Math.max(0, (now - tEvt) / 1000);
    if (age > 0.25) age = 0.25;                    // 兜底：异常旧的事件按 250ms 计
    var st = c.currentTime - G.t0 - Synth.latency() - age - S.offset / 1000;

    /* 在判定窗内找“绝对值最小”的音符，而不是第一个够得着的 */
    var best = -1, bd = 1e9;
    for (var i = G.first; i < G.groups.length; i++) {
      var g = G.groups[i];
      /* 留 1ms 余量：窗口边界上的音符也要能被判到（浮点误差会让它被跳过） */
      if (g.t > st + WIN_GOOD + 0.001) break;
      if (g.st) continue;
      var d = Math.abs(g.t - st);
      if (d <= WIN_GOOD + 0.001 && d < bd) { bd = d; best = i; }
    }
    if (best >= 0) {
      judgeHit(G.groups[best], bd <= WIN_PERFECT ? 1 : 2, bd);
    } else {
      ghostFx();
      Synth.tick(c.currentTime, 0.022);
    }
  }

  /* ------------------------------------------------------------------ 主循环 */
  function update() {
    var st = songTime();
    var c = Synth.ctx;
    if (!c) return;

    var horizon = c.currentTime + LOOKAHEAD;
    while (G.evIdx < G.events.length && (G.t0 + G.events[G.evIdx].t) < horizon) {
      var e = G.events[G.evIdx++];
      if (S.onHit && e.player) continue;   // 玩家音轨改为击中时发声，不自动播放
      var when = G.t0 + e.t;
      if (when < c.currentTime) when = c.currentTime;
      if (e.drum) {
        Synth.drum(when, e.p, e.v);
      } else {
        Synth.piano(when, 440 * Math.pow(2, (e.p - 69) / 12), e.v, e.d, e.g);
      }
    }

    while (G.first < G.groups.length) {
      var g = G.groups[G.first];
      if (g.st) { G.first++; continue; }
      if (AUTO && g.t <= st) { judgeHit(g, 1); continue; }
      if (g.t + WIN_GOOD >= st) break;
      g.st = 3;
      for (var i = 0; i < g.notes.length; i++) g.notes[i].st = 3;
      G.miss++;
      G.combo = 0;
      missFx(g);
      G.first++;
    }

    if (!G.over && st > G.duration + 1.4) {
      G.over = true;
      finish();
    }
  }

  /* ------------------------------------------------------------------ 绘制 */
  function bg() {
    ctx.globalAlpha = 1;
    ctx.fillStyle = '#060606';
    ctx.fillRect(0, 0, W, H);
  }

  /* 主界面背景：网格 + 同心几何 + 扫描线 + 数据流 */
  function drawHomeBg(t) {
    var cx = W * 0.5, cy = H * 0.5;
    var R = Math.min(W, H) * 0.34;
    var A = 0.055;

    /* 点阵网格 */
    ctx.fillStyle = '#fff';
    ctx.globalAlpha = 0.03;
    var step = 44;
    for (var gx = (W % step) / 2; gx < W; gx += step) {
      for (var gy = (H % step) / 2; gy < H; gy += step) ctx.fillRect(gx, gy, 1, 1);
    }

    /* 外圈细网格（十字交叉） */
    ctx.globalAlpha = 0.045;
    ctx.strokeStyle = '#fff';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(cx, 0); ctx.lineTo(cx, H);
    ctx.moveTo(0, cy); ctx.lineTo(W, cy);
    ctx.stroke();

    /* 同心圆（呼吸） */
    ctx.globalAlpha = 0.04;
    for (var i = 1; i <= 3; i++) {
      ctx.beginPath();
      ctx.arc(cx, cy, R * (0.55 + i * 0.36), 0, 6.2832);
      ctx.stroke();
    }

    /* 旋转方框（双层反向） */
    ctx.save();
    ctx.translate(cx, cy);
    ctx.globalAlpha = A;
    ctx.strokeStyle = '#fff';
    ctx.lineWidth = 1.2;
    ctx.rotate(t * 0.06);
    var s = R * 1.16;
    ctx.strokeRect(-s, -s, s * 2, s * 2);
    ctx.rotate(-t * 0.06 * 2 + Math.PI / 4);
    ctx.globalAlpha = A * 0.62;
    s = R * 0.86;
    ctx.strokeRect(-s, -s, s * 2, s * 2);
    ctx.restore();

    /* 刻度环 */
    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate(-t * 0.03);
    ctx.globalAlpha = 0.16;
    ctx.strokeStyle = '#fff';
    ctx.lineWidth = 1;
    var rt = R * 1.44;
    for (var a = 0; a < 120; a++) {
      var ang = (a / 120) * Math.PI * 2;
      var long = (a % 10 === 0);
      var r1 = rt, r2 = rt + (long ? 12 : 5);
      ctx.beginPath();
      ctx.moveTo(Math.cos(ang) * r1, Math.sin(ang) * r1);
      ctx.lineTo(Math.cos(ang) * r2, Math.sin(ang) * r2);
      ctx.stroke();
    }
    ctx.restore();

    /* 扫描线（缓慢旋过整个画面） */
    var sa = t * 0.22;
    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate(sa);
    var grd = ctx.createLinearGradient(0, 0, R * 2.1, 0);
    grd.addColorStop(0, 'rgba(255,255,255,0)');
    grd.addColorStop(0.82, 'rgba(255,255,255,0.10)');
    grd.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.strokeStyle = grd;
    ctx.lineWidth = 1.4;
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.lineTo(R * 2.1, 0);
    ctx.stroke();
    ctx.restore();

    /* 四角直角标记 */
    var m = Math.max(18, Math.min(W, H) * 0.035), L2 = m * 1.5;
    ctx.globalAlpha = 0.2;
    ctx.strokeStyle = '#fff';
    ctx.lineWidth = 1;
    [[m, m, 1, 1], [W - m, m, -1, 1], [m, H - m, 1, -1], [W - m, H - m, -1, -1]]
      .forEach(function (c) {
        ctx.beginPath();
        ctx.moveTo(c[0], c[1] + c[3] * L2);
        ctx.lineTo(c[0], c[1]);
        ctx.lineTo(c[0] + c[2] * L2, c[1]);
        ctx.stroke();
      });

    /* 底部数据条 */
    ctx.globalAlpha = 0.12;
    ctx.fillStyle = '#fff';
    var bw = 2, gap = 5, total = Math.floor(W * 0.62 / (bw + gap));
    var bx0 = (W - total * (bw + gap)) / 2;
    for (var b = 0; b < total; b++) {
      var f = (Math.sin(t * 1.1 + b * 0.21) * 0.5 + 0.5);
      var hh = 2 + f * 9;
      ctx.fillRect(bx0 + b * (bw + gap), H - 26 - hh, bw, hh);
    }
    ctx.globalAlpha = 1;
  }

  function drawIdle(t) {
    bg();
    if (App.screen === 'title') { drawHomeBg(t); return; }
    ctx.globalAlpha = 0.035;
    ctx.fillStyle = '#fff';
    for (var x = 14; x < W; x += 60) {
      for (var y = 14; y < H; y += 60) ctx.fillRect(x, y, 1, 1);
    }
    var cx = W * 0.5, cy = H * 0.52, R = Math.min(W, H) * 0.3;
    ctx.strokeStyle = '#fff';
    ctx.lineWidth = 1;
    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate(t * 0.045);
    ctx.strokeRect(-R, -R, R * 2, R * 2);
    ctx.rotate(Math.PI / 4);
    ctx.globalAlpha = 0.022;
    ctx.strokeRect(-R * 0.72, -R * 0.72, R * 1.44, R * 1.44);
    ctx.restore();
    ctx.globalAlpha = 0.028;
    ctx.beginPath();
    ctx.arc(cx, cy, R * 1.28, 0, 6.2832);
    ctx.stroke();
    ctx.globalAlpha = 1;
  }

  /* ------------------------------------------------------------------ 进歌动画
   * 分两段，共 ~1.9s：
   *   ① 曲名从主页位置抽出、上浮淡出，同时画布铺满横向流动的扫描线
   *   ② 扫描线在底部汇聚成弧，拉起、压平、铺开 —— 变成判定线；
   *      节拍竖线从上落下，最后一点白光柱扫过，交棒给 startSong。
   */
  var INTRO_DUR = 1.90;
  var intro = { on: false, t0: 0, song: null, cb: null, seeded: false };

  function easeOutCubic(x) { return 1 - Math.pow(1 - x, 3); }
  function easeInOutCubic(x) {
    return x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2;
  }
  function seg(p, a, b) { return clamp((p - a) / Math.max(1e-6, b - a), 0, 1); }

  function playIntro(song, cb) {
    intro.on = true;
    intro.t0 = performance.now();
    intro.song = song || null;
    intro.cb = cb || null;
    intro.seeded = false;
    intro.hold = null;
    hideScreens();
  }

  function introProgress() {
    if (intro.hold !== null && intro.hold !== undefined && isFinite(intro.hold)) {
      return clamp(intro.hold, 0, 1);
    }
    return clamp(Math.max(0, performance.now() - intro.t0) / (INTRO_DUR * 1000), 0, 1);
  }

  function endIntro() {
    if (!intro.on) return;          // 防重入
    intro.on = false;
    var cb = intro.cb;
    intro.cb = null;
    if (cb) cb();
    /* 回调理应把屏幕切走（startSong -> play）。若没有（例如调试挂起），
       退回选曲，避免 loop 一直卡在 intro 上。 */
    if (App.screen === 'intro') goSelect();
  }

  function introEndsNow() {
    if (!intro.on) return;
    intro.t0 = performance.now() - INTRO_DUR * 1000 - 1;
    drawIntro(performance.now() / 1000);
  }

  /* 判定线在 p 时刻的横向位置（从画面中部滑到最终位置）
     终点必须落在 L.judgeX，这样交棒给游玩画面时镜头不跳。 */
  function introLineX(p) {
    var flat = L.judgeX;
    var u = easeOutCubic(seg(p, 0.34, 0.72));
    return flat + (1 - u) * W * 0.28;
  }

  function drawIntro(t) {
    var p = introProgress();
    if (p >= 1) { endIntro(); return; }

    bg();

    var song = intro.song;
    var title = song ? String(song.title || '').toUpperCase() : '';
    var cx = W * 0.5;

    /* 背景点阵，随进度淡入 */
    ctx.globalAlpha = 0.045 * seg(p, 0, 0.30);
    ctx.fillStyle = '#fff';
    for (var gx = 14; gx < W; gx += 60) {
      for (var gy = 14; gy < H; gy += 60) ctx.fillRect(gx, gy, 1, 1);
    }
    ctx.globalAlpha = 1;

    /* ① 曲名：从中间上浮，拉宽字距，淡出 */
    var tp = seg(p, 0.02, 0.40);
    if (title && tp < 1) {
      ctx.save();
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      /* 字号按标题长度自适应，长标题自动缩，短标题放大 */
      var fs = Math.round(clamp(W * 0.62 / Math.max(8, title.length), 16, W * 0.062));
      ctx.font = '300 ' + fs + 'px ' + SANS;
      if ('letterSpacing' in ctx) ctx.letterSpacing = (0.14 + tp * 0.26) * fs + 'px';
      ctx.globalAlpha = (1 - easeOutCubic(tp)) * 0.96;
      ctx.fillStyle = '#fff';
      ctx.fillText(title, cx, H * 0.46 - easeOutCubic(tp) * H * 0.10);
      if ('letterSpacing' in ctx) ctx.letterSpacing = '0px';

      /* 曲名下的一根细线，跟着字宽展开 */
      var lw = Math.min(W * 0.66, title.length * fs * 0.72) * easeOutCubic(tp);
      ctx.globalAlpha = (1 - easeOutCubic(tp)) * 0.42;
      ctx.strokeStyle = '#fff';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(cx - lw / 2, H * 0.46 + fs * 0.95);
      ctx.lineTo(cx + lw / 2, H * 0.46 + fs * 0.95);
      ctx.stroke();

      if (song) {
        var sub = (song.artist || '') + (song.level ? '   LV.' + padn(song.level, 2) : '');
        ctx.font = '400 11px ' + MONO;
        if ('letterSpacing' in ctx) ctx.letterSpacing = '4px';
        ctx.globalAlpha = (1 - easeOutCubic(tp)) * 0.52;
        ctx.fillText(sub.toUpperCase(), cx, H * 0.46 + fs * 1.5);
        if ('letterSpacing' in ctx) ctx.letterSpacing = '0px';
      }
      ctx.restore();
    }

    /* ② 竖向扫描线：先在整屏铺开，再被收拢到判定线那一列上 */
    var scan = seg(p, 0.06, 0.46);
    var merge = easeInOutCubic(seg(p, 0.38, 0.56));
    var lineX = introLineX(p);
    var lineW = easeInOutCubic(seg(p, 0.44, 0.72));
    var cy = H * 0.5;

    if (scan > 0) {
      var cols = 26;
      ctx.lineWidth = 1;
      for (var i = 0; i < cols; i++) {
        var f = i / (cols - 1);
        var base = W * (0.12 + f * 0.76);
        var x = base + (lineX - base) * merge;
        /* 每列自带一点相位漂移，形成风过的感觉 */
        var phase = ((t * 0.55 + i * 0.13) % 1);
        var half = (H * 0.5) * (0.28 + easeOutCubic(scan) * 0.98) * (1 - merge * 0.86);
        var a = (0.16 + 0.10 * Math.sin(i * 1.7)) * scan * (1 - merge * 0.45);
        ctx.strokeStyle = 'rgba(255,255,255,' + a.toFixed(3) + ')';
        ctx.beginPath();
        ctx.moveTo(x, cy - half);
        ctx.lineTo(x, cy + half);
        ctx.stroke();

        /* 线上滑过的亮点 */
        if (p < 0.52) {
          var py = cy - half + phase * half * 2;
          ctx.globalAlpha = Math.min(1, a * 6);
          ctx.fillStyle = '#fff';
          ctx.fillRect(x - 0.5, py, 1.4, 26);
          ctx.globalAlpha = 1;
        }
      }
    }

    /* 判定线本体：弧形 -> 拉直 -> 向上下铺开（改成了竖线） */
    if (lineW > 0) {
      var y0 = cy - (H * 0.5) * lineW;
      var y1 = cy + (H * 0.5) * lineW;
      var bow = (1 - easeInOutCubic(seg(p, 0.52, 0.80))) * W * 0.055;
      var bright = seg(p, 0.48, 0.62);

      ctx.strokeStyle = 'rgba(255,255,255,' + (0.34 + bright * 0.5).toFixed(3) + ')';
      ctx.lineWidth = 1 + bright * 0.6;
      ctx.beginPath();
      var steps = 48;
      for (var k = 0; k <= steps; k++) {
        var u = k / steps;
        var yy = y0 + (y1 - y0) * u;
        var xx = lineX - Math.sin(u * Math.PI) * bow;
        if (k === 0) ctx.moveTo(xx, yy); else ctx.lineTo(xx, yy);
      }
      ctx.stroke();

      /* 判定点：落在判定线中点，与游玩时的视觉重心一致 */
      var jp = seg(p, 0.56, 0.84);
      if (jp > 0) {
        ctx.globalAlpha = jp * (1 - jp) * 1.6;
        ctx.strokeStyle = '#fff';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.arc(lineX, cy, 8 + (1 - jp) * 58, 0, 6.2832);
        ctx.stroke();
        ctx.globalAlpha = jp;
        ctx.beginPath();
        ctx.arc(lineX, cy, 4.5, 0, 6.2832);
        ctx.stroke();
        ctx.fillStyle = '#fff';
        ctx.fillRect(lineX - 11, cy - 0.5, 22, 1);
        ctx.globalAlpha = 1;
      }

      /* 音符：各自从右侧横向落到判定线上（与游玩时的来向完全一致） */
      var np = seg(p, 0.46, 0.90);
      if (np > 0) {
        /* 落点铺满游玩时的纵向可用范围（L.top~L.bottom），交棒时不会跳 */
        for (var n = 0; n < 9; n++) {
          var u3 = (n + 0.5) / 9;
          var prog = clamp(np * 1.6 - n * 0.062, 0, 1);
          if (prog <= 0) continue;
          var nx = W * 0.92 + (lineX - W * 0.92) * (1 - Math.pow(1 - prog, 1.8));
          var ny = L.top + (L.bottom - L.top) * u3;
          var na = (1 - seg(prog, 0.92, 1)) * 0.85;
          if (na <= 0) continue;
          /* 横向拖尾 + 端点圆点，提前预告游玩时的音符形态 */
          ctx.globalAlpha = na * 0.3;
          ctx.fillStyle = '#fff';
          ctx.fillRect(nx + 2, ny - 0.5, 24, 1);
          ctx.globalAlpha = na;
          ctx.beginPath();
          ctx.arc(nx, ny, 3, 0, 6.2832);
          ctx.fill();
          ctx.globalAlpha = 1;
        }
      }

      /* 节拍横线：音符收拢后，从判定线向右依次伸出，把画面撑满 */
      var bp = seg(p, 0.74, 0.99);
      if (bp > 0) {
        var rows = 16;
        for (var c = 0; c < rows; c++) {
          var u2 = (c + 0.5) / rows;
          var by = H * u2;
          var grow = easeOutCubic(clamp(bp * 1.8 - c * 0.038, 0, 1));
          var barA = (c % 4 === 0 ? 0.22 : 0.10);
          ctx.strokeStyle = 'rgba(255,255,255,' + barA.toFixed(3) + ')';
          ctx.lineWidth = 1;
          ctx.beginPath();
          ctx.moveTo(lineX, by);
          ctx.lineTo(lineX + (W - lineX) * grow, by);
          ctx.stroke();
        }
      }
    }

    /* 收尾：一道横向光带扫过，作为进入游玩的信号 */
    var flash = seg(p, 0.86, 1.0);
    if (flash > 0) {
      var fy = cy + (flash - 0.5) * H * 1.4;
      var g2 = ctx.createLinearGradient(0, fy - 90, 0, fy + 90);
      g2.addColorStop(0, 'rgba(255,255,255,0)');
      g2.addColorStop(0.5, 'rgba(255,255,255,' + (Math.sin(flash * Math.PI) * 0.16).toFixed(3) + ')');
      g2.addColorStop(1, 'rgba(255,255,255,0)');
      ctx.fillStyle = g2;
      ctx.fillRect(0, fy - 90, W, 180);
      /* 收尾时整体压暗，避免最后一帧跳变 */
      ctx.globalAlpha = seg(p, 0.92, 1.0) * 0.55;
      ctx.fillStyle = '#060606';
      ctx.fillRect(0, 0, W, H);
      ctx.globalAlpha = 1;
    }
  }

  function drawField(st) {
    /* 点阵底纹（只铺下落区，判定线左边留给 HUD） */
    ctx.globalAlpha = 0.045;
    ctx.fillStyle = '#fff';
    for (var x = L.judgeX + 12; x < W; x += 46) {
      for (var y = L.padY; y < H - L.padY; y += 46) ctx.fillRect(x, y, 1, 1);
    }
    ctx.globalAlpha = 1;

    /* 音高标准线：水平虚线，高音在上。
       只在八度（C）位置画，并且用虚线 —— 实心长横线会被误认成 hold 的尾迹。 */
    ctx.lineWidth = 1;
    ctx.strokeStyle = 'rgba(255,255,255,0.045)';
    if (ctx.setLineDash) ctx.setLineDash([3, 7]);
    for (var p = Math.ceil(L.pMin / 12) * 12; p < L.pMax; p += 12) {
      var hy = yFor(p);
      if (hy < L.top - 1 || hy > L.bottom + 1) continue;
      ctx.beginPath();
      ctx.moveTo(L.judgeX, hy);
      ctx.lineTo(W, hy);
      ctx.stroke();
    }
    if (ctx.setLineDash) ctx.setLineDash([]);

    /* 节拍线：竖直，从右往左流过下落区 */
    var beats = G.beats;
    for (var i = 0; i < beats.length; i++) {
      var b = beats[i];
      var bx = L.judgeX + (b.t - st) * L.pxs;
      if (bx < L.judgeX - 2) continue;
      if (bx > W + 40) break;
      ctx.strokeStyle = b.bar ? 'rgba(255,255,255,0.16)' : 'rgba(255,255,255,0.065)';
      ctx.lineWidth = b.bar ? 1.4 : 1;
      ctx.beginPath();
      ctx.moveTo(bx, L.top - 18);
      ctx.lineTo(bx, L.bottom + 18);
      ctx.stroke();
    }
  }

  function drawNotes(st) {
    var gs = G.groups;
    ctx.lineCap = 'butt';
    var xEnd = W + 60;

    /* 先画分轨段的轨道引导线（在音符下层）。
       只在「这一段音符正停在屏幕上」的时候才出现，不会一直杵在那里。 */
    for (var q = G.first; q < gs.length; q++) {
      var g0 = gs[q];
      if (!g0.laneFirst) continue;
      var qe = q;
      while (qe < gs.length - 1 && !gs[qe].laneLast) qe++;
      var xa = L.judgeX + (gs[q].t - st) * L.pxs;
      var xb = L.judgeX + (gs[qe].t - st) * L.pxs;
      if (xb >= L.judgeX - 30 && xa <= W + 30) {
        var baseY0 = yFor(g0.laneBase != null ? g0.laneBase : pitchOf(g0));
        var cx0 = Math.max(L.judgeX - 6, xa);
        var cx1 = Math.min(W, xb);
        if (cx1 > cx0) {
          for (var l = 0; l < LANE_OFF.length; l++) {
            var ly = clamp(baseY0 + LANE_OFF[l] * L.laneGap, L.top + 9, L.bottom - 9);
            ctx.strokeStyle = 'rgba(255,255,255,' + (l === 0 ? 0.17 : 0.13) + ')';
            ctx.lineWidth = 1;
            ctx.beginPath();
            ctx.moveTo(cx0, ly);
            ctx.lineTo(cx1, ly);
            ctx.stroke();
          }
        }
      }
      q = qe;
    }

    for (var i = G.first; i < gs.length; i++) {
      var g = gs[i];
      if (g.st === 1) continue;
      /* 侧落：时间越大 x 越大，音符从右往左逼近判定线 */
      var x = L.judgeX + (g.t - st) * L.pxs;
      if (x > xEnd) break;
      if (x < L.judgeX - 240) continue;

      /* 越靠近判定线越清晰，刚出场时淡入 */
      var a = (xEnd - x) / 110;
      a = a > 1 ? 1 : (a < 0 ? 0 : a);
      var missed = (g.st === 3);
      var y = groupY(g);

      /* 尾迹：只有 hold（按住）才有实心长条，短音不画 ——
         否则会和水平的音高地标线混在一起，读不出哪个是节奏、哪个是音高 */
      var tl = Math.min(groupDur(g) * L.pxs, 260);
      if (groupDur(g) >= 0.30 && tl >= 8) {
        ctx.globalAlpha = a * (missed ? 0.05 : 0.16);
        ctx.strokeStyle = '#fff';
        ctx.lineWidth = 3;
        ctx.beginPath();
        ctx.moveTo(x + 9, y);
        ctx.lineTo(x + 9 + tl, y);
        ctx.stroke();
      }

      /* 音符本体：无论几个音同时按下，都只画一个 */
      ctx.globalAlpha = a * (missed ? 0.3 : 1);
      ctx.strokeStyle = '#fff';
      ctx.fillStyle = '#fff';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(x, y, 9, 0, 6.2832);
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(x, y, 3.6, 0, 6.2832);
      ctx.fill();
    }
    ctx.globalAlpha = 1;
  }

  function drawJudgeLine(st, mode) {
    var jx = L.judgeX;

    /* 判定区是一条极淡的竖向光带：不画整条线（会挡住画面），
       但必须让人一眼知道判定发生在哪一列。 */
    var grad = ctx.createLinearGradient(jx - 26, 0, jx + 26, 0);
    grad.addColorStop(0, 'rgba(255,255,255,0)');
    grad.addColorStop(0.5, 'rgba(255,255,255,0.030)');
    grad.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = grad;
    ctx.fillRect(jx - 26, 0, 52, H);

    /* 节拍脉动：整条光带跟着拍子呼吸 */
    var ph = 0;
    if (G.beatDur > 0 && st > 0) {
      ph = (st / G.beatDur) % 1;
      if (ph < 0) ph += 1;
    }
    var pulse = Math.pow(1 - ph, 4);
    if (pulse > 0.5) {
      ctx.globalAlpha = (pulse - 0.5) * 0.14;
      ctx.fillStyle = '#fff';
      ctx.fillRect(jx - 1, 0, 2, H);
      ctx.globalAlpha = 1;
    }

    /* 判定线本体：只画「马上要有音符落下」的那几段。
       音符在别的 y 位置时，那条线根本不存在 —— 画面于是干净很多，
       而玩家要盯的位置也只有自己正在追的那几个音符。
       范围给到 0.42s、亮度给足，否则「一闪就没」会让人抓不住判定点。 */
    var gs = G.groups;
    var drawn = 0;
    for (var i = G.first; i < gs.length; i++) {
      var g = gs[i];
      if (g.st) continue;
      var x = jx + (g.t - st) * L.pxs;
      if (x < jx - 18) continue;
      if (x > jx + L.pxs * 0.42) break;

      var y = groupY(g);
      /* near: 1 = 正好在判定线上, 0 = 还有 0.42 秒才到 */
      var near = 1 - Math.min(1, Math.max(0, (g.t - st) / 0.42));
      var hold = groupDur(g) >= 0.30;
      var al = 0.42 + 0.55 * near;
      if (hold) {
        ctx.strokeStyle = 'rgba(93,202,165,' + al.toFixed(3) + ')';
      } else {
        ctx.strokeStyle = 'rgba(255,255,255,' + al.toFixed(3) + ')';
      }
      var half = 16 + near * 8;
      ctx.lineWidth = 2.0 + near * 1.6;
      ctx.beginPath();
      ctx.moveTo(jx, y - half);
      ctx.lineTo(jx, y + half);
      ctx.stroke();

      /* 两端的短横刻线，把这一小段「判定线」圈出来，避免和音符尾巴混淆 */
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(jx - 5, y - half); ctx.lineTo(jx + 5, y - half);
      ctx.moveTo(jx - 5, y + half); ctx.lineTo(jx + 5, y + half);
      ctx.stroke();
      drawn++;
    }

    /* 一段都没有（空档期）时留一个小刻点，判定位置不消失 */
    if (!drawn) {
      ctx.fillStyle = 'rgba(255,255,255,0.26)';
      ctx.fillRect(jx - 1, (L.top + L.bottom) / 2 - 8, 2, 16);
    }
  }

  function drawFx(st) {
    for (var i = G.fx.length - 1; i >= 0; i--) {
      var f = G.fx[i];
      var p = (st - f.t0) / f.life;
      if (p >= 1) { G.fx.splice(i, 1); continue; }
      if (p < 0) continue;
      var e = 1 - Math.pow(1 - p, 3);

      if (f.k === 'ring') {
        ctx.globalAlpha = (1 - p) * 0.9;
        ctx.strokeStyle = '#fff';
        ctx.lineWidth = f.w;
        ctx.beginPath();
        ctx.arc(f.x, f.y, f.r0 + (f.r1 - f.r0) * e, 0, 6.2832);
        ctx.stroke();
      } else if (f.k === 'sq') {
        var s = f.s0 + (f.s1 - f.s0) * e;
        ctx.save();
        ctx.translate(f.x, f.y);
        ctx.rotate(f.rot + e * 1.3);
        ctx.globalAlpha = (1 - p) * 0.8;
        ctx.strokeStyle = '#fff';
        ctx.lineWidth = 1.4;
        ctx.strokeRect(-s / 2, -s / 2, s, s);
        ctx.restore();
      } else if (f.k === 'shard') {
        var d = f.sp * e;
        ctx.globalAlpha = (1 - p) * 0.95;
        ctx.strokeStyle = '#fff';
        ctx.lineWidth = 1.6;
        ctx.beginPath();
        ctx.moveTo(f.x + Math.cos(f.a) * d, f.y + Math.sin(f.a) * d);
        ctx.lineTo(f.x + Math.cos(f.a) * (d + f.len), f.y + Math.sin(f.a) * (d + f.len));
        ctx.stroke();
      } else if (f.k === 'blade') {
        /* 水平光刃：从判定线向右拉出（音符逆着来向被劈开） */
        ctx.globalAlpha = (1 - p) * 0.85;
        ctx.strokeStyle = '#fff';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(f.x1, f.y);
        ctx.lineTo(f.x1 + f.x2 * e, f.y);
        ctx.stroke();
      } else if (f.k === 'xm') {
        var s2 = 6 + 9 * e;
        ctx.save();
        ctx.translate(f.x, f.y);
        ctx.globalAlpha = (1 - p) * 0.6;
        ctx.strokeStyle = '#9d9d9d';
        ctx.lineWidth = 1.4;
        ctx.beginPath();
        ctx.moveTo(-s2, -s2); ctx.lineTo(s2, s2);
        ctx.moveTo(s2, -s2); ctx.lineTo(-s2, s2);
        ctx.stroke();
        ctx.restore();
      }
    }
    ctx.globalAlpha = 1;
  }

  function setFont(weight, size, mono, spacing) {
    ctx.font = weight + ' ' + size + 'px ' + (mono ? MONO : SANS);
    ctx.letterSpacing = (spacing || 0) + 'px';
  }

  function drawHud(st) {
    var pad = L.padX;
    ctx.textBaseline = 'alphabetic';

    /* 进度 */
    var prog = clamp(st / Math.max(0.1, G.duration), 0, 1);
    ctx.fillStyle = 'rgba(255,255,255,0.09)';
    ctx.fillRect(0, 0, W, 2);
    ctx.fillStyle = 'rgba(255,255,255,0.85)';
    ctx.fillRect(0, 0, W * prog, 2);

    /* 左：曲名 */
    ctx.textAlign = 'left';
    ctx.fillStyle = 'rgba(255,255,255,0.32)';
    setFont(400, 9, true, 2);
    ctx.fillText(AUTO ? 'NOW PLAYING　·　AUTO' : 'NOW PLAYING', pad, 42);
    ctx.fillStyle = 'rgba(255,255,255,0.9)';
    setFont(500, 16, false, 1);
    ctx.fillText(G.song ? String(G.song.title).toUpperCase() : '', pad, 68);
    if (G.song && G.song.orig) {
      var tw = ctx.measureText(String(G.song.title).toUpperCase()).width;
      ctx.fillStyle = 'rgba(255,255,255,0.28)';
      setFont(400, 8, true, 2);
      ctx.fillText('ORIGINAL', pad + tw + 14, 68);
    }

    /* 右：分数 */
    ctx.textAlign = 'right';
    ctx.fillStyle = 'rgba(255,255,255,0.32)';
    setFont(400, 9, true, 2);
    ctx.fillText('SCORE', W - pad, 42);
    ctx.fillStyle = '#fff';
    setFont(300, 30, true, 1);
    ctx.fillText(padn(G.score, 7), W - pad, 74);

    /* 背景超大幽灵连击（压得很淡，只是氛围） */
    var cx = W * 0.54;
    var cy = (L.top + L.bottom) / 2;
    if (G.combo >= 3) {
      ctx.save();
      ctx.globalAlpha = 0.085;
      ctx.strokeStyle = '#fff';
      ctx.lineWidth = Math.max(1.5, Math.round(H * 0.0016));
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.font = '700 ' + Math.round(Math.min(H * 0.2, 170)) + 'px ' + MONO;
      ctx.strokeText(String(G.combo), cx, cy);
      ctx.restore();
    }

    /* 判定文字：贴在判定线左侧的空白区，视线不用离开判定点 */
    if (G.judge) {
      var jp = (st - G.judge.t0) / (G.judge.k === 1 ? 0.46 : 0.3);
      if (jp >= 0 && jp < 1) {
        var ja = jp < 0.08 ? jp / 0.08 : Math.pow(1 - (jp - 0.08) / 0.92, 1.6);
        var isP = G.judge.k === 1;
        ctx.save();
        ctx.globalAlpha = ja;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.translate(Math.max(58, L.judgeX - 58), H * 0.46);
        if (isP) {
          /* 爆开：从 1.35 收到 1.0，再轻微上浮 */
          var sp = 1.35 - 0.35 * Math.min(1, jp * 6);
          ctx.scale(sp, sp);
          ctx.translate(0, -jp * 5);
          ctx.fillStyle = '#ffffff';
          setFont(600, 17, true, 5);
          ctx.fillText('PERFECT', 0, 0);
          /* 误差数值，越小越亮 */
          var em = Math.round(Math.abs(G.judge.err) * 1000);
          ctx.globalAlpha = ja * (0.5 - Math.min(0.34, em / 180));
          ctx.fillStyle = '#ffffff';
          setFont(400, 9, true, 4);
          ctx.fillText((G.judge.err > 0 ? '+' : '-') + em, 0, 17);
        } else {
          var sg = 0.94 - jp * 0.06;
          ctx.scale(sg, sg);
          ctx.fillStyle = 'rgba(255,255,255,0.42)';
          setFont(400, 12, true, 5);
          ctx.fillText('GOOD', 0, 0);
        }
        ctx.restore();
        ctx.textBaseline = 'alphabetic';
      }
    }

    /* 底部：连击 / 准度 / 进度计数 */
    ctx.textAlign = 'left';
    ctx.textBaseline = 'alphabetic';
    var by = H - L.padY - 24;
    ctx.fillStyle = 'rgba(255,255,255,0.92)';
    setFont(400, 26, true, 1);
    ctx.fillText(String(G.combo), pad, by);
    ctx.fillStyle = 'rgba(255,255,255,0.34)';
    setFont(400, 9, true, 3);
    ctx.fillText('COMBO', pad, by + 18);

    var judged = G.perfect + G.good + G.miss;
    var acc = judged ? (G.perfect + G.good * 0.85) / judged * 100 : 100;
    ctx.textAlign = 'right';
    ctx.fillStyle = 'rgba(255,255,255,0.85)';
    setFont(400, 18, true, 1);
    ctx.fillText(acc.toFixed(2) + '%', W - pad, by - 4);
    ctx.fillStyle = 'rgba(255,255,255,0.32)';
    setFont(400, 9, true, 3);
    ctx.fillText('ACCURACY　' + judged + '/' + G.total, W - pad, by + 18);

    /* READY */
    if (st < 0.9) {
      var ra = 1 - clamp(st / 0.9, 0, 1);
      ctx.save();
      ctx.globalAlpha = ra;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillStyle = '#fff';
      setFont(400, 12, true, 7);
      ctx.fillText('READY', W * 0.5, cy);
      ctx.restore();
      ctx.textBaseline = 'alphabetic';
    }
    ctx.letterSpacing = '0px';
  }

  function drawGame(st) {
    bg();
    computeLayout();
    drawField(st);
    drawNotes(st);
    drawJudgeLine(st);
    drawFx(st);
    drawHud(st);
  }

  /* ------------------------------------------------------------------ 输入 */
  window.addEventListener('keydown', function (e) {
    var k = e.key;
    if (e.repeat) return;
    if (k === 'Tab' || k === 'F5' || k === 'F11' || k === 'F12') return;

    if (App.screen === 'splash') {
      e.preventDefault();
      enterHome();
      return;
    }
    if (App.screen === 'intro') {
      e.preventDefault();
      introEndsNow();
      return;
    }
    if (App.screen === 'title') {
      if (k === 'ArrowUp' || k === 'w' || k === 'W') {
        e.preventDefault(); homeSel = (homeSel + HOME_ITEMS.length - 1) % HOME_ITEMS.length; renderHome();
      } else if (k === 'ArrowDown' || k === 's' || k === 'S') {
        e.preventDefault(); homeSel = (homeSel + 1) % HOME_ITEMS.length; renderHome();
      } else if (k === 'Enter' || k === ' ') {
        e.preventDefault(); homeActivate();
      } else if (k === 'Escape') {
        e.preventDefault();
      }
      return;
    }
    if (App.screen === 'select') {
      if (k === 'ArrowUp' || k === 'w' || k === 'W') { e.preventDefault(); moveSel(-1); }
      else if (k === 'ArrowDown' || k === 's' || k === 'S') { e.preventDefault(); moveSel(1); }
      else if (k === 'Enter' || k === ' ') { e.preventDefault(); startSong(App.sel); }
      else if (k === 'r' || k === 'R') { e.preventDefault(); reloadSongs(); }
      else if (k === 'Escape' || k === 'Backspace') { e.preventDefault(); goTitle(); }
      return;
    }
    if (App.screen === 'play') {
      if (k === 'Escape') { e.preventDefault(); pauseGame(); return; }
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      e.preventDefault();
      press(e.timeStamp);
      return;
    }
    if (App.screen === 'pause') {
      if (k === 'Escape' || k === 'Enter') { e.preventDefault(); resumeGame(); }
      else if (k === 'o' || k === 'O') { e.preventDefault(); openSettings('pause'); }
      return;
    }
    if (App.screen === 'settings') {
      if (k === 'Escape' || k === 'Enter' || k === 'Backspace') { e.preventDefault(); closeSettings(); return; }
      if (k === 'ArrowUp' || k === 'w' || k === 'W') { e.preventDefault(); setRow = (setRow + SET_ROWS - 1) % SET_ROWS; renderSettings(); }
      else if (k === 'ArrowDown' || k === 's' || k === 'S') { e.preventDefault(); setRow = (setRow + 1) % SET_ROWS; renderSettings(); }
      else if (k === 'ArrowLeft' || k === 'a' || k === 'A') { e.preventDefault(); adjustSetting(setRow, -1); }
      else if (k === 'ArrowRight' || k === 'd' || k === 'D') { e.preventDefault(); adjustSetting(setRow, 1); }
      return;
    }
    if (App.screen === 'result') {
      if (k === 'r' || k === 'R') { e.preventDefault(); startSong(G.songIndex); }
      else if (k === 'Escape' || k === 'Enter') { e.preventDefault(); goSelect(); }
      return;
    }
  }, { passive: false });

  window.addEventListener('pointerdown', function (e) {
    if (App.screen === 'intro') {
      if (e.button !== undefined && e.button !== 0) return;
      e.preventDefault();
      introEndsNow();
      return;
    }
    if (App.screen !== 'play') return;
    if (e.button !== undefined && e.button !== 0) return;
    e.preventDefault();
    press(e.timeStamp || performance.now());
  }, { passive: false });

  /* 失焦自动暂停：切标签页、窗口最小化、点到别处 */
  document.addEventListener('visibilitychange', function () {
    if (document.hidden) autoPause();
  });
  window.addEventListener('blur', function () { autoPause(); });
  window.addEventListener('pagehide', function () { autoPause(); });

  /* 拖入 .mid 时提示正确做法（不再支持直接导入） */
  window.addEventListener('dragover', function (e) { e.preventDefault(); });
  window.addEventListener('drop', function (e) {
    e.preventDefault();
    toast('把 .mid 文件放进 midi/ 目录，再点「重新扫描」');
  });

  /* ------------------------------------------------------------------ 启动 */
  function loop() {
    requestAnimationFrame(loop);
    resize();
    var t = performance.now() / 1000;
    if (App.screen === 'intro') {
      drawIntro(t);
    } else if (App.screen === 'play' && G.active) {
      if (!G.paused) update();
      drawGame(songTime());
    } else if (App.screen === 'pause' && G.active) {
      drawGame(songTime());
    } else {
      drawIdle(t);
    }
  }

  function devScene(q) {
    if (q === 'splash') { goSplash(); return true; }
    if (q === 'home' || q === 'title') { goTitle(); return true; }
    if (q === 'select') { goSelect(); return true; }
    if (q === 'intro') {
      if (!App.songs.length) return false;
      var si = clamp(App.sel, 0, App.songs.length - 1);
      var hold = parseFloat(DEV.at || 0);
      playIntro(App.songs[si], function () {
        if (DEV.hold === '1') {          // 截图用：停在原地，不进入游玩
          intro.on = true;
          intro.cb = null;
          intro.song = App.songs[si];
          return;
        }
        G.paused = true;
        startSong(si, 0, true);
        G.paused = true;
      });
      if (hold > 0) intro.t0 = performance.now() - hold * INTRO_DUR * 1000;
      if (DEV.hold === '1') {
        /* 冻结进度：每帧都把 t0 顶回固定位置 */
        intro.hold = hold;
      }
      return true;
    }
    if (q === 'settings') { goSelect(); openSettings('select'); return true; }
    if (q === 'pause') { startSong(0); pauseGame(); return true; }
    if (q === 'play') {
      if (!App.songs.length) return false;
      startSong(clamp(App.sel, 0, App.songs.length - 1), parseFloat(DEV.t || 0) || 0);
      return true;
    }
    /* 定格到某一秒（截图用）：跳到该时刻后把时钟钉住，
       否则音频时钟会继续往前走，无头截图的 virtual-time 又会快进过去。 */
    if (q === 'frame') {
      if (!App.songs.length) return false;
      var at = Math.max(0, parseFloat(DEV.at || 0) || 0);
      startSong(clamp(App.sel, 0, App.songs.length - 1), at, true);
      /* 让这一帧的第一次绘制也落在这个时刻：直接把 t0 往前推 */
      if (Synth.ctx) G.t0 = Synth.ctx.currentTime - at;
      G.paused = true;
      return true;
    }
    if (q === 'result') {
      var s = App.songs[0];
      var all = DEV.all === '1';
      G.song = s || { title: 'BAD APPLE!!' };
      G.total = s ? s.taps : 848;
      G.perNote = 1000000 / G.total;
      G.perfect = all ? G.total : Math.round(G.total * 0.945);
      G.good = all ? 0 : Math.round(G.total * 0.04);
      G.miss = G.total - G.perfect - G.good;
      G.maxCombo = all ? G.total : Math.round(G.total * 0.62);
      G.score = all ? 1000000 : Math.round(G.perNote * (G.perfect + G.good * 0.85));
      G.duration = s ? s.duration : 215;
      G.songIndex = 0;
      G.autoRun = DEV.auto === '1';
      G.isNew = DEV.new === '1';
      G.best = (DEV.new === '1')
        ? { score: G.score, rank: rankOf(G.score) }
        : (s ? bestOf(s.id) : null);
      showResultScreen();
      return true;
    }
    return false;
  }

  var DEV = {};
  (function parseQuery() {
    var q = (location.search || '').replace(/^\?/, '');
    q.split('&').forEach(function (kv) {
      if (!kv) return;
      var a = kv.split('=');
      DEV[decodeURIComponent(a[0])] = decodeURIComponent(a[1] || '');
    });
    AUTO = DEV.auto === '1';
  })();

  function seedBest() {
    Best = {
      badapple: { score: 902345, rank: 'B', perfect: 724, good: 96, miss: 28, maxCombo: 311, acc: 93.4, ts: 0 },
      pupa: { score: 1000000, rank: 'λ', perfect: 792, good: 0, miss: 0, maxCombo: 792, acc: 100, ts: 0 }
    };
  }

  function boot() {
    loadSettings();
    loadBest();
    if (DEV.seed === '1') seedBest();
    resize();
    computeLayout();
    setScreen('splash');
    renderHome();
    loadSongs().then(function () {
      App.booted = true;
      if (DEV.sel) App.sel = clamp(parseInt(DEV.sel, 10) || 0, 0, Math.max(0, App.songs.length - 1));
      renderSongList();
      renderHome();
      if (DEV.scene && devScene(DEV.scene)) return;
    });

    $('splashHit').addEventListener('click', function () { enterHome(); });
    $('btnStart').addEventListener('click', function () {
      Synth.init(); Synth.resume(); goSelect();
    });
    $('btnHomeSettings').addEventListener('click', function () {
      Synth.init(); Synth.resume(); openSettings('title');
    });
    (function bindHomeHover() {
      var items = document.querySelectorAll('#homeMenu .hitem');
      for (var i = 0; i < items.length; i++) {
        (function (idx) {
          items[idx].addEventListener('mouseenter', function () { homeSel = idx; renderHome(); });
          items[idx].addEventListener('click', function () { homeSel = idx; renderHome(); });
        })(i);
      }
    })();

    $('btnBack').addEventListener('click', goTitle);
    $('btnSettings').addEventListener('click', function () { openSettings('select'); });
    $('btnSettingsPause').addEventListener('click', function () { openSettings('pause'); });
    $('btnReload').addEventListener('click', reloadSongs);
    $('btnResume').addEventListener('click', resumeGame);
    $('btnRestart').addEventListener('click', function () { G.paused = false; Synth.resume(); startSong(G.songIndex); });
    $('btnQuit').addEventListener('click', quitGame);

    window.addEventListener('resize', resize);
    window.addEventListener('orientationchange', resize);
    requestAnimationFrame(loop);
  }

  /* 供调试 / 自动化测试使用 */
  window.__MR = {
    G: G, App: App, L: L, S: S, SPEEDS: SPEEDS,
    press: press, startSong: startSong, update: update, finish: finish,
    songTime: songTime, setScreen: setScreen, computeLayout: computeLayout, drawGame: drawGame,
    yFor: yFor, groupY: groupY, pitchOf: pitchOf,
    openSettings: openSettings, closeSettings: closeSettings, introSkip: introSkip,
    drawNotes: drawNotes, saveSettings: saveSettings,
    loadSongs: loadSongs, reloadSongs: reloadSongs, makeSong: makeSong, buildBeats: buildBeats,
    loadBest: loadBest, getBest: function () { return Best; }, renderSongList: renderSongList,
    renderHome: renderHome,
    homeActivate: homeActivate, goTitle: goTitle, goSplash: goSplash, enterHome: enterHome,
    goSelect: goSelect,
    pauseGame: pauseGame, resumeGame: resumeGame, autoPause: autoPause,
    getHomeSel: function () { return homeSel; }, setHomeSel: function (i) { homeSel = i; renderHome(); },
    playIntro: playIntro, drawIntro: drawIntro, endIntro: endIntro,
    introProgress: introProgress, introEndsNow: introEndsNow,
    getIntro: function () { return intro; },
    INTRO_DUR: INTRO_DUR,
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();

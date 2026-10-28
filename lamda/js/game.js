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

  var APPROACH = 1.55;      // 音符可见时长（秒）
  var WIN_PERFECT = 0.060;  // ±60ms
  var WIN_GOOD = 0.100;     // ±100ms
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

  var L = { judgeX: 200, pxs: 600, top: 200, bot: 700, pMin: 40, pMax: 80, padX: 40 };
  function computeLayout() {
    L.padX = Math.max(18, W * 0.035);
    L.judgeX = Math.round(Math.max(88, W * 0.185));
    L.top = Math.round(H * 0.335);
    L.bot = Math.round(H * 0.795);
    L.pxs = (W - L.judgeX) / (APPROACH / speedFactor());
  }
  function yFor(p) {
    var span = Math.max(1, L.pMax - L.pMin);
    var t = (p - L.pMin) / span;
    return L.bot - 24 - t * (L.bot - L.top - 48);
  }
  /* 一组（同时按下的音）只显示成一个音符，取音高均值定位 */
  function groupY(g) {
    var s = 0;
    for (var i = 0; i < g.notes.length; i++) s += g.notes[i].pitch;
    return yFor(s / g.notes.length);
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
    if (hi - lo < 7) { var mid = (hi + lo) / 2; lo = mid - 3.5; hi = mid + 3.5; }
    L.pMin = lo - 0.5;
    L.pMax = hi + 0.5;

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
      addFx({
        k: 'shard', x: jx, y: y, life: strong ? 0.42 : 0.24,
        a: (j / cnt) * Math.PI * 2 + Math.random() * 0.4,
        sp: 120 + Math.random() * (strong ? 160 : 60),
        len: 7 + Math.random() * 11
      });
    }
    if (strong) addFx({ k: 'blade', x1: jx, x2: Math.max(70, W * 0.34), y: y, life: 0.28 });
  }

  function missFx(g) {
    addFx({ k: 'xm', x: L.judgeX, y: groupY(g), life: 0.5 });
  }

  function ghostFx() {
    addFx({ k: 'ring', x: L.judgeX, y: (L.top + L.bot) / 2, life: 0.22, r0: 3, r1: 20, w: 1 });
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
      if (g.t > st + WIN_GOOD) break;
      if (g.st) continue;
      var d = Math.abs(g.t - st);
      if (d <= WIN_GOOD && d < bd) { bd = d; best = i; }
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

  /* 判定线在 p 时刻的纵向位置（弧 -> 平线的过渡由这里统一决定） */
  function introLineY(p) {
    var flat = L.bot;
    var rise = easeOutCubic(seg(p, 0.34, 0.60));
    var arcLift = (1 - easeInOutCubic(seg(p, 0.52, 0.78))) * H * 0.085;
    return flat + (1 - rise) * H * 0.055 - arcLift;
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

    /* ② 横向扫描线：先在整屏流过，再被收拢到底部那条线上 */
    var scan = seg(p, 0.06, 0.46);
    var merge = easeInOutCubic(seg(p, 0.38, 0.56));
    var lineY = introLineY(p);
    var lineW = easeInOutCubic(seg(p, 0.44, 0.72));

    if (scan > 0) {
      var rows = 26;
      ctx.lineWidth = 1;
      for (var i = 0; i < rows; i++) {
        var f = i / (rows - 1);
        var base = H * (0.12 + f * 0.76);
        var y = base + (lineY - base) * merge;
        /* 每行自带一点相位漂移，形成风过的感觉 */
        var phase = ((t * 0.55 + i * 0.13) % 1);
        var half = (W * 0.5) * (0.28 + easeOutCubic(scan) * 0.98) * (1 - merge * 0.86);
        var a = (0.16 + 0.10 * Math.sin(i * 1.7)) * scan * (1 - merge * 0.45);
        ctx.strokeStyle = 'rgba(255,255,255,' + a.toFixed(3) + ')';
        ctx.beginPath();
        ctx.moveTo(cx - half, y);
        ctx.lineTo(cx + half, y);
        ctx.stroke();

        /* 线上滑过的亮点 */
        if (p < 0.52) {
          var px = cx - half + phase * half * 2;
          ctx.globalAlpha = Math.min(1, a * 6);
          ctx.fillStyle = '#fff';
          ctx.fillRect(px, y - 0.5, 26, 1.4);
          ctx.globalAlpha = 1;
        }
      }
    }

    /* 判定线本体：弧形 -> 压平 -> 向两侧铺满 */
    if (lineW > 0) {
      var x0 = cx - (W * 0.5) * lineW;
      var x1 = cx + (W * 0.5) * lineW;
      var bow = (1 - easeInOutCubic(seg(p, 0.52, 0.80))) * H * 0.055;
      var bright = seg(p, 0.48, 0.62);

      ctx.strokeStyle = 'rgba(255,255,255,' + (0.34 + bright * 0.5).toFixed(3) + ')';
      ctx.lineWidth = 1 + bright * 0.6;
      ctx.beginPath();
      var steps = 48;
      for (var k = 0; k <= steps; k++) {
        var u = k / steps;
        var xx = x0 + (x1 - x0) * u;
        var yy = lineY - Math.sin(u * Math.PI) * bow;
        if (k === 0) ctx.moveTo(xx, yy); else ctx.lineTo(xx, yy);
      }
      ctx.stroke();

      /* 判定点（对应游玩时的 judgeX），最后一刻闪一下 */
      var jp = seg(p, 0.56, 0.84);
      if (jp > 0) {
        var jx = L.judgeX * easeOutCubic(seg(p, 0.56, 0.70));
        /* 外扩的光环，用两圈拉出层次 */
        ctx.globalAlpha = jp * (1 - jp) * 1.6;
        ctx.strokeStyle = '#fff';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.arc(jx, lineY, 8 + (1 - jp) * 58, 0, 6.2832);
        ctx.stroke();
        ctx.globalAlpha = jp;
        ctx.beginPath();
        ctx.arc(jx, lineY, 4.5, 0, 6.2832);
        ctx.stroke();
        ctx.fillStyle = '#fff';
        ctx.fillRect(jx - 0.5, lineY - 11, 1, 22);
        ctx.globalAlpha = 1;
      }

      /* 音符：从上方落下，在判定点处汇成一束（呼应游玩时的判定节奏） */
      var np = seg(p, 0.46, 0.90);
      if (np > 0) {
        for (var n = 0; n < 7; n++) {
          var u3 = (n + 0.5) / 7;
          var prog = clamp(np * 1.6 - n * 0.072, 0, 1);
          if (prog <= 0) continue;
          /* 落下位置：从画面上部滑到判定线，起步更慢、尾段加速 */
          var ny = H * 0.16 + (lineY - H * 0.16) * (1 - Math.pow(1 - prog, 1.7));
          var nx = W * (0.10 + u3 * 0.80);
          var pull = easeOutCubic(seg(prog, 0.76, 1));
          nx = nx + (L.judgeX + 14 - nx) * pull * 0.92;
          var na = (1 - seg(prog, 0.90, 1)) * 0.8;
          if (na <= 0) continue;
          ctx.globalAlpha = na;
          ctx.fillStyle = '#fff';
          ctx.fillRect(nx - 3, ny - 1, 6, 2);
          ctx.globalAlpha = na * 0.3;
          ctx.fillRect(nx - 0.5, ny - 20, 1, 18);
          ctx.globalAlpha = 1;
        }
      }

      /* 节拍竖线：音符收拢后，从上方依次落下，把画面撑满 */
      var bp = seg(p, 0.74, 0.99);
      if (bp > 0) {
        var cols = 16;
        var bot = lineY;
        for (var c = 0; c < cols; c++) {
          var u2 = (c + 0.5) / cols;
          var bx = W * u2;
          var grow = easeOutCubic(clamp(bp * 1.8 - c * 0.038, 0, 1));
          var barA = (c % 4 === 0 ? 0.22 : 0.10);
          ctx.strokeStyle = 'rgba(255,255,255,' + barA.toFixed(3) + ')';
          ctx.lineWidth = 1;
          ctx.beginPath();
          ctx.moveTo(bx, bot - (bot + 40) * grow);
          ctx.lineTo(bx, bot);
          ctx.stroke();
        }
      }
    }

    /* 收尾：一道纵向光柱扫过，作为进入游玩的信号 */
    var flash = seg(p, 0.86, 1.0);
    if (flash > 0) {
      var fx = cx + (flash - 0.5) * W * 1.4;
      var g2 = ctx.createLinearGradient(fx - 90, 0, fx + 90, 0);
      g2.addColorStop(0, 'rgba(255,255,255,0)');
      g2.addColorStop(0.5, 'rgba(255,255,255,' + (Math.sin(flash * Math.PI) * 0.16).toFixed(3) + ')');
      g2.addColorStop(1, 'rgba(255,255,255,0)');
      ctx.fillStyle = g2;
      ctx.fillRect(fx - 90, 0, 180, H);
      /* 收尾时整体压暗，避免最后一帧跳变 */
      ctx.globalAlpha = seg(p, 0.92, 1.0) * 0.55;
      ctx.fillStyle = '#060606';
      ctx.fillRect(0, 0, W, H);
      ctx.globalAlpha = 1;
    }
  }

  function drawField(st) {    /* 点阵底纹 */
    ctx.globalAlpha = 0.045;
    ctx.fillStyle = '#fff';
    for (var x = L.padX; x < W; x += 46) {
      for (var y = L.top - 44; y < L.bot + 44; y += 46) ctx.fillRect(x, y, 1, 1);
    }
    ctx.globalAlpha = 1;

    /* 音高导引线 */
    var firstC = Math.ceil(L.pMin / 12) * 12;
    ctx.lineWidth = 1;
    for (var p = firstC; p <= L.pMax; p += 12) {
      var y = yFor(p);
      ctx.strokeStyle = 'rgba(255,255,255,0.055)';
      ctx.beginPath();
      ctx.moveTo(L.judgeX, y);
      ctx.lineTo(W, y);
      ctx.stroke();
    }

    /* 节拍线 */
    var beats = G.beats;
    for (var i = 0; i < beats.length; i++) {
      var b = beats[i];
      var bx = L.judgeX + (b.t - st) * L.pxs;
      if (bx < L.judgeX - 2) continue;
      if (bx > W + 2) break;
      ctx.strokeStyle = b.bar ? 'rgba(255,255,255,0.16)' : 'rgba(255,255,255,0.065)';
      ctx.lineWidth = b.bar ? 1.4 : 1;
      ctx.beginPath();
      ctx.moveTo(bx, L.top);
      ctx.lineTo(bx, L.bot);
      ctx.stroke();
    }
  }

  function drawNotes(st) {
    var gs = G.groups;
    ctx.lineCap = 'butt';
    for (var i = G.first; i < gs.length; i++) {
      var g = gs[i];
      if (g.st === 1) continue;
      var x = L.judgeX + (g.t - st) * L.pxs;
      if (x < -240) continue;
      if (x > W + 70) break;

      var a = (W - x) / 110;
      a = a > 1 ? 1 : (a < 0 ? 0 : a);
      var missed = (g.st === 3);
      var y = groupY(g);

      /* 尾迹 */
      var tl = Math.min(groupDur(g) * L.pxs, 240);
      if (tl >= 4) {
        ctx.globalAlpha = a * (missed ? 0.05 : 0.1);
        ctx.strokeStyle = '#fff';
        ctx.lineWidth = 2;
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
    var grad = ctx.createLinearGradient(jx - 22, 0, jx + 22, 0);
    grad.addColorStop(0, 'rgba(255,255,255,0)');
    grad.addColorStop(0.5, 'rgba(255,255,255,0.035)');
    grad.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = grad;
    ctx.fillRect(jx - 22, L.top, 44, L.bot - L.top);

    var ph = 0;
    if (G.beatDur > 0 && st > 0) {
      ph = (st / G.beatDur) % 1;
      if (ph < 0) ph += 1;
    }
    var pulse = Math.pow(1 - ph, 4);

    ctx.strokeStyle = 'rgba(255,255,255,' + (0.78 + 0.2 * pulse) + ')';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(jx, L.top - 18);
    ctx.lineTo(jx, L.bot + 18);
    ctx.stroke();

    ctx.fillStyle = '#fff';
    ctx.fillRect(jx - 9, L.top - 20, 18, 2);
    ctx.fillRect(jx - 9, L.bot + 18, 18, 2);

    if (pulse > 0.55) {
      ctx.globalAlpha = (pulse - 0.55) * 0.5;
      ctx.fillStyle = '#fff';
      ctx.fillRect(jx - 34, L.top - 26, 68, 1);
      ctx.fillRect(jx - 34, L.bot + 25, 68, 1);
      ctx.globalAlpha = 1;
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

    /* 中央幽灵连击 */
    var cx = (L.judgeX + W) / 2;
    var cy = (L.top + L.bot) / 2;
    if (G.combo >= 3) {
      ctx.save();
      ctx.globalAlpha = 0.105;
      ctx.strokeStyle = '#fff';
      ctx.lineWidth = Math.max(1.5, Math.round(H * 0.0016));
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.font = '700 ' + Math.round(Math.min(H * 0.2, 170)) + 'px ' + MONO;
      ctx.strokeText(String(G.combo), cx, cy);
      ctx.restore();
    }

    /* 判定文字：PERFECT 实心大字 + 误差毫秒，GOOD 明显更小更淡 */
    if (G.judge) {
      var jp = (st - G.judge.t0) / (G.judge.k === 1 ? 0.46 : 0.3);
      if (jp >= 0 && jp < 1) {
        var ja = jp < 0.08 ? jp / 0.08 : Math.pow(1 - (jp - 0.08) / 0.92, 1.6);
        var isP = G.judge.k === 1;
        ctx.save();
        ctx.globalAlpha = ja;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.translate(L.judgeX, L.top - 56);
        if (isP) {
          /* 爆开：从 1.35 收到 1.0，再轻微上浮 */
          var sp = 1.35 - 0.35 * Math.min(1, jp * 6);
          ctx.scale(sp, sp);
          ctx.translate(0, -jp * 5);
          ctx.fillStyle = '#ffffff';
          setFont(600, 19, true, 6);
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
    var by = L.bot + 58;
    ctx.fillStyle = 'rgba(255,255,255,0.92)';
    setFont(400, 26, true, 1);
    ctx.fillText(String(G.combo), L.judgeX - 26, by);
    ctx.fillStyle = 'rgba(255,255,255,0.34)';
    setFont(400, 9, true, 3);
    ctx.fillText('COMBO', L.judgeX - 26, by + 18);

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
      ctx.fillText('READY', (L.judgeX + W) / 2, cy);
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

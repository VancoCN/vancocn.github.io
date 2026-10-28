# LAMDA

> λ —— 单键 · 黑白 · 几何

一个基于 MIDI 的极简单键节奏游戏。双击 `index.html` 就能玩，不需要安装、不需要服务器，
整个文件夹丢到任何静态托管也能直接用。

- **玩家轨**：谱面里的 `player` 轨（MIDI 的第一条有音符的音轨），音符从右往左落到判定线；
  其余音轨自动演奏，只显示玩家轨的谱面。
- **声音**：没有音源文件，钢琴与鼓全部由 Web Audio 振荡器实时合成。
- **满分 1 000 000**，全 PERFECT 评级为 **λ**。
- **成绩自动存在本地**（localStorage），选曲界面直接显示每首的最佳分数与评级。
- 内置**自动游玩**，开启后全 PERFECT 演示，但**不写入成绩**。

## 开始

双击 **`index.html`**，任意键开始。首次进入需要一次按键/点击，浏览器才允许出声。

## 谱面是从哪来的

游戏**不解析 MIDI**，只加载已经转好的谱面：

```
song.mid  ──(tools/midi2chart.py)──▶  charts/<id>.js  ──▶  游戏
```

转换一次，之后加载极快，也不需要任何网络请求（`<script>` 能直接加载，`file://` 下也能用）。

### 加一首歌

```bash
python tools/midi2chart.py "F:/MSC乐谱/badapple!.mid" --title "Bad Apple!!" --artist "Touhou"
```

产物：

- `charts/badapple.js` —— 谱面（自注册到 `window.LAMBDA_CHART`）
- `charts/index.js` —— 曲目清单（自动重建）

把谱面文件放进 `charts/` 后，**双击 `更新谱面.bat`** 重建清单，刷新页面即可。
（`midi2chart.py` 每次运行都会自动重建清单，只有你手动拷贝谱面文件时才需要这个 bat。）

### 加曲绘

把图片放到 **`covers/<id>.jpg`**（`png` / `jpeg` / `webp` 也行），`id` 与谱面同名，例如
`charts/badapple.js` ↔ `covers/badapple.jpg`。转换时会自动识别并写进谱面；
已经转好的谱面也可以改天再补图，游戏会按 id 自己去 `covers/` 里找。

没有曲绘时不显示占位符，直接用曲名生成艺术字封面（按最长单词自动缩放，可多行堆叠，
下方标注曲师或 `ORIGINAL`）。有曲绘时统一灰度化以贴合黑白风格。

### 转换参数

| 参数 | 说明 |
| --- | --- |
| `--title` | 曲名（默认取文件名） |
| `--artist` | 作曲/来源，显示在曲名下方 |
| `--id` | 谱面 id（默认由标题生成，决定文件名与曲绘名） |
| `--player N` | 指定玩家音轨，从 0 开始；默认取第一条有音符的音轨 |
| `--reindex` | 只重建 `charts/index.js` |

## 操作

| 场合 | 操作 |
| --- | --- |
| 启动屏 | 点击 / 任意键 |
| 主界面 | `↑` `↓` 选择 · `ENTER` 确认 |
| 选曲（二级） | `↑` `↓` 选择 · `ENTER` 开始 · `R` 重新扫描 · `ESC` 返回主界面 |
| 游玩 | **任意键 / 鼠标 / 触屏** 判定 · `ESC` 暂停 |
| 暂停 | `ESC` 继续 · `O` 设置 |
| 结算 | `R` 重试 · `ESC` 返回选曲 |
| 设置 | `↑` `↓` 选择 · `←` `→` 调节 · `ESC` 返回 |

**界面结构**：启动屏（λ + LAMDA）→ 主界面（开始游戏 / 设置）→ 选曲 → 游玩 → 结算。
设置既可从主界面进入，也可从暂停菜单进入。

**失焦自动暂停**：游玩中切换标签页、最小化窗口或点到别处时自动暂停（无提示文字），回来后按 `ESC` 继续。

## 判定与计分

| 判定 | 误差 | 得分率 |
| --- | --- | --- |
| PERFECT | ±60 ms | 100% |
| GOOD | ±100 ms | 85% |
| MISS | 超过 ±100 ms 未击打 | 0 |

- 满分 **1 000 000**，平均分到每一个「可击打单位」。
- 同一时刻（28 ms 内）的音符算作**一个**击打单位：屏幕上只显示**一个**音符，按一次键，但所有这些音都会发声。
- 连击只统计命中，MISS 断连击。
- 评级：全 PERFECT = **λ**，≥990000 = `S`，≥950000 = `A`，≥900000 = `B`，≥800000 = `C`，其余 `D`。

## 设置

主界面「设置」、选曲界面左下角「设置」或暂停菜单「设置」均可进入，改动即时保存（localStorage）。

| 项 | 说明 |
| --- | --- |
| 流速 `SCROLL SPEED` | 0.60x ~ 2.00x 共 8 档，改变音符从右到左的滚动速度（默认 1.00x） |
| 打击发声 `AUDIO ON HIT` | ON 时玩家音轨的音符**只有击中才发声**（漏掉即静音），其余音轨始终自动演奏；OFF 时全部自动播放（默认 OFF） |
| 跳过前奏 `SKIP INTRO` | ON 时直接从玩家音轨**第一个音符的前两小节**开始，跳过开头的空白（默认 ON） |
| 自动游玩 `AUTO PLAY` | ON 时由游戏自动完成全部判定（满分演示），**本局成绩不记录**；左上角会显示 `NOW PLAYING · AUTO`（默认 OFF） |

## 成绩

每首歌的**历史最高分**存在 localStorage（键 `lamda.scores.v1`），内容：分数、评级、
PERFECT / GOOD / MISS、最大连击、准确率、时间戳。

- 只有**分数更高**才会覆盖。
- 结算界面：刷新记录时标 `NEW RECORD`，下方常驻显示 `BEST 0998765 λ`。
- 选曲界面：曲名下方显示 `LV.10　BEST 0998765`，右侧信息栏有 `BEST` / `RANK` 两行。
- **自动游玩不写入任何成绩**，结算界面明确标注 `AUTO PLAY · 成绩不记录`。
- 想清空记录：浏览器控制台执行 `localStorage.removeItem('lamda.scores.v1')` 后刷新。

## 目录

```
index.html              画面 / CSS / 各界面（双击即玩）
更新谱面.bat             重建 charts/index.js
charts/
  index.js              曲目清单（自动生成）
  badapple.js  pupa.js  谱面
covers/
  badapple.jpg  pupa.jpg 曲绘
js/game.js              谱面加载、判定、计分、渲染、界面流程
js/synth.js             Web Audio 合成器（钢琴 + 打击乐）
tools/midi2chart.py     .mid → charts/<id>.js
test/logic.test.js      jsdom 逻辑自测（130 项）
dev/                    开发辅助页面（截图 / 音频自检）
```

## 谱面格式

`charts/<id>.js` 是普通的 JS 对象，可以直接手改（改难度、调玩家轨、微调音符）：

```js
(window.LAMBDA_CHART = window.LAMBDA_CHART || {})["badapple"] = {
  v: 1, id: "badapple", title: "Bad Apple!!", artist: "Touhou",
  bpm: 138.0, duration: 215.635,
  player: 0,          // 玩家轨索引
  level: 10,
  taps: 848,          // 击打单位数（用于显示，游戏会重新统计）
  cover: "badapple.jpg",
  tempo: [[0.0, 0.434783]],          // [起始秒, 每拍秒]
  tracks: [{ name: "Piano", drum: false, gain: 1.0 }, ...],
  notes: [                            // 每个音轨一个数组
    [[t, dur, pitch, velocity], ...]
  ]
};
```

## 实现要点

- **谱面加载**：`<script src="charts/index.js">` 静态引入清单，其余谱面用动态 `<script>` 逐个注入；
  单个文件缺失只会被跳过并记录，不影响其它曲目。
- **时钟**：`AudioContext.currentTime` 是唯一主时钟，画面与判定都从它推导，因此音画同步不受渲染掉帧影响。判定时会扣除 `outputLatency`，补偿耳机的输出延迟。
- **调度**：每帧把未来 300 ms 内的音符排进 Web Audio 时间轴，精度由音频线程保证。
- **暂停**：直接 `suspend()` 音频上下文，时钟冻结，恢复后音乐从原处继续，无需重排。
- **谱面**：玩家轨的音符按 28 ms 窗口分组为「可击打单位」，一个单位只画一个音符（音高取组内均值定位），共用一次按键和一次计分。
- **设置**：流速换算成音符可见时长（`approach = 1.55s / 流速`）；打击发声模式下玩家音轨的音符不进入自动调度队列，改由命中时实时发声；跳过前奏按 `第一个音 - 8 拍` 计算并同步推进音频调度指针。
- **界面**：菜单为 DOM（便于排版），游玩画面为 Canvas 单画布重绘；打击特效全部由圆环、旋转方块、放射线段等几何图形构成。

## 自测

```bash
NODE_PATH="C:/Users/Van/.workbuddy/binaries/node/workspace/node_modules" \
  node test/logic.test.js
```

用 jsdom + 假音频时钟驱动真实的 `game.js`，覆盖：判定窗口边界（59/61/80/150 ms）、和弦单次计分、
满分 1 000 000、全 GOOD = 85%、全 MISS = 0、评级边界（含 λ）、三层界面导航、失焦自动暂停、
判定误差记录与偏移校准、GOOD 不传导到后续音符、
谱面解析与清单加载、设置项、一个音符只画一个圆、成绩写入与「只保留更高分」、自动游玩不写记录、
选曲界面回显最佳分。当前 194 项断言。

`dev/audio-check.html` 用 OfflineAudioContext 渲染合成器，检查是否真的出声、有无 NaN / 削波。

## 调试参数

- `?scene=home|select|settings|pause|play|result` 直接跳到某个界面
- `?sel=1` 选中第 N 首（选曲 / 游玩都用它）
- `?t=20` 从指定秒数开始（配合 `scene=play`）
- `?auto=1` 强制自动演奏 · `?all=1` 结算显示满分 · `?new=1` 结算标记新纪录
- `?seed=1` 注入两条示例成绩，用来看 BEST 的显示效果（只存在内存，不落盘）
